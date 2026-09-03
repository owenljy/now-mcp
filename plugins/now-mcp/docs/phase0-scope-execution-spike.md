# Phase 0 — ServiceNow scope execution spike

Status: **RUN AND CONCLUDED.** Executed against `demoalectriallwfaa152992`
(instance `owen-demo`) on 2026-09-03.

**Result: NEGATIVE. `sys_trigger` cannot execute in a target application scope.
PR3's "sys-trigger-scoped" backend is not implementable as designed.**

**But the data is not unreachable: `now-sdk query` reads every access quadrant,
verified (finding 4). The hints now name it as the route.**

This spike gated PR3 and PR4 (`privilegedRead` on `sn_query_records` and
`sn_aggregate_records`). PRs 1, 2, 5 and 6 shipped independently.

## The question

Phase 3 rested on one unverified assumption: *that setting `sys_scope` on a
`sys_trigger` record causes its script to execute in that application scope.*

## Findings

### 1. The silent zero is real, and reproduced exactly

Against `sn_ai_observe_scoring_provider` (`ws_access=1`, `read_access=0`, owned
by `sn_ai_observe`), at the same moment:

| Route | Result |
| --- | --- |
| Table API | **1 row** — `traceloop` (`52696c1f0b1f4258a3db8208e39121d8`) |
| Background script, global scope | **0 rows**, `isValid: true`, `canRead: true`, no error, `success: true` |

This is the original failure, confirmed live rather than inferred. The script
does not merely return nothing — it returns nothing *while reporting success and
affirming it can read the table*. There is no signal available to the caller,
inside the result, that distinguishes this from an empty table.

### 2. `sys_trigger` has no `sys_scope` column

`sn_get_table_schema sys_trigger` with `includeExtended` and
`includeSystemFields`: **52 fields, zero matching "scope"** by name or label.

Posting `sys_scope` on a `sys_trigger` insert is silently ignored — the field is
accepted by the Table API (no error) and simply absent on read-back. So the
mechanism Phase 3 specified does not exist. `sysparm_transaction_scope` on the
insert also had no effect: it scopes the *insert transaction*, not the later
scheduled execution, which the scheduler runs in its own context.

Observed execution context, every run: `gs.getCurrentScopeName()` →
`rhino.global`, user `system`, roles `admin,snc_required_script_writer_permission,snc_internal`.

Note this makes the failure worse than "the flag didn't work": there is no flag.
An implementation that set `sys_scope` and trusted it would have run every
privileged read in global scope while reporting `executionScope` as the owning
app — a false claim in the very field meant to make privilege visible.

### 3. No in-script escape exists either

All attempted from a global-scope trigger against the same table:

| Attempt | Result |
| --- | --- |
| `GlideRecordSecure` | 0 rows |
| `GlideRecord.get(<known sys_id>)` | not found |
| `GlideAggregate` COUNT | no row |
| `autoSysFields(false)` + `setWorkflow(false)` | 0 rows |

The direct `get()` by a sys_id known to exist is the important one: the row is
**invisible to global scope**, not merely filtered out of a query result. No
query-shaping trick recovers it.

### 4. `ws_access=false, read_access=false` is unreachable from both MCP transports

On `sn_awh_gateway_capability`, `sn_vsc_hub_action_restriction`,
`sn_employee_app` (all `ws=0`, `read=0`): Table API 403s, and the global
background script returns 0 rows with `canRead: true`. Both MCP routes fail, and
only one of them fails *honestly*.

This is the quadrant PR3 existed to serve. Neither MCP transport can serve it —
but `now-sdk query` can (see the Decision section, point 4).

### 5. Incidental confirmation for PR1

`sys_db_object` returned its flags as `"1"` / `"0"`, not `"true"` / `"false"`.
PR1's `normalizeSNBoolean` handles both; a naive `=== 'true'` comparison would
have read `read_access="0"` as *unknown* and suppressed the warning on exactly
the tables that need it. Worth keeping in mind for any future flag reader.

## Decision

1. **PR3 and PR4 are not implementable as specified. Do not build them.** The
   plan's own exit criterion — "no implementation may treat a global zero-row
   result as conclusive for a table with `read_access=0`" — cannot be met by a
   `sys_trigger` backend, because global scope is the only scope it has.

2. **If privileged scoped reads are still wanted in-MCP**, the only remaining
   route is the plan's own fallback: a **Scripted REST endpoint deployed inside
   each target scope** (Fluent-authored, per the AUTHOR/OPERATE split). That is
   materially larger than the plan sized — one deployed artifact per application
   scope, not one internal service — and it should be re-scoped before any work.

   But weigh it against finding 4 first: `now-sdk query` already reads every
   quadrant today, from the CLI, with no new artifacts. The remaining gap is
   narrower than the plan assumed — it is "Claude cannot do this read in-loop",
   not "this read is impossible". Whether that gap justifies per-scope deployed
   endpoints is a product call, and it should be made explicitly rather than
   inherited from a plan written before this was known.

3. **What mitigates the original incident is PR1, which shipped.** The corrected
   403 hint and the background-script `visibilityWarnings` are not a stopgap
   ahead of privileged reads — they are the *primary* defence, because no
   privileged read is coming to sit behind them. They now do both halves of the
   job: rule out the transport that answers "empty" convincingly, and name the
   one measured to work.

4. **`now-sdk query` IS the working route — now verified, and restored to the
   hints.** (Initially unverifiable: now-sdk's keychain held the pre-rotation
   password. Re-tested once the `owen-demo` profile was fixed.)

   | Table | flags | Table API | background script | **now-sdk query** |
   | --- | --- | --- | --- | --- |
   | `sn_ai_observe_scoring_provider` | ws=1 read=0 | 1 row | **0 rows** | **1 row** (`traceloop`) |
   | `sn_vsc_hub_action_restriction` | ws=0 read=0 | 403 | **0 rows** | **rows returned** |
   | `sn_employee_app` | ws=0 read=0 | 403 | **0 rows** | **rows returned** |
   | `sn_awh_gateway_capability` | ws=0 read=0 | 403 | 0 rows | 0 rows — genuinely empty |

   now-sdk reaches all four access quadrants, including the `ws=0, read=0`
   quadrant that PR3 was designed to serve and that neither MCP transport can.

   The last row is why the other two were worth running: taken alone, a zero
   from `sn_awh_gateway_capability` looks exactly like a silent-zero failure.
   Only the tables that *did* return rows prove the transport works and that
   this particular zero is a genuinely empty table. A single-table check here
   would have produced the wrong conclusion — the same trap as the original
   incident, one level up.

## Cleanup

All spike artifacts removed. Two probe `sys_trigger` rows deleted (HTTP 204;
`nameSTARTSWITHmcp_spike` now returns `[]`), and the `mcp.spike.scope.runc`
mailbox property deleted and verified. The instance carries no residue from
this spike.
