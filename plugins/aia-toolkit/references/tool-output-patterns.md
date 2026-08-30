# Tool output patterns

Tool return values are what the agent's LLM sees on the next turn. The shape of that return value directly shapes how the LLM composes the user-facing response. Get the shape wrong and the LLM either fabricates fields, passes wrong arguments to the next tool, or fires the Step 8 error path on benign branches.

This doc defines the four canonical output shapes the `sn-aia-agent-builder` skill emits and the rules for picking one. **Each pattern has a paired executable template** at `scripts/tool-scripts/*.template.js` — copy from the template, not from the markdown excerpt below. The excerpts are for explaining the *why*; the `.js` files are the source of truth that gets linted and updated.

| Pattern | Template file | Use case |
|---|---|---|
| 1. REST + envelope unwrap | `scripts/tool-scripts/rest-tool.template.js` | External API call with `{success, data, error}` envelope |
| 2. CRUD single-row flat | (use Pattern 3 template with `setLimit(1)` + flat-return tweak) | Lookup that returns ≤ 1 row |
| 3. CRUD multi-row | `scripts/tool-scripts/crud-tool.template.js` | Search returning 0..N rows |
| 4. State-mutating soft-fail | `scripts/tool-scripts/action-tool.template.js` | Write to record (case work-note, handoff, ticket update) |

> **Companion read**: `sn-aia-agent-builder/SKILL.md → Runtime contract for tool scripts` for the IIFE wrapper + Rhino constraints. The patterns below assume you're already writing plain JS IIFEs.

---

## Pattern 1 — REST tool with envelope unwrap

**When to use**: tool calls an external API that wraps responses in `{success, data, error}` (Apidog, many vendor APIs).

**Rationale**: the LLM should see flat fields (`customer_id`, `plan_name`) — not have to navigate `.data.customer_id`. Wrapping bytes-of-success around every tool result also dilutes the few-shot examples in the agent's instructions.

```js
(function(inputs) {
    // ... build request, call API, get response body ...

    if (status >= 400) {
        return { __error_code: 'HTTP_' + status, __error_message: 'API_ERROR_' + status, __raw_body: body };
    }
    var parsed;
    try { parsed = JSON.parse(body); }
    catch (e) { return { __error_code: 'PARSE_ERROR', __error_message: 'Failed to parse', __raw_body: body }; }

    // Envelope unwrap: flatten {success, data, error} into either flat data OR an __error_code object
    if (parsed && typeof parsed === 'object' && 'success' in parsed) {
        if (parsed.success === true) return parsed.data === undefined || parsed.data === null ? {} : parsed.data;
        if (parsed.success === false && parsed.error) {
            return { __error_code: parsed.error.code || 'UNKNOWN_ERROR', __error_message: parsed.error.message || '' };
        }
    }
    return parsed;
})(inputs);
```

**What the LLM sees:**

```jsonc
// Happy path — flat fields, no envelope
{ "exists": true, "customer_id": "CUS-001", "customer_name": "Hong Gil-dong", "masked_phone": "010-****-5678" }

// API-level failure — __error_code triggers Step 8
{ "__error_code": "CUSTOMER_NOT_FOUND", "__error_message": "Customer information not found." }

// Transport failure — also routes to Step 8
{ "__error_code": "HTTP_503", "__error_message": "API_ERROR_503", "__raw_body": "..." }
```

**Not when**: API doesn't use a `{success, data, error}` envelope. Pass `parsed` through as-is.

---

## Pattern 2 — Single-row CRUD lookup (flat output)

**When to use**: CRUD tool with `setLimit(1)` (or a query that semantically returns at most one row — e.g. lookup by sys_id, lookup by unique name).

**Rationale**: the LLM tends to pass the entire return value as a parameter to the next tool. Returning `{count:1, records:[{sys_id:"abc", ...}]}` causes it to pass the wrapper object as `connectionSysId`. Flat single-row output — `{sys_id:"abc", ...}` — is unambiguous.

```js
(function(inputs) {
    var crudInputs = inputs.crudInputs;
    var allInputs = inputs;
    var query = (crudInputs.query || '').replace(/\{\{([^}]+)\}\}/g, function(_m, key) {
        var v = allInputs[key.trim()];
        return v === undefined || v === null ? '' : String(v);
    });

    var gr = new GlideRecordSecure(crudInputs.table.value);
    gr.addEncodedQuery(query);
    gr.setLimit(1);
    if (crudInputs.orderBy) {
        if (crudInputs.sortType === 'z_to_a') gr.orderByDesc(crudInputs.orderBy);
        else gr.orderBy(crudInputs.orderBy);
    }
    gr.query();

    if (!gr.next() || !gr.canRead()) {
        return { __error_code: 'NOT_FOUND', __error_message: 'No row matched: ' + query };
    }
    var row = {};
    for (var i = 0; i < crudInputs.returnFields.length; i++) {
        var f = crudInputs.returnFields[i];
        row[f.id] = gr.getValue(f.id) || '';
    }
    return row;
})(inputs);
```

**What the LLM sees:**

```jsonc
// Found
{ "sys_id": "68151dde9370c314e0a2f070ed03d676", "name": "Apidog Billing Mock Connection", "connection_url": "https://..." }

// Not found
{ "__error_code": "NOT_FOUND", "__error_message": "No row matched: nameLIKEApidog Billing Mock" }
```

**Not when**: multiple results are semantically meaningful (search). Use Pattern 3.

---

## Pattern 3 — Multi-row CRUD search (count + records wrapper)

**When to use**: search that legitimately returns 0..N rows where N > 1 matters to the LLM's reasoning.

```js
(function(inputs) {
    // ... build query, run GlideRecordSecure ...
    var records = [];
    while (gr.next()) {
        if (!gr.canRead()) continue;
        var row = {};
        for (var i = 0; i < crudInputs.returnFields.length; i++) {
            var f = crudInputs.returnFields[i];
            row[f.id] = gr.getValue(f.id) || '';
        }
        records.push(row);
    }
    return { count: records.length, records: records };
})(inputs);
```

**What the LLM sees:**

```jsonc
{
  "count": 3,
  "columns": ["sys_id", "number", "short_description"],
  "rows": [
    ["...", "KB0001234", "..."],
    ["...", "KB0001235", "..."],
    ["...", "KB0001236", "..."]
  ]
}
```

Instructions should explicitly tell the LLM that `rows[i]` pairs positionally against `columns` (not as `{records:[{...}]}`), and to use each row's fields rather than pass the wrapper to another tool. This is the same convention now-mcp's own read tools use — see `mcp-capability-resolution.md`.

---

## Pattern 4 — State-mutating action tool (soft-fail on missing context)

**When to use**: tool writes to a record on the instance — case work-note, handoff, ticket update.

**Rationale**: agents get invoked in contexts where the expected record may not exist:
- Agent Studio **Manual Test** has no CSM case attached
- Standalone API invocation may not pass a `caseSysId`
- A test harness may pass an empty string

A hard `{success:false, error:"NOT_FOUND"}` here makes the agent's Step 8 error path fire, derailing the user-facing flow over a missing audit-trail write. The handoff *intent* is recorded by the orchestrator's conversation log regardless of whether the case-side record got updated.

```js
(function(inputs) {
    // Soft-fail when no context — return success with a note rather than an error
    if (!inputs.caseSysId || String(inputs.caseSysId).length === 0) {
        return { success: true, note: 'No caseSysId provided — write skipped' };
    }
    var gr = new GlideRecordSecure('sn_customerservice_case');
    if (!gr.get(inputs.caseSysId)) {
        return { success: true, note: 'CASE_NOT_FOUND — write skipped', caseSysId: inputs.caseSysId };
    }
    if (!gr.canWrite()) {
        return { success: true, note: 'NO_WRITE_PERMISSION — write skipped', caseSysId: inputs.caseSysId };
    }
    gr.setValue('work_notes', inputs.workNote);
    gr.update();
    return { success: true, caseSysId: inputs.caseSysId };
})(inputs);
```

**What the LLM sees:**

```jsonc
// Happy path
{ "success": true, "caseSysId": "abc123..." }

// Missing context — STILL success, with a note
{ "success": true, "note": "No caseSysId provided — write skipped" }
```

The agent's instructions Step 7 (handoff confirmation) can present the user-facing message regardless. The `note` field gets recorded in the conversation log for audit.

**When NOT to soft-fail**: if the tool genuinely cannot complete without the context AND continuing would corrupt state, return `{__error_code: '...'}` and route to Step 8. Example: a "charge customer's credit card" tool should NOT soft-fail if customerId is missing.

---

## Step 8 error contract (matches Patterns 1–4)

A tool failure is signaled by **the presence of an `__error_code` field** on the response. That — and only that — triggers Step 8.

The instructions template should include this paragraph in Step 8:

```markdown
**Scope of Step 8**: Step 8 fires ONLY when an external-API-backed tool returns a response containing an `__error_code` field. Step 8 does NOT fire for:
- Tools that return `{exists: false, ...}` — that's a legitimate domain branch, handled in its specific step (e.g. Step 3.2 customer-not-found path)
- Action tools that return `{success: true, note: "..."}` — these soft-failed on missing context by design
- The literal value `success: false` without an `__error_code` — older anti-pattern, treat as success with the noted state

Recognized failure codes:
- `CUSTOMER_NOT_FOUND`, `PLAN_NOT_FOUND`, `INVALID_PARAM`, etc. (from the vendor API envelope unwrap)
- `HTTP_5xx`, `HTTP_4xx` (transport failure)
- `CONNECTION_NOT_FOUND`, `NOT_FOUND` (lookup tools)
- `PARSE_ERROR` (mock or API returned non-JSON)

On any `__error_code` presence:
1. Present the canned apology message defined in Step 8
2. Call `case_work_note_update` with the `__error_code` + `__error_message` + partial state (soft-fails if no case)
3. Call `human_agent_handoff` with `reason = "api_error_<__error_code>"` and end
```

**Escalate is the honest run-level outcome for this handoff.** An `__error_code` is one path
into escalation, but not the only one: *any* genuinely-stuck state — bounded retries
exhausted, a Verify read still inconclusive after a re-check, or no safe next action —
also resolves to `escalated` (the run-outcome name defined in "Run-level terminal outcomes"
below), handing off to a named queue with the full trail rather than guessing or stopping
silently. `escalated` reuses this same `human_agent_handoff` mechanism — it is a *name for
the outcome*, not a second mechanism.

---

## Anti-patterns to scan for

These checks are part of the committed scan — see `scripts/anti-pattern-scan.sh` (checks: setLimit(1) wrapper, hard-fail action tool).

One manual check has no automated form: a REST tool that returns a parsed body **without** unwrapping the envelope, when the vendor API uses a `{success, data, error}` shape. Grep responses from your vendor API; if they contain a `"success"` key, ensure the unwrap is present.

---

## Picking a pattern: decision tree

```
Tool calls an external HTTP API?
├── YES → does the API wrap responses in {success, data, error}?
│         ├── YES → Pattern 1 (REST + envelope unwrap)
│         └── NO  → Pattern 1 minus the envelope-unwrap block (just return parsed)
└── NO (in-instance only)
    │
    Tool reads database records?
    ├── YES → does the query return at most 1 row?
    │         ├── YES → Pattern 2 (flat single-row)
    │         └── NO  → Pattern 3 (count + records[])
    └── NO  → Tool writes to a record?
              └── YES → Pattern 4 (soft-fail on missing context)
```

---

## Run-level terminal outcomes

Everything above is **tool**-level return shapes — what one tool call hands back on one
turn. This section is the **run**-level contract: how a whole agent run *ends honestly*, so
"reported done" can never be mistaken for "verified done".

**Terminal outcome vocabulary** — every run should resolve to exactly one of:

`success` · `dry_run_success` · `mock_success` · `escalated`

**The terminal word is DERIVED from the tool return flags — tools do NOT emit the word
themselves.** State the mapping once, here; the tool templates and the builder inherit it:

| Tool return | Derived run outcome | Meaning |
|---|---|---|
| verified mutating success | `success` | the desired state was independently confirmed (see "Never false success") |
| `{ …, dryRun: true }` | `dry_run_success` | real code path ran; the irreversible side-effect was intentionally skipped |
| `{ …, mock: true }` | `mock_success` | a mock endpoint answered; no real external call happened |
| genuinely stuck | `escalated` | handed off to a human/queue with the full trail (see Step 8 contract above) |

**Labeling rule.** A dry-run or mock success MUST carry its distinct **flag**
(`dryRun: true` / `mock: true`) so the derived word can never be read as a real `success`
— not by the LLM, not by an eval scorer, not by a human reading the trail. The generated
instructions must teach the LLM to read these flags: a `dryRun`/`mock` return means the
side-effect did **not** happen, so report the dry-run/mock outcome, never a real success.

**Never false success.** A state-mutating run may only report `success` after an independent
**Verify** confirms the desired state. A Verify *read* error is **inconclusive** — re-check
it; never spin it as either `success` or a hard failure.

**Escalate is first-class.** When genuinely stuck, the run resolves to `escalated` — hand
off to a named queue with the full trail, not a guess or a silent stop. This reuses the
existing `human_agent_handoff` terminal from the Step 8 contract above; `escalated` is the
run-outcome *name*, not a second mechanism.

> **Where these outcomes are produced:** the `sn-aia-agent-builder` skill emits a `# Verify`
> step and a `# Outcome` block into a mutating/deploy agent's instructions (prevention at
> generation time); the `/sn-aia-trace-analyzer` skill catches phantom success at runtime if
> it slips through.

### Dry-run / mock return shapes

*(This subsection is the source of truth for the shapes the Cluster-B templates return —
`scripts/tool-scripts/action-tool.template.js` and `rest-tool.template.js` link here rather
than restating them.)*

```jsonc
// Dry-run: real code path ran (connection, validation, permission checks all executed),
// only the irreversible write was skipped. Flag present → derived outcome dry_run_success.
{ "success": true, "dryRun": true, "note": "dry-run — mutation skipped", "caseSysId": "abc123" }

// Mock: a configured mock endpoint answered; no real external call. → mock_success.
{ "success": true, "mock": true, "note": "mock endpoint — real call skipped" }
```

These overlap the Pattern 4 soft-fail shape (`{ success: true, note: "..." }`) on
`success: true` + `note`, but are distinguished by the `dryRun` / `mock` flag. That flag is
**not** an error — it does NOT trip Step 8; it routes through the success-interpretation
path, where the LLM reports the dry-run/mock outcome instead of a real success.
