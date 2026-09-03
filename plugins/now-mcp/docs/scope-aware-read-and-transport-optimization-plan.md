# Scope-Aware Read and Transport Optimization Plan

## Status

- Proposal only; no implementation has been started.
- Target package: `plugins/now-mcp`
- Compatibility constraint: do not add a new MCP tool.
- Existing calls must remain backward compatible.
- Privileged reads must never be selected silently.

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
2. Integrate explicit privileged reads into existing read tools.
3. Make the `sys_trigger` transport fast, observable, and capable of returning bounded
   structured results without losing data.
4. Reduce discovery payload and schema-analysis noise.

## Design principles

The implementation must follow these rules:

1. **No new MCP tool names.** Scope-aware reads are added to
   `sn_query_records` and `sn_aggregate_records`.
2. **Backward-compatible defaults.** Existing calls continue to use the current API-user
   execution path.
3. **No silent identity change.** A Table API failure must not silently retry as
   `system` or another scheduled-job identity.
4. **Double opt-in for privileged reads.** The caller and instance configuration must
   both authorize the privileged path.
5. **Scope must be proven.** When owning-scope execution cannot be established, the tool
   must fail or warn rather than execute in global scope and return a potentially false
   empty result.
6. **One output contract.** Table API and privileged backends should return the existing
   columnar records, pagination, aggregate, warning, and truncation shapes.
7. **Declarative privileged reads only.** The read tools generate bounded server-side
   operations internally; callers do not provide JavaScript.

## Target architecture

```text
sn_query_records / sn_aggregate_records
                    |
                    v
          Read Transport Router
                    |
          +---------+---------+
          |                   |
          v                   v
   Table/Stats API      Scoped Read Backend
   API-user identity    Explicit privileged identity
          |                   |
          +---------+---------+
                    |
                    v
    Existing validation, pagination, columnar output,
          render caps, hints, and response schemas
```

The router should be an internal service, not an exposed MCP tool. A possible location is
`src/services/read-transport-service.ts`.

## Phase 0: Validate ServiceNow scope execution

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
| `false` | `true` | Explicit privileged background read |
| `false` | `false` | Owning-scope background read; reject if scope cannot be established |

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

## Phase 1: Prevent silent-zero correctness failures

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

## Phase 2: Strengthen the `sys_trigger` transport

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

## Phase 3: Add privileged reads to `sn_query_records`

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

## Phase 4: Add privileged reads to `sn_aggregate_records`

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

## Phase 5: Improve discovery and response economy

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
- Connection status no longer repeats identical diagnostic paragraphs per instance.

## Phase 6: Reduce schema-preflight false positives

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

## Proposed pull-request sequence

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
2. **Explicit privileged fallback:** `ws_access=false`, `read_access=true`; the default
   call returns 403 and the double-opt-in call succeeds.
3. **Owning-scope requirement:** `ws_access=false`, `read_access=false`; owning-scope
   execution succeeds, while global execution is rejected or marked inconclusive.
4. **Output reconstruction:** a result larger than 2.7 KB is reconstructed exactly up to
   the documented cap.
5. **Pagination:** a privileged page that exceeds the cap returns a stable next offset and
   no duplicated or skipped rows.
6. **Configuration gate:** `privilegedRead=true` is refused when the instance capability is
   disabled.
7. **Identity disclosure:** every privileged response includes effective identity,
   execution scope, and transport.
8. **Semantic parity:** supported query and aggregate operations match the corresponding
   Table/Stats API results on tables visible through both paths.
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

## Rollout strategy

1. Ship access warnings and corrected hints first.
2. Ship transport improvements without enabling privileged reads.
3. Release the input field and instance configuration with
   `allowPrivilegedReads=false` everywhere.
4. Enable it on one non-production instance and observe identity, scope, latency,
   truncation, cleanup, and error metrics.
5. Expand to additional non-production instances only after semantic parity is confirmed.
6. Require an explicit production configuration change and security review before enabling
   privileged reads in production.

Recommended operational counters:

- normal read attempts
- privileged read requests
- privileged routes actually used
- privileged requests refused by configuration
- access-profile lookup failures
- scope-resolution failures
- background silent-zero warnings
- mailbox chunks written/read/cleaned
- orphan cleanup failures
- polling count and scheduler latency
- result truncations and paginated continuations

## Security considerations

- A scheduled-job identity may see more records than the API user. The response must make
  this visible every time privileged routing is used.
- `privilegedRead=true` is not sufficient without the instance-level capability.
- The privileged backend accepts declarative operations only; it must not expose caller
  JavaScript through the existing read tools.
- Table blocklists, query-risk checks, field validation, and output caps remain active.
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
- Privileged routing requires both request-level and instance-level authorization.
- Owning scope and effective identity are reported for every privileged response.
- Table API remains preferred whenever it succeeds.
- Normal ACL failures with `ws_access=true` never trigger privileged fallback.
- Results larger than 2.7 KB are reconstructed or reliably paginated.
- Polling request count is reduced by at least 60% in the representative benchmark.
- Timing fields distinguish total duration, scheduler wait, script runtime, cleanup, and
  poll count.
- Discovery results are ranked and expose pagination/incompleteness.
- `getFields` and `getElements` no longer produce schema-preflight false positives.
- Unit tests, static checks, and the non-production live verification matrix pass.
- Privileged reads remain disabled by default in shipped configuration.

## Rough sizing

The largest uncertainty is whether `sys_trigger` can reliably execute in the owning
application scope. Subject to the Phase 0 result, the complete program is approximately
five to six independently reviewable pull requests and roughly two to three engineer-weeks
of implementation, tests, live validation, and documentation.
