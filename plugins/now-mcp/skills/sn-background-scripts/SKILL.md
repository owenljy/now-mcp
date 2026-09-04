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
- A table you need to inspect has `ws_access` off and the operation cannot be
  expressed by `sn_query_records`. For ordinary record reads, prefer
  `sn_query_records` with `allowNowSdkFallback:true`: it only uses an aligned
  now-sdk profile after metadata confirms the table-wide REST block. A
  background script is not a safe substitute when `read_access` is also off,
  because a different application scope can return a successful false zero.

## When NOT to use

- The user wants a one-off script for something not in the table — just write it
  directly with `sn_execute_background_script`; don't force-fit a template.
- The task is application metadata authoring (tables, business rules, ACLs, UI
  policies) — that belongs in the Fluent SDK (now-sdk), not a background script.

## Transport limits

The sys_trigger transport uses bounded `sys_properties` chunks. It can carry up
to 56,000 characters; the tool renders at most 8,000 characters and reports
whether truncation happened in the mailbox (`mailbox_limit`) or at rendering
(`render_cap`). Count and aggregate server-side and log one compact result rather
than dumping rows.

- `resultMode: "json"` parses only the final output line, caps it at 20,000
  characters, and requires a boolean `success` or `ok` property. A contract or
  parse failure is reported separately from transport success.
- Completed calls identify script, persistence, polling, payload-read and cleanup
  timing. Scheduler wait is an upper bound because it includes polling detection
  and request latency.
- A timeout is `executionState: "unknown_after_timeout"`, not proof of
  cancellation. The tool requests trigger cancellation and cleans the mailbox,
  but a script already claimed by the scheduler may have run; verify mutations
  before retrying.
- Missing chunks, chunk-write failures and invalid envelopes are explicit errors.
  Do not treat partial output as the script's complete result.

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
