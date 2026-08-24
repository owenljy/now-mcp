---
name: sn-aia-a2a-setup
description: Exposes a ServiceNow AI Agent Studio agent as a secondary Agent2Agent (A2A) server so an external orchestrator (Microsoft Copilot Studio, Google A2A clients, Postman/Bruno) can discover and invoke it. Covers the full OAuth Application Registry + CORS + Inbound Auth Profile + sync-channel wiring that the OOB flow leaves broken, plus a symptom-indexed troubleshooting reference built from a real debugging session. Trigger on "expose agent via A2A", "Agent2Agent", "secondary agent", "connect Copilot Studio to ServiceNow", "A2A agent card", "invalid_scope", "Missing redirect URL in application registration", "couldn't find an agent card at this URL", "connectorRequestFailure", "Push Notification URL is required for asynchronous requests", "OAuth2LoginStrategyCore failed to exchange code for access token".
argument-hint: "[agent name or sys_id] [external orchestrator, e.g. Copilot Studio]"
effort: high
---

# ServiceNow AI Agent — A2A Secondary-Agent Setup

Exposes an existing AI Agent Studio agent so an external caller can discover its
**Agent Card** and invoke it over the **Agent2Agent (A2A) protocol** (Google A2A
v0.3.0, JSON-RPC over HTTP). ServiceNow is the **secondary** agent here — it gets
called, it doesn't call out. (The reverse direction — ServiceNow calling an
external agent — is a different, mostly-working OOB flow; this skill is not for
that.)

> **Why this skill exists:** the vendor playbook for this feature (§13.3 in
> [references/playbook-original.md](references/playbook-original.md)) gets the
> architecture right but the setup wizards it points you to have real bugs and
> gaps — a wizard-only walkthrough gets you a connection that authenticates a
> user, then fails with `invalid_scope`, then `400`, then a browser that hangs
> forever on "Signing in…", each with a misleading or generic error message.
> Every fix below was extracted from actually chasing each of those failures to
> ground truth on a live instance. Follow the **Setup order**, not just the
> playbook's steps — the order matters (see callouts).

> **Prerequisite — capability resolution.** This skill reads AND writes
> `sn_aia_*`, `oauth_*`, `sys_auth_*`, `sys_api_access_*`, `sys_cs_channel`, and
> `sys_cors_rule` records, and runs ad-hoc background scripts to read
> `syslog`/`syslog_transaction`. Resolve against whatever MCP is connected using
> the same protocol as [../docs/mcp-capability-resolution.md](../docs/mcp-capability-resolution.md)
> (`read_records`, `run_privileged_script`), plus a **`write_records`**
> capability on the same pattern (create/update by table+fields; reference
> shape: `sn_create_records`/`sn_update_records` on the `now-mcp` plugin). If no
> matching write tool is connected, give the user the exact record/field values
> and the classic-UI navigation path instead of guessing blind — several of the
> tables below are one wrong field away from a silently-broken config.

> **Blast radius.** OAuth application registries, CORS rules, and API access
> policies are real security surface, not toy config — a CORS rule opens
> browser cross-origin access to an API for a whole origin; a `Public`/broad
> access-level choice on the agent config is a real exposure decision. State
> plainly what each write does and its scope before making it, same as any
> other security-relevant change.

---

## Setup order

Do these **in this order** — later steps depend on earlier ones, and the two
starred steps are the ones the vendor playbook under-specifies and where every
real failure in this skill's troubleshooting table originates.

1. **Enable the platform switches** (§3 in the original playbook)
   - `sn_aia.internal_agents.enabled_external` = `true` — lets external callers
     reach ServiceNow's AI Agents at all.
   - `sn_aia.enable_aiagents_discovery` = `true` — this is only a **UI display**
     toggle (shows the Discoverability section in AI Agent Studio); it does not
     gate the actual API. Don't confuse the two.

2. **Pick the agent, confirm it's active**, and get its `sys_id` from
   `sn_aia_agent`. Note both URLs you'll need later — they are **not
   interchangeable** and mixing them up is the single most common mistake here:
   - Agent Card (discovery, `GET`, no auth by default):
     `{instance}/api/sn_aia/a2a/v2/agent_card/id/{agent_sys_id}`
   - Execution endpoint (`POST`, auth required):
     `{instance}/api/sn_aia/a2a/v2/agent/id/{agent_sys_id}`

   Fetch the Agent Card now (plain GET, no auth) and read its `securitySchemes`
   — it tells you exactly which OAuth flows/scopes/token URLs the client needs
   (`authorizationCode` and/or `clientCredentials`, and the scope name — almost
   always `a2aauthscope`). Don't guess this; read it off the card.

3. **★ Set the messaging channel to synchronous** *(§6 in the playbook, but do
   it now, before touching OAuth — it's independent of auth and easy to
   forget)*. Unless you've built a push-notification callback registry, any
   caller without one (Postman, Bruno, most first-pass Copilot Studio setups)
   will get a **400** with `-32602 Invalid method parameters: Push
   Notification URL is required for asynchronous requests` on every execute
   call:
   - Table: `sys_cs_channel`, record named **"AI Agent A2A Channel"**
   - Set `synchronous` = `true`

4. **Decide the OAuth grant type** based on who's calling:
   - **Client Credentials** — pure machine-to-machine, no human in the loop
     (server-to-server integrations, cron-style callers).
   - **Authorization Code** — anything with an interactive "Connect" step tied
     to a signed-in user (Copilot Studio's "Generic OAuth 2" connector always
     uses this — even if you configure the ServiceNow side as Client
     Credentials, Copilot will still drive an interactive authorize+exchange
     flow, so **for Copilot Studio specifically, set up Authorization Code**,
     not Client Credentials).

5. **Create the OAuth Application Registry.**
   - Modern instances: **System OAuth → Application Registry → New → "New
     Inbound Integration Experience"**, then pick the grant type from step 4.
     (The classic "Create an OAuth API endpoint for external clients" wizard
     still exists but is marked Deprecated — same underlying `oauth_entity`
     record, prefer the new wizard.)
   - **OAuth application user**: only meaningful for Client Credentials (it's
     the identity every call runs as). For Authorization Code, this field is
     mostly cosmetic — the real acting identity is whoever logs in during the
     browser consent step. Either way, **don't default to admin.** Read the
     agent's tools/description to figure out which tables it actually queries,
     find the narrowest role that grants read on those tables (check
     `sys_security_acl` role groups for the table — e.g. an SLA-explaining
     agent touching `incident`+`task_sla`+`contract_sla` only needs
     `sn_incident_read`, not `itil`), and grant only that.
   - **Auth scope**: pick the scope whose underlying `sys_api_access_scope`
     mapping targets the AI Agent A2A API specifically (name is usually
     `a2aauthscope` — confirm by checking what scope the Agent Card itself
     advertises in step 2). Don't pick an unrelated scope (`useraccount`, a
     voice/document scope, etc.) just because it's in the dropdown.
   - **★ Immediately after saving, do the two fixups in
     [references/troubleshooting.md → "invalid_scope" and "wrong default grant type"](references/troubleshooting.md)** —
     the wizard does not fully wire scope or `default_grant_type` no matter
     which grant type you pick. Skipping this is why the first real end-to-end
     test almost always fails with `invalid_scope` on the token exchange, deep
     inside a generic-looking client error.

6. **★ Add a CORS rule** if the caller's UI does a browser-side (not
   server-side) fetch to discover the Agent Card — this is true for Copilot
   Studio's "Connect Agent2Agent" dialog. Symptom: the connector says it
   "couldn't find an agent card at this URL" while ServiceNow's own
   `syslog_transaction` shows a clean `200` for that exact request at that
   exact second — that mismatch (server says success, client says failure) is
   the CORS signature; the browser threw the response away before the caller's
   JS ever saw it.
   - Table `sys_cors_rule`, scoped to the specific REST API (`sys_ws_definition`
     record for `AI Agent A2A API`, base URI `/api/sn_aia/a2a`), `domain` = the
     caller's exact origin (e.g. `https://copilotstudio.microsoft.com` — get it
     from the browser console's CORS error, don't guess), `get`+`post` = true,
     `access_control_allow_headers` including `Authorization,Content-Type`.
   - Don't set `domain` to `*` "to be safe" — scope it to the one origin that
     needs it.

7. **★ Wire a working Inbound Authentication Profile.** The OOB
   `inbound_auth_profile` record **"OAuth in External AIA for A2A"**, already
   attached to the OOB `sys_api_access_policy` **"AI Agent A2A API Access
   Policy"**, ships with no working OAuth config underneath it and is
   protection-policy-locked (won't budge even from a background script with
   metadata-write approval — that's intentional, don't try to force it). You
   must add a **second**, working profile alongside it — don't try to edit or
   delete the OOB one:
   1. **System Web Services → API Access Policies → Inbound Authentication
      Profile → New → "Create standard http authentication profiles"**. Type:
      OAuth. OAuth Entity: the app you created in step 5.
   2. Link it to the policy: create a `sys_auth_profile_mapping` row with
      `api_access_policy` = the "AI Agent A2A API Access Policy" sys_id and
      `inbound_auth_profile` = the profile you just made.

8. **Set the caller up on the other side** (Copilot Studio, Postman, Bruno —
   see [references/bruno-isolation-test.md](references/bruno-isolation-test.md)
   for a ready-to-use test collection) with:
   - Agent Card / discovery URL from step 2 (not the execute URL) wherever the
     UI asks for a "connect" or "endpoint" URL for *discovery*.
   - Authorization URL = `{instance}/oauth_auth.do`, Token URL =
     `{instance}/oauth_token.do`, Client ID/Secret from step 5, Scope from
     step 5.
   - If the caller needs its own redirect URI registered (Authorization Code
     only): the value is **caller-specific**, not something ServiceNow
     generates on its own initiative — e.g. Microsoft Power
     Platform/Copilot Studio uses `https://global.consent.azure-apim.net/redirect/{connection-id}`.
     Grab the *exact* value from the failed `/oauth_auth.do` request's
     `redirect_uri=` query param (browser address bar or
     `syslog_transaction`) and set it on the `oauth_entity.redirect_url`
     field — the modern "New Inbound Integration Experience" form doesn't
     expose this field for you to type it in directly.

9. **Test end-to-end**, cheapest signal first:
   1. Agent Card GET, no auth — confirms discovery + (if applicable) CORS.
   2. Full OAuth round trip via Bruno/Postman, **not** the real caller — see
      [references/bruno-isolation-test.md](references/bruno-isolation-test.md).
      This isolates "is ServiceNow broken" from "is the third-party connector
      doing something odd" in one shot, and every step above should already
      make this succeed. If Bruno succeeds and the real caller still fails,
      the problem has moved to the caller's side (stale cached connection
      state, wrong browser, per-user consent not yet completed in that UI —
      see troubleshooting).
   3. The real caller, fresh connection (delete and recreate the connector's
      saved connection rather than retrying a failed one — several of these
      failures get cached client-side and retrying just replays them).

---

## When something fails

Don't re-derive this from scratch — check
[references/troubleshooting.md](references/troubleshooting.md) first. It's a
symptom → real cause → fix table built from an actual failure chain on a live
instance (redirect_uri → invalid_scope → wrong default_grant_type → CORS →
broken OOB inbound auth profile → async/sync → 401 not-authenticated → Safari
popup redirect loop), including which tables/fields we checked and ruled out
along the way so you don't repeat that work. It also documents which fields
are **intentionally ACL-locked and should not be forced** even from a
privileged background script.

For the exact `syslog`/`syslog_transaction` queries that made each of those
failures diagnosable — most of them are invisible from the client-side error
alone — see [references/diagnostic-queries.md](references/diagnostic-queries.md).

For what each obscure table in this flow actually is and how they relate (there
are at least a dozen `oauth_*`/`sys_auth_*` tables involved and the
relationships are not discoverable from field names alone), see
[references/table-reference.md](references/table-reference.md).

## After setup

Tell the user:
- Which grant type was configured and why (matched to the caller type).
- The exact discovery URL and execute URL (they are different — restate both).
- The least-privilege role granted to the OAuth application user, and what
  agent capability that role unlocks (so it's clear what's *not* covered if
  the agent gains tools later).
- The CORS rule's exact origin, if one was added — flag that adding more
  origins later means editing that same rule, not creating a `*` fallback.
- That the OOB "OAuth in External AIA for A2A" profile was left in place, and
  a new profile was added alongside it — not a replacement.
