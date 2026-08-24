# A2A Setup — Table Reference

On-demand reference for `/sn-aia-a2a-setup`. None of these relationships are
discoverable from field names alone — several tables that sound like they
should hold the OAuth config for an app don't, and the tables that actually
matter are one hop further away via a junction table with a name that doesn't
mention either side of what it joins. Confirmed by direct schema inspection
(`sn_get_table_schema`) and by tracing `sys_dictionary` reference fields, not
by documentation.

---

## The agent side

- **`sn_aia_agent`** — the AI Agent record itself. `sys_id` is what goes in
  both the discovery and execute URLs.
- **`sn_aia_agent_config`** — per-agent runtime config: `active`, `public`
  (boolean — the closest thing to a per-agent "exposed" flag; there is no
  finer-grained "Any authenticated user / specific role / Public" tri-state
  field anywhere in the schema, despite the AI Agent Studio UI presenting it
  as a 3-way choice — that granularity, if it exists, lives in UI-only logic
  we didn't find a backing table for), `specialist_enabled`, `run_as_user`.

## OAuth application registration (`oauth_*`)

- **`oauth_entity`** — the actual OAuth Application Registry / "client" record.
  Key fields: `client_id`, `client_secret`, `inbound_grant_type` (what this
  client is allowed to request — `client_credential`, `authz_code`, or
  `multiple`), `default_grant_type` (fallback when a request doesn't specify
  one — **the wizard leaves this wrong**, see troubleshooting #4),
  `redirect_url` (**not exposed by the modern simplified creation UI** — see
  troubleshooting #2), `user` (the "OAuth application user" — only load-bearing
  for Client Credentials).
- **`oauth_entity_scope`** — flat list of scope-name strings (`oauth_entity`,
  `name`, `oauth_entity_scope`) allowed for a given app. This is the **classic**
  scope-grant table that `/oauth_token.do` actually checks during code→token
  exchange. **The modern wizard does not write to this table** even when you
  pick a scope in its "Auth scope" dropdown (see next table) — you must create
  the row yourself.
- **`oauth_entity_profile`** — only relevant when `oauth_entity.inbound_grant_type
  = 'multiple'`. One row per grant type this app supports (`grant_type`:
  `client_credentials` / `authorization_code` / etc.), each with its own
  `oauth_profile` sub-config.
- **`oauth_entity_profile_scope`** — junction: `oauth_entity_scope` ↔
  `oauth_entity_profile`. Only needed when the app is `inbound_grant_type =
  'multiple'` — a scope must be linked to *each* profile/grant-type it should
  work under, not just to the entity as a whole.
- **`oauth_entity_auth_scope_mapping`** (label: "Auth Scopes") — the **new**
  scope link: `oauth_entity` ↔ `sys_auth_scope`. This is what the modern "New
  Inbound Integration Experience" wizard's "Auth scope" dropdown actually
  writes to. **This table being correctly populated does not mean
  `oauth_entity_scope` (above) is** — they are two independent, parallel
  systems and both need to agree for the classic token endpoint to accept the
  scope. This is the single biggest gap between "wizard says configured" and
  "actually works."

## REST API Auth Scope (the newer scope-definition layer)

- **`sys_auth_scope`** — just a name + description (e.g. `a2aauthscope`). No
  `active` field, nothing else to check here.
- **`sys_api_access_scope`** — maps a `sys_auth_scope` to a specific API/
  resource/method (`auth_scope`, `api`, `api_path`, `http_method`,
  `apply_all_resources`, `apply_all_methods`, `apply_all_versions`,
  `disable_client_restriction`). For A2A, look for the row named "AI Agent
  A2A API Access Scope" with `api_path: sn_aia/a2a`. `disable_client_restriction`
  is ACL-locked against writes (even privileged background scripts) — don't
  try to change it (troubleshooting #5).

## Execution-time token validation (separate from issuance — see troubleshooting note)

- **`inbound_auth_profile`** (label "Authentication Profile") — a thin record
  (`name`, `description`, `active`, `auth_processor`) referenced by API Access
  Policies. The OOB A2A one is named **"OAuth in External AIA for A2A"** and
  ships broken (empty/protected underlying OAuth config) — see troubleshooting
  and the "ruled-out dead ends" note about `sys_auth_profile_oauth2` not
  reliably being where its config lives.
- **`sys_api_access_policy`** — the OOB record "AI Agent A2A API Access
  Policy" covers the `sn_aia/a2a` path.
- **`sys_auth_profile_mapping`** (label "Inbound authentication profile") —
  junction: `api_access_policy` ↔ `inbound_auth_profile`. This is how you
  attach a *new*, working profile alongside the broken OOB one — add a row
  here, don't try to edit the OOB mapping.
- **`sys_auth_profile`** / **`sys_auth_profile_oauth2`** — sibling/child
  classes under a common abstract base with `inbound_auth_profile` (not a
  parent-child relationship with it, despite the naming). Don't assume a
  record's `sys_id` in `inbound_auth_profile` will resolve to a matching row
  here — it didn't for either the OOB record or a freshly wizard-created one
  on the instance this was tested against.

## Sync/async and discovery plumbing

- **`sys_cs_channel`** — Messaging Channel. The row named **"AI Agent A2A
  Channel"** has the `synchronous` boolean that determines whether the
  execute call can respond inline (no push URL needed) or requires a
  configured callback (troubleshooting #7).
- **`sys_cors_rule`** — `domain`, `rest_api` (choice, but really a dynamic
  reference to a `sys_ws_definition` sys_id — find it by querying
  `sys_ws_definition` for `base_uri = '/api/sn_aia/a2a'`), `get`/`post`/etc.,
  `access_control_allow_headers`. Needed only when the caller's discovery UI
  does a **browser-side** fetch (troubleshooting #1) — server-to-server calls
  never need this.
- **`sn_aia_external_agent_card`**, **`sn_aia_external_agent_discovery`**,
  **`sn_aia_external_agent_skill`** — these look like they'd hold the exposed
  Agent Card, but they're actually for the **opposite** direction: registering
  an *external* agent that ServiceNow itself calls out to (ServiceNow as
  primary/orchestrator). Don't write to these when setting up ServiceNow as
  the callee — the Agent Card ServiceNow serves for *this* flow is generated
  dynamically by the platform, not stored in a table.

## Sanity-check queries

```
# Which grant types/redirect/scope does this app actually have wired?
sn_query_records oauth_entity
  query: sys_id=<app_sys_id>
  fields: [client_id, inbound_grant_type, default_grant_type, redirect_url, user]

# Is the classic scope table populated? (the wizard-gap check)
sn_query_records oauth_entity_scope
  query: oauth_entity=<app_sys_id>
  fields: [name, oauth_entity_scope]

# Is the new scope table populated?
sn_query_records oauth_entity_auth_scope_mapping
  query: oauth_entity=<app_sys_id>
  fields: [oauth_entity, auth_scope]
  expand: {auth_scope: [name]}

# Which auth profiles are actually attached to the A2A API access policy?
sn_query_records sys_auth_profile_mapping
  query: api_access_policy=<AI Agent A2A API Access Policy sys_id>
  fields: [inbound_auth_profile]
  expand: {inbound_auth_profile: [name]}

# Is the channel synchronous?
sn_query_records sys_cs_channel
  query: name=AI Agent A2A Channel
  fields: [synchronous]
```
