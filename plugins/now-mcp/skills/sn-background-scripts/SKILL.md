---
name: sn-background-scripts
description: Curated `sn_execute_background_script` templates for common ServiceNow instance-admin tasks (e.g. disabling MFA enforcement on a non-prod instance, or diagnosing why a user account can't authenticate — Active/Locked out/password/reset/API-access-role checks) so now-mcp's Basic/OAuth auth can connect. Use when the user wants to run one of these named operations rather than write the script from scratch.
allowed-tools: Read mcp__plugin_now-mcp_now-mcp__sn_execute_background_script
---

# ServiceNow Background Script Templates

A small, curated library of ready-to-run scripts for `sn_execute_background_script`,
for tasks that come up repeatedly across instances. Each template lives as its own
file under `references/` so only the one you need gets read into context.

## When to use

- The user names one of the operations in the table below (or a close paraphrase).
- The user is blocked on a known instance-config problem this library already covers
  (e.g. now-mcp getting 401s because the instance enforces MFA and neither Basic auth
  nor OAuth password grant can satisfy an interactive MFA challenge).
- now-mcp can't authenticate against an account and you need to know which
  precondition is missing (Active, Locked out, password state, API access role,
  MFA) before guessing at a fix.
- A table you need to read has `ws_access` off, so every Table-API read (query or
  aggregate) returns 403 before any role/ACL check runs — a background script
  with `GlideRecordSecure`/`GlideAggregate` is the only way in. now-mcp's 403
  response names this case explicitly; trust that hint rather than chasing roles.

## When NOT to use

- The user wants a one-off script for something not in the table — just write it
  directly with `sn_execute_background_script`; don't force-fit a template.
- The task is application metadata authoring (tables, business rules, ACLs, UI
  policies) — that belongs in the Fluent SDK (now-sdk), not a background script.

## Transport limits

The sys_trigger transport shapes what a script can return — budget for it before
writing one, because every failure below reports the same opaque error.

- **Output truncates at roughly 2.7 KB** (`truncationReason: "mailbox_limit"`).
  Count and aggregate server-side with `GlideAggregate` and log one compact JSON
  line; never dump rows expecting to read them all back.
- **`resultMode: "json"` can fail a script that otherwise succeeds.** If you get
  `script completed with failure` on a script whose final line is valid JSON,
  re-run without `resultMode` before editing the script body.
- **`script completed with failure` carries no cause.** Do not retry the same
  shape — simplify first (fewer tables, no nested per-row queries, smaller
  `setLimit`), and if the table is Table-API readable, prefer a plain query or
  aggregate call over a script.

## Templates

| Task | File | Scope |
|---|---|---|
| Disable MFA enforcement instance-wide | `references/disable-mfa.js` | **Non-prod only** |
| Diagnose why a user can't log in via basic auth (Active/Locked out/password/reset/API-access-role/MFA) | `references/check-login-eligibility.js` | Read-only — safe on any instance, including prod |

## How to run a template

1. Read the template file to confirm it fits the instance and situation — every
   template's header comment states its scope restriction (e.g. non-prod only) and
   what write access it needs.
2. **Always ask the user for explicit confirmation before calling
   `sn_execute_background_script`, no matter which template it is or how low-risk
   it looks.** State which instance you're about to target and what the script
   does, then wait for a clear go-ahead. This applies unconditionally — there is
   no template in this library exempt from it, and "the user already asked me to
   run this template" is not itself confirmation of the target/instance at
   execution time.
3. Only after the user confirms: call `sn_execute_background_script` with the
   file's contents as `script`, and the `allowWrites` / `allowMetadataWrites`
   flags the header comment specifies.
4. Report back the `gs.log` output so the user can see what actually happened
   (e.g. which `sys_authentication_policy` record was deactivated) — that's also
   what you need to reverse the change later.

## Avoidance

- Do not call `sn_execute_background_script` from this skill without first
  getting explicit user confirmation of the target instance and action — this
  is a hard rule, not a judgment call scoped to "risky" templates only.
- Do not run `disable-mfa.js` (or any template that touches auth/security posture)
  against a production instance. Verify the target instance first via
  `sn_connection_status` or by asking the user.
- Do not skip reading the template before running it — headers carry scope and
  reversal notes that matter more than the code itself.
