# Scope-Aware Read and Transport Optimization Plan

## Status

- Implemented in 2.1.0 and hardened in 2.1.1.
- Target package: `plugins/now-mcp`
- Compatibility constraint: do not add a new MCP tool.
- Existing calls remain backward compatible; new behavior is additive.
- Alternate-identity reads are never selected for an ordinary or unverified 403.

### Final implementation decision

The Phase 0 spike did **not** establish a trustworthy, general way to set an
arbitrary `sys_trigger` execution scope. A global/scheduled GlideRecord read can
therefore still return a successful false zero for `read_access=false` tables.
The proposed scoped privileged-read backend in Phases 3–4 was not shipped.

Instead, 2.1.1 uses the already aligned, read-only `now-sdk query` path for
`sn_query_records` recovery:

- independent network, authentication, server, and circuit-breaker failures may
  use the existing aligned now-sdk fallback;
- a 403 requires `allowNowSdkFallback:true` **and** a metadata profile proving
  `exists=true` and `ws_access=false`;
- `ws_access=true`, unknown metadata, and ordinary ACL failures never switch
  identity;
- responses name `transport: "now-sdk-query"` and the independent auth profile;
- aggregate reads have no alternate fallback because now-sdk does not preserve
  Stats API semantics.

The shipped transport hardening is separate from read fallback: background
scripts now report runtime scope when available, warn on potentially invisible
tables, bound and validate mailbox output, cancel pending triggers on failure or
timeout, and report timeout state as uncertain.

## Background

This plan is based on the AI Control Tower investigation captured in:

- `aict-trace-investigation-20260903-2012.log`
- `aict-trace-investigation-20260903-2012.raw.jsonl`

The transcript contained 89 now-mcp calls:

| Metric | Observed value |
| --- | ---: |
| Total now-mcp calls | 89 |
| `sn_execute_background_script` calls | 61 (68.5%) |
| Background-script mean reported duration | 31.0 seconds |
| Background-script median reported duration | 30.9 seconds |
| Background-script P95 reported duration | 46.4 seconds |
| Background-script maximum reported duration | 73.8 seconds |
| Cumulative reported background-script duration | Approximately 31.5 minutes |
| `mailbox_limit` truncations | 11 of 61 (18.0%) |
| Background transport failures | 0 |

The most important failure was not a transport error. It was a successful call with a
misleading result:

1. A global-scope background script queried
   `sn_ai_observe_scoring_provider` and returned zero rows.
2. Repeated background checks continued to report the table as empty.
3. `sn_query_records` later returned the real `traceloop` record through the Table API.
4. Inspection of `sys_db_object` showed `read_access=0` and `ws_access=1` for the table.
5. Global-scope GlideRecord therefore returned zero rows silently, even though
   `canRead()` and `isValid()` returned true.
6. The false-empty result caused an incorrect root-cause conclusion and an incorrect
   recommendation to create a provider record. Both had to be retracted.

This creates the following priority order:

1. Prevent semantically incorrect scope-limited reads.
2. Integrate explicit alternate-identity recovery into the existing query tool.
3. Make the `sys_trigger` transport fast, observable, and capable of returning bounded
   structured results without losing data.
4. Reduce discovery payload and schema-analysis noise.

## Design principles

The implementation follows these rules:

1. **No new MCP tool names.** Recovery is additive to `sn_query_records`.
2. **Backward-compatible defaults.** Existing calls continue to use the API-user path.
3. **No silent 403 identity change.** A request flag and confirmed table-wide REST block
   are both required.
4. **Host alignment is mandatory.** now-sdk must have a profile for the same instance URL.
5. **Scope uncertainty stays visible.** Background reads of `read_access=false` tables
   remain inconclusive unless the runtime reports the owning scope.
6. **One query output contract.** Table API and now-sdk return the same columnar records,
   pagination, warnings, and truncation shape.
7. **Aggregate semantics are not approximated.** Stats API failures remain failures.

## Target architecture

```text
             sn_query_records
                    |
                    v
          Existing validation/policy
                    |
                    v
           Table API (preferred)
                    |
          confirmed ws_access=false 403
          + allowNowSdkFallback=true
                    |
                    v
       host-aligned now-sdk query profile
                    |
                    v
      Existing columnar/render response contract
```

The routing stays internal to `TableService`; no new exposed tool or privileged script
backend is introduced.

## Phase 0: Validate ServiceNow scope execution — completed with a negative result

This spike is a prerequisite for claiming that privileged reads are scope-aware.

### Questions to answer

1. Does setting `sys_scope` when creating a `sys_trigger` cause its script to execute in
   that application scope?
2. Can that trigger read a table with `read_access=0` when its scope matches the table's
   owning application?
3. Does a configured Scripted REST endpoint execute in the endpoint's application scope?
4. Is one Scripted REST endpoint sufficient, or is an endpoint required per application
   scope?
5. What scope and identity can be observed reliably from inside each transport?

### Access matrix to verify

| `ws_access` | `read_access` | Expected route |
| --- | --- | --- |
| `true` | `true` | Table API |
| `true` | `false` | Table API; do not switch to a global script |
| `false` | `true` | Explicit aligned now-sdk read |
| `false` | `false` | Explicit aligned now-sdk read; never trust an unqualified background zero |

### Deliverables

- A non-production test table or safe existing fixture for each relevant access pattern.
- Recorded execution identity, execution scope, and row counts for both API and background
  transports.
- A short decision record selecting the supported scope mechanism.

### Exit criteria

- Owning-scope execution is demonstrated against a scope-restricted table.
- If owning-scope execution is not possible with `sys_trigger`, the initial implementation
  must restrict scoped privileged reads to a correctly scoped Scripted REST endpoint.
- No implementation may treat a global zero-row result as conclusive for a table with
  `read_access=0`.

## Phase 1: Prevent silent-zero correctness failures — shipped in 2.1.0

This phase can ship independently before privileged routing is complete.

### 1.1 Add a complete table access profile

Extend `SchemaService.checkWebServiceAccess()` into a broader internal API while retaining
the old method as a compatibility wrapper.

Suggested contract:

```ts
interface TableAccessProfile {
  exists: boolean;
  wsAccess?: boolean;
  readAccess?: boolean;
  owningScope?: {
    sysId: string;
    name: string;
  };
}
```

Implementation notes:

- Read `ws_access`, `read_access`, and `sys_scope` from `sys_db_object` in one request.
- Normalize ServiceNow boolean values centrally.
- Resolve both scope sys_id and API name where possible.
- Version the disk-cache key so older entries without the new fields are not reused.
- Return unknown fields as `undefined`; do not guess.
- Continue to treat access probing as advisory so it cannot hide the original error.

Likely files:

- `src/services/schema-service.ts`
- `test/schema-service.test.js`

### 1.2 Correct the Table API 403 recovery hint

The existing hint says that a background script is not gated by `ws_access`, but it does
not mention that global scope may be unable to read an application-scope-only table.

Required behavior:

- `ws_access=false`, `read_access=true`: suggest an explicitly authorized privileged read.
- `ws_access=false`, `read_access=false`: state that a global background script may return
  a false empty result and that owning-scope execution is required.
- `ws_access=true`: preserve the normal ACL/role diagnosis and do not recommend privileged
  fallback.
- Unknown access metadata: state that the safe transport cannot be determined.

Likely files:

- `src/utils/failure-enrichment.ts`
- `src/tools/query-records-tool.ts`
- `test/failure-enrichment.test.js`
- `test/query-records-tool.test.js`

### 1.3 Add background-script visibility warnings

Reuse `extractTableFieldRefs()` during the existing background-script preflight. For each
referenced table, attach a warning when the selected execution scope may not see all rows.

Suggested response fragment:

```json
{
  "visibilityWarnings": [
    {
      "table": "sn_ai_observe_scoring_provider",
      "reason": "Table is restricted to its application scope",
      "executionScope": "global",
      "emptyResultIsConclusive": false,
      "recommendedTransport": "table-api"
    }
  ]
}
```

Initially this should warn rather than block because arbitrary background scripts can
contain valid cross-scope logic that static analysis cannot fully understand.

Likely files:

- `src/tools/execute-background-script-tool.ts`
- `src/schemas/output-schemas.ts`
- `src/utils/script-analysis.ts`
- a new or existing execute-background-script tool test file

### Phase 1 acceptance criteria

- A global background script referencing a `read_access=false` table is marked as
  potentially incomplete.
- A Table API 403 no longer recommends a global background script without checking scope.
- Failed access-profile probes preserve the original error.
- Existing Table API and background-script behavior remains unchanged when no warning is
  applicable.

## Phase 2: Strengthen the `sys_trigger` transport — shipped in 2.1.0, hardened in 2.1.1

This phase creates the transport foundation required by bounded declarative privileged
reads.

### 2.1 Replace the 2.7 KB single-mailbox output with bounded chunks

The current wrapper stores only the first 2,700 characters in one `sys_properties.value`.
The tool-level output cap is higher, so the fallback transport loses data before the tool
can apply its own guardrail.

Suggested protocol:

```json
{
  "status": "done",
  "success": true,
  "chunkCount": 3,
  "outputOriginalChars": 7421,
  "outputReturnedChars": 7421
}
```

Requirements:

- Use a collision-resistant parent key plus indexed chunk keys.
- Set a hard maximum on total characters and chunk count.
- Reassemble chunks in index order.
- Detect missing, duplicate, or malformed chunks.
- Clean up the parent and every chunk on success, script failure, timeout, polling failure,
  and partial chunk failure.
- Preserve support for the existing single-mailbox response during migration.
- If chunk storage fails, return an explicit `chunk_write_failed` result rather than a
  generic script failure.
- Continue to apply the existing tool-level render cap after reassembly.

For privileged record reads, the backend should paginate when the bounded transport cap is
reached rather than attempting to return an arbitrarily large result in one execution.

### 2.2 Use adaptive polling

Replace the fixed 500 ms interval with a bounded backoff, for example:

```text
0-3 seconds:   500 ms
3-10 seconds:  1 second
10+ seconds:   2 seconds plus jitter
```

The exact schedule should be benchmarked against a real instance. It must reduce load
without making short jobs feel substantially slower.

### 2.3 Report useful transport timings

Keep `executionTime` for compatibility. Deprecate the current meaning of `queueDelayMs`,
which is presently the entire execution duration.

Add optional fields such as:

```json
{
  "totalDurationMs": 32088,
  "schedulerWaitMs": 28100,
  "scriptDurationMs": 480,
  "cleanupDurationMs": 620,
  "pollCount": 18
}
```

Timing boundaries must be documented. If scheduler wait cannot be measured precisely,
name it `observedSchedulerWaitMs` and state how it is derived.

### 2.4 Surface the recommended fast path

- Continue supporting Scripted REST as the preferred transport.
- Report a one-time performance hint after observing consistently slow `sys_trigger`
  execution.
- Add recent background latency summary to the existing `sn_connection_status` response.
- Do not install or switch to a Scripted REST endpoint automatically.

### Phase 2 tests

- Single and multi-chunk reconstruction.
- Missing and duplicate chunk handling.
- Cleanup after every completion and failure path.
- Timeout while chunks are partially written.
- Script failure with a chunked error body.
- Legacy single-mailbox compatibility.
- Adaptive poll count using an injected clock/sleeper.
- Timing-field output-schema validation.
- Render cap applied after chunk reconstruction.

### Phase 2 acceptance criteria

- Payloads that previously failed at 2.7 KB are returned completely up to the documented
  transport cap or are explicitly paginated.
- Polling requests are reduced by at least 60% in the representative scheduler-latency
  benchmark.
- P95 completion detection adds no more than two seconds compared with fixed polling.
- No temporary parent or chunk properties remain after tested success and failure paths.

## Phase 3: Add privileged reads to `sn_query_records` — superseded

This original design is retained below as decision history. It was superseded by
the explicit, aligned now-sdk fallback described in the status section because
owning-scope `sys_trigger` execution could not be proven. The shipped input is
`allowNowSdkFallback`, defaults to false, and does not add an instance-level
privileged execution capability.

### 3.1 Extend the existing input schema

Add one backward-compatible field:

```ts
privilegedRead: z.boolean().optional().default(false)
```

Add a separate instance-level capability:

```yaml
allowPrivilegedReads: false
```

The privileged backend may run only when both are true:

```text
request.privilegedRead == true
AND
instance.allowPrivilegedReads == true
```

Do not reuse `readOnly: false` as the authorization switch. Logical read privileges and
general mutation privileges should remain separate capabilities even if the `sys_trigger`
control plane requires temporary mailbox writes.

Likely files:

- `src/schemas/table-schemas.ts`
- instance configuration schema and types
- configuration examples and README

### 3.2 Route only after the normal API path is evaluated

Expected flow:

```text
Validate query, fields, and payload risk
  |
  v
Try the normal Table API
  |
  +-- success --> return normally
  |
  +-- non-403 failure --> return the original failure
  |
  +-- 403
        |
        +-- ws_access=true --> return ACL/role failure
        |
        +-- access unknown --> return failure with uncertainty
        |
        +-- ws_access=false
              |
              +-- privilegedRead=false --> return 403 with opt-in hint
              |
              +-- privilegedRead=true and config disabled --> refuse
              |
              +-- privilegedRead=true and config enabled
                    --> use owning-scope privileged backend
```

Even when `privilegedRead=true`, the normal API path remains preferred when it works. This
preserves API-user ACL semantics and minimizes privilege use.

### 3.3 Generate the server-side read declaratively

The internal backend should accept validated query parameters, not caller-provided code.
It must support:

- encoded query
- selected fields
- `limit`
- `offset`, using a bounded window
- actual and display values
- dot-walked fields where ServiceNow supports them
- deterministic column ordering
- total matching count or a clearly documented `null`
- per-field character caps
- pagination metadata

Existing checks must run before transport selection:

- table allow/block policy
- safe/expensive query policy
- field validation
- payload-cost policy
- journal-field warning

Use `GlideRecordSecure` in the generated read path and report the effective identity. The
feature is privileged because the scheduled identity and application scope can still see
more than the API user; the name must not imply an ACL bypass guarantee.

### 3.4 Preserve the existing output contract

Continue returning the existing columnar shape and pagination. Add optional context:

```json
{
  "transport": "sys-trigger-scoped",
  "privilegedReadUsed": true,
  "accessContext": {
    "apiIdentityAttempted": true,
    "effectiveUser": "system",
    "executionScope": "sn_ai_observe",
    "owningScope": "sn_ai_observe"
  }
}
```

Additional rules:

- If owning scope cannot be established, return an error. Do not retry in global scope.
- If the privileged backend reaches its page/output limit, set `pagination.hasMore=true`
  and return a usable next offset.
- If `expand` was requested, the first implementation may translate it to dot-walked
  fields and return a warning rather than pretending it used GraphQL or returning a
  different nested contract silently.
- `skipFieldValidation` must not bypass access or scope checks.

### Phase 3 tests

- Default requests never invoke the privileged backend.
- `privilegedRead=true` plus disabled instance capability is refused.
- A successful Table API call never escalates even when privileged read is allowed.
- A normal ACL 403 with `ws_access=true` never escalates.
- A `ws_access=false` 403 can route only with double opt-in.
- A scope-restricted table uses its owning scope.
- Unknown scope fails safely.
- Query, fields, offset, limit, display values, dot-walks, and pagination match the normal
  tool contract.
- Effective identity and execution scope are present whenever privileged access was used.

## Phase 4: Add privileged reads to `sn_aggregate_records` — not implemented

This phase remains intentionally out of scope. now-sdk query does not implement
the Stats API's aggregate semantics, and silently approximating them would make
the alternate path less trustworthy than the failing request.

Add the same `privilegedRead` field and reuse the internal Read Transport Router.

The scoped backend should generate a bounded `GlideAggregate` operation supporting:

- count
- query filters
- group by
- average, sum, minimum, and maximum
- display values for grouped references where reliable
- `topGroups`

The implementation must not silently approximate Stats API behavior. If the privileged
backend cannot preserve a parameter's semantics, such as a particular `having` or
aggregate ordering expression, return an explicit unsupported-combination error for that
privileged call.

Apply the existing high-cardinality and render protections before and after routing.

### Phase 4 acceptance criteria

- Default aggregate behavior is unchanged.
- Double opt-in and access routing match `sn_query_records`.
- Supported aggregate results match the Stats API on a table available to both paths.
- Unsupported semantics fail explicitly.
- Privileged results report identity, scope, transport, and timing.

## Phase 5: Improve discovery and response economy — shipped in 2.1.1

### 5.1 Rank and paginate `sn_list_tables`

Improve the existing tool rather than adding another discovery tool.

Ranking signals, in order:

1. Exact table-name match.
2. Exact label match.
3. Name or label prefix match.
4. Scoped/core table relevance.
5. Base table before import, mapping, history, and satellite tables.
6. General substring match.

Add:

- `offset`
- `totalMatching` when it can be obtained economically
- `hasMore`
- deterministic relevance score/order
- a hint when the requested limit produces an incomplete shortlist

Do not lower the current default limit in a patch release. A lower default can be
considered in the next major version after usage data is reviewed.

### 5.2 Rank and group `sn_find_fields`

- Apply exact/prefix/substring ranking to both labels and names.
- Group or de-emphasize repetitive inherited/platform fields.
- Return a small table/scope distribution when the result set is broad.
- Add pagination rather than encouraging `limit=200` census-style calls.

### 5.3 Compact `sn_connection_status`

The tool already accepts an instance filter, so no new tool or input concept is needed.

- Return common transport configuration once instead of repeating the same diagnostic for
  every instance.
- Keep per-instance breaker and authentication differences in the instance rows.
- Add recent background-script latency and transport health when available.
- Preserve the current all-instance behavior for compatibility; reconsider default-instance
  behavior only in a major release.

### Phase 5 acceptance criteria

- Exact and prefix matches consistently appear before incidental substring matches.
- Broad searches clearly signal that more matches exist.
- Typical discovery calls return materially less payload without hiding pagination.
- Connection status exposes a shared diagnostic map while retaining the per-instance
  diagnostic required by the 2.x output contract.

## Phase 6: Reduce schema-preflight false positives — shipped in 2.1.0/2.1.1

The background-script analyzer currently treats feature checks such as
`gr.getFields ? ...` and `gr.getElements ? ...` as potential fields because these API
members are absent from its denylist.

Changes:

- Add `getFields` and `getElements` to the GlideRecord API-member set.
- Handle property-style method availability checks explicitly.
- Attach a confidence level to schema findings when appropriate.
- Preserve detection of genuinely unknown fields such as a nonexistent
  `model_categories` column.

### Phase 6 acceptance criteria

- `getFields` and `getElements` no longer appear as unknown table fields.
- Existing real-field typo tests continue to pass.
- Dynamic and unresolved references remain advisory rather than blocking.

## Original proposed pull-request sequence

| PR | Scope | Relative risk | Dependency |
| --- | --- | --- | --- |
| PR 1 | Access profile, corrected 403 hints, visibility warnings | Low | Phase 0 findings inform wording |
| PR 2 | Chunked mailbox, cleanup, adaptive polling, timing | Medium-high | None after protocol design |
| PR 3 | `sn_query_records.privilegedRead` and internal router | High | Phase 0, PR 1, PR 2 |
| PR 4 | `sn_aggregate_records.privilegedRead` | Medium | PR 3 |
| PR 5 | Discovery ranking, pagination, compact status | Medium-low | Independent |
| PR 6 | Schema-analyzer cleanup and documentation | Low | Independent |

PR 1 should be released first because it prevents another false-empty diagnosis even if
the complete privileged-read path takes longer. PR 3 must not ship before owning-scope
execution and output transport are proven.

## Live verification matrix

Run these tests only against a non-production instance or approved safe fixtures.

1. **Table API preferred:** `ws_access=true`, `read_access=false`; the tool reads through
   the Table API and does not escalate.
2. **Explicit alternate fallback:** `ws_access=false`; the default call returns 403 and
   `allowNowSdkFallback=true` succeeds only with a host-aligned profile.
3. **Owning-scope warning:** `read_access=false`; a background zero remains inconclusive
   unless the reported runtime scope equals the owning scope.
4. **Output reconstruction:** a result larger than 2.7 KB is reconstructed exactly up to
   the documented cap.
5. **Discovery pagination:** ranked table/field pages continue through stable offsets with
   no duplicated or skipped rows.
6. **403 gate:** `ws_access=true` and unknown metadata never invoke now-sdk fallback.
7. **Identity disclosure:** every alternate response names the now-sdk profile and source.
8. **Aggregate integrity:** aggregate failures never route to an approximate backend.
9. **Transport load:** adaptive polling meets the request-reduction target.
10. **Cleanup:** no temporary parent, chunk, or trigger records remain after success,
    failure, and timeout tests.

## Unit and integration test coverage

At minimum, update or add coverage in:

- `test/schema-service.test.js`
- `test/failure-enrichment.test.js`
- `test/query-records-tool.test.js`
- aggregate-records tool tests
- `test/script-service.test.js`
- `test/payload-truncation.test.js`
- script-analysis tests
- connection-status and table-discovery tests

Every PR must pass:

```bash
pnpm test
pnpm check
```

Transport and scope PRs additionally require the non-production live verification matrix.

## Shipped rollout behavior

1. Access warnings and corrected 403 hints ship for every caller.
2. Transport hardening changes no configured execution route.
3. `allowNowSdkFallback` defaults to false and is evaluated per request.
4. The fallback requires an aligned host and reports the actual profile every time.
5. There is no background-script privileged-read capability to enable in configuration.

Recommended operational counters:

- normal read attempts
- explicit now-sdk fallback requests
- now-sdk fallback routes actually used
- 403 fallbacks refused because access metadata was unknown or `ws_access=true`
- access-profile lookup failures
- scope-resolution failures
- background silent-zero warnings
- mailbox chunks written/read/cleaned
- orphan cleanup failures
- polling count and scheduler latency
- result truncations and paginated continuations

## Security considerations

- The now-sdk profile may see more records than the API user. Every successful fallback
  names that independent source and profile.
- `allowNowSdkFallback=true` is insufficient for a 403 without metadata-confirmed
  `ws_access=false` and a host-aligned now-sdk profile.
- Table blocklists, query-risk checks, field validation, and output caps run before the
  declarative now-sdk query and remain active.
- Read-only logical operations may require temporary control-plane writes for the mailbox.
  These must be isolated from general mutation authorization and fully cleaned up.
- Tool logs must not record credentials or full sensitive payloads. Client-side conversation
  exports require their own secret-redaction policy because now-mcp cannot sanitize user
  messages captured by the host.

## Non-goals

- Adding a new MCP tool for privileged or scoped reads.
- Automatically changing `sys_db_object.ws_access` or application access settings.
- Silently bypassing ACL or role failures when `ws_access=true`.
- Automatically installing a Scripted REST endpoint.
- Making arbitrary background scripts safe through static analysis alone.
- Guaranteeing that every ServiceNow encoded-query or aggregate feature can be represented
  in the first privileged backend release.

## Definition of done

The program is complete when all of the following are true:

- No new MCP tool name has been introduced.
- Existing query and aggregate requests behave as before by default.
- A scope-restricted background read cannot return an unqualified silent-zero result.
- An alternate-identity 403 fallback requires explicit request authorization plus a
  metadata-confirmed table-wide REST block.
- The now-sdk source and profile are reported for every successful alternate read.
- Table API remains preferred whenever it succeeds.
- Normal ACL failures with `ws_access=true` never trigger privileged fallback.
- Results larger than 2.7 KB are reconstructed or reliably paginated.
- Polling request count is reduced by at least 60% in the representative benchmark.
- Timing fields distinguish total duration, scheduler wait, script runtime, cleanup, and
  poll count.
- Discovery results are ranked and expose pagination/incompleteness.
- `getFields` and `getElements` no longer produce schema-preflight false positives.
- Unit tests and static checks pass; live claims remain limited to the recorded spike.
- Alternate-identity 403 fallback remains disabled by default.

## Completion note

The original sizing assumed a new scoped execution backend. That backend was
cancelled after the negative Phase 0 result. The delivered scope consists of
correctness warnings, explicit aligned now-sdk recovery, bounded background
transport, stable discovery ranking/pagination, cache identity isolation, tests,
and documentation.
