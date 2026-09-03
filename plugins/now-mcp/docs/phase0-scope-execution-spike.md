# Phase 0 — ServiceNow scope execution spike

Status: **BLOCKED — not yet run.** Credentials for `demoalectriallwfaa152992`
are rejected by both now-mcp and now-sdk (`User name or password invalid`); the
instance itself is reachable (`stats.do` returns 302). This document is the
prepared spike, ready to run once a working password is configured.

This spike gates PR3 and PR4 (`privilegedRead` on `sn_query_records` and
`sn_aggregate_records`). Per the plan's exit criteria, **no privileged-read code
may ship before owning-scope execution is demonstrated against a real
scope-restricted table.** PRs 1, 2, 5 and 6 shipped independently and did not
need it.

## The question this must settle

Everything in Phase 3 rests on one unverified assumption: *that setting
`sys_scope` on a `sys_trigger` record causes its script to execute in that
application scope.* If that is false, the "scoped read backend" cannot exist as
designed, and the initial implementation must be restricted to a correctly
scoped Scripted REST endpoint instead — a materially different, larger change.

Guessing here is the specific failure this whole effort exists to prevent. A
global-scope read of a `read_access=0` table returns zero rows and reports
success, so a spike that *assumes* the scope took effect and sees zero rows
cannot distinguish "no data" from "wrong scope" — it would reproduce the
original bug inside its own verification.

## Prerequisites

1. Working credentials for a **non-production** instance.
2. A table with `read_access=false` whose owning scope is known. Find candidates:

   ```
   sn_query_records tableName=sys_db_object
     query="read_access=false^sys_scope.scope!=global"
     fields=["name","ws_access","read_access","sys_scope.scope"]
   ```

   Record which of the four access combinations the instance actually offers;
   if a combination is absent, say so rather than inferring its behaviour.

## Step 1 — establish the control

Read the target table through the Table API. If `ws_access=true` this should
return rows; if `ws_access=false` it must 403. Either way, record the row count.
**This is the ground truth every later step is compared against.** Without it, a
zero from a background script is uninterpretable.

## Step 2 — prove the scope is observable at all

Before testing whether scope can be *set*, confirm it can be *read*. Run a
default (global) background script:

```js
log(JSON.stringify({
  scope: gs.getCurrentScopeName(),
  user: gs.getUserName(),
}));
```

If `gs.getCurrentScopeName()` does not report a usable value from the
`sys_trigger` context, the spike stops here: scope cannot be verified from
inside the transport, so it can never be *proven* at runtime, and the plan's
requirement that "scope must be proven" is unsatisfiable via `sys_trigger`.

## Step 3 — the actual experiment

Run the same read three ways against the `read_access=false` table and record
all three row counts plus the observed scope:

| Run | How | Expected if sys_scope works | Expected if it does not |
| --- | --- | --- | --- |
| A | Table API | 403 (ws_access off) | 403 |
| B | Background script, default/global scope | 0 rows, scope `global` | 0 rows, scope `global` |
| C | Background script with `sys_scope` set to the owning application | **>0 rows, scope = owning app** | 0 rows, scope still `global` |

Run C is the whole spike. Note that **B and C differ only in the flag under
test**, which is why B must be run even though its result is already predicted —
it is the negative control that makes C's result mean something.

A caution on interpreting C: `>0 rows` is only meaningful if the table actually
contains rows. Confirm non-emptiness independently first (e.g. via `now-sdk
query`, which authenticates through a UI session), otherwise a zero in C is
ambiguous between "scope did not apply" and "table is genuinely empty" — the
original bug, again.

## Step 4 — record the decision

Write the outcome here, including the negative case. Then:

- **If C succeeds** — `sys_trigger` + `sys_scope` executes in the owning scope.
  PR3 may proceed as designed. Record the exact mechanism and the observed
  identity, since `accessContext.effectiveUser` must report it truthfully.
- **If C fails** — PR3 must be re-scoped to a Scripted REST endpoint per the
  plan's exit criteria, and the plan's sizing estimate needs revisiting. Do not
  ship a `privilegedRead` that silently falls back to global scope.

Either way the implementation must keep the rule that a global zero-row result
is never conclusive for a `read_access=0` table. Phase 1 already enforces this
for hints and background-script warnings; PR3 must enforce it by refusing to
execute rather than by warning.

## Why this is not automated as a test

It asserts platform behaviour, not our behaviour, and it mutates the instance
(creating a trigger). It belongs in the live verification matrix — run
deliberately against a non-production instance — not in `pnpm test`.
