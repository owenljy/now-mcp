# Phase 0 — ServiceNow scope execution spike

Status: **RUN AND CONCLUDED.** Executed against `demoalectriallwfaa152992`
(instance `owen-demo`) on 2026-09-03.

**Result: NEGATIVE. `sys_trigger` cannot execute in a target application scope.
PR3's "sys-trigger-scoped" backend is not implementable as designed.**

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

### 4. `ws_access=false, read_access=false` is unreachable from both transports

On `sn_awh_gateway_capability`, `sn_vsc_hub_action_restriction`,
`sn_employee_app` (all `ws=0`, `read=0`): Table API 403s, and the global
background script returns 0 rows with `canRead: true`. Both routes fail, and
only one of them fails *honestly*.

This is the quadrant PR3 existed to serve. It cannot be served by this transport.

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

2. **If privileged scoped reads are still wanted**, the only remaining route is
   the plan's own fallback: a **Scripted REST endpoint deployed inside each
   target scope** (Fluent-authored, per the AUTHOR/OPERATE split). That is a
   materially larger change than the plan sized — it needs one deployed artifact
   per application scope, not one internal service — and it should be re-scoped
   and re-estimated before any work starts.

3. **What actually mitigates the original incident is PR1, which shipped.**
   Given the finding above, the corrected 403 hint and the background-script
   `visibilityWarnings` are not a stopgap ahead of privileged reads — they are
   the *primary* defence, because for `read_access=0` tables there is no
   privileged read to fall back to. The correct behaviour is to tell the caller
   the result is inconclusive and point at `now-sdk query` (a UI session, which
   ServiceNow does not treat as a web-service call).

4. **The `now-sdk query` recommendation is UNVERIFIED and has been removed from
   the `read_access=0` hint.** Attempting to check it here failed for unrelated
   reasons: now-sdk's keychain still holds the pre-rotation password, and a
   direct UI-session login was rejected (`login.do` returns the login page with
   an invalid-credentials marker despite correct credentials — likely MFA or SSO
   on this demo instance). Rather than ship an unmeasured claim as "the reliable
   check", the hint now states what WAS measured: the background transport
   cannot read the table, and the read must happen from inside the owning scope.
   If someone later confirms a UI session does reach these tables, the hint can
   name it again — but as a verified route, not an inference.

## Cleanup

All spike artifacts removed. Two probe `sys_trigger` rows deleted (HTTP 204;
`nameSTARTSWITHmcp_spike` now returns `[]`), and the `mcp.spike.scope.runc`
mailbox property deleted and verified. The instance carries no residue from
this spike.
