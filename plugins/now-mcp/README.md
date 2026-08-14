# now-mcp — Claude's ServiceNow instance, built around Fluent (`now-sdk`)

A small, trustworthy, **Fluent-native**
[Model Context Protocol](https://modelcontextprotocol.io) server that lets Claude
**operate a running ServiceNow instance**: read and write runtime data, inspect
schema, run server-side scripts, and manage attachments. It also carries an
on-demand skill (`sn-docs-search`) and a SessionStart hook that injects the
standing **Fluent workflow** rules into a Fluent project's `CLAUDE.md`.

Part of the [`foundry-suite`](../../README.md) marketplace. For the AI Agent
lifecycle skills, see the [`aia-toolkit`](../aia-toolkit/README.md) plugin.

## The idea in one paragraph

Three layers, each with one job: **Fluent (`now-sdk`) authors** the application
(tables, business rules, workflows) as source code and deploys it; **`now-mcp`
operates** the running instance (query/aggregate data, read schema, write data
rows, run server-side scripts, manage attachments); **skills orchestrate** the
two into workflows. The line that keeps them apart: **data rows are runtime →
MCP; config/metadata is the app's definition → Fluent source.** That's why the
MCP writes an incident but never a business rule.

---

## Quick start

### Prerequisites
- **Node.js 22+** (matches now-sdk's floor and CI)
- **pnpm via corepack** — run `corepack enable` once (corepack ships with Node); the
  plugin's first-launch bootstrap uses it to install deps at the pinned version
- A **ServiceNow instance** and credentials (basic auth or OAuth)
- *(Optional)* the **`now-sdk`** CLI for the Fluent pairing: `pnpm add -g @servicenow/sdk`

### Install as a Claude Code plugin (recommended)

Install from the `foundry-suite` marketplace — from git, no manual build:

```
/plugin marketplace add <REPO_URL>
/plugin install now-mcp@foundry-suite
/reload-plugins
```

When you enable it, Claude Code pops up a **setup form** for connection details.
For a single instance (basic auth), just fill in **instance URL**, **username**,
and **password** — the password is stored in your system keychain, and no config
file is needed. Leave **Read-only** as-is to stay read-only (type `false` to
allow writes). For multi-instance, OAuth, or now-sdk pairing, leave those blank
and set **config file** to the path of a `sn-credential.yaml`
(see [Configuration](#configuration)) instead.

---

## Configuration

Two ways to configure, depending on how complex your setup is:

- **Single instance, basic auth (the common case)** — no file needed. As a
  plugin, fill in the instance URL, username, and password in the enable-time
  form; standalone, set `SERVICENOW_URL` / `SERVICENOW_USERNAME` /
  `SERVICENOW_PASSWORD`. The password is kept in your system keychain.

- **Multiple instances, OAuth, or now-sdk pairing** — use a **YAML file**
  (below). It's the same format whether you have one instance or many, and it's
  what the plugin's "Config file" field points to.

**YAML setup** — two steps:

```bash
# 1. Copy the example (your copy is git-ignored, so credentials stay local).
#    The template is bundled with the plugin at config/sn-credential.example.yaml
#    (relative to the plugin root), and viewable at
#    https://github.com/owenljy/foundry-suite/blob/main/plugins/now-mcp/config/sn-credential.example.yaml
cp config/sn-credential.example.yaml config/sn-credential.yaml
# 2. Edit config/sn-credential.yaml — the file is commented; the minimal
#    single-instance block at the top is all most setups need.
```

The minimal config is just one instance:

```yaml
instances:
  - name: dev                  # numeric PDI names like 123456 are fine, unquoted
    url: https://dev123456.service-now.com
    auth:
      type: basic              # basic, or oauth (clientId/clientSecret/tokenUrl)
      username: api.user
      password: change-me
    default: true              # exactly one instance must be the default
    readOnly: false            # false = writes on. Omit/true = read-only (safe default)
```

Add more instances (prod, OAuth, etc.) by uncommenting the extras in the example
file. Tools take an optional `instance` argument to target one by `name`;
otherwise the `default` is used. It's YAML (a JSON superset), so comments are
fine and old JSON still parses.

**Auth types** — each instance uses either `basic` (username + password) or
`oauth`. OAuth supports two grant types via `grantType` (defaults to
`client_credentials`):

- `client_credentials` — app-level token from `clientId`/`clientSecret`.
- `password` — user-level token; `username`/`password` are exchanged once for a
  token, then renewed with the returned `refresh_token` (no password re-send).

```yaml
    auth:
      type: oauth
      grantType: password          # or client_credentials (default)
      clientId: your-client-id
      clientSecret: your-client-secret
      tokenUrl: https://dev123456.service-now.com/oauth_token.do
      username: api.user           # required for grantType: password
      password: change-me          # required for grantType: password
      # scope: useraccount         # optional
```

**How config is resolved** — in this order:
1. **`SERVICENOW_CONFIG_PATH`** → a YAML file at any path (use this for a
   global/out-of-repo install), else
2. **`SERVICENOW_URL`** (+ `SERVICENOW_USERNAME` / `SERVICENOW_PASSWORD`) → the
   single-instance **fast path**: one basic-auth instance built straight from
   env vars, no file required. This is what the plugin form feeds. Basic-auth
   single-instance only; use YAML for OAuth or multiple instances. Else
3. **`config/sn-credential.yaml`** (or `.yml`) in the working directory.

Without a valid config the server still starts (degraded mode) and reports the
reason (including the working directory and which sources it checked) on each
call, so you can fix it without a crash loop.

---

## Tools

### Safe troubleshooting workflow

1. Verify that the mutation record or attachment persisted.
2. Verify the target filter against the actual record.
3. Inspect bounded logs/events with `sn_get_runtime_events` (a time bound is mandatory).
4. Check the downstream observable state.
5. Invoke underlying logic directly only to isolate dependencies.
6. State conclusions as **confirmed**, **not observed**, or **inconclusive**.

Table and Attachment API persistence does not prove that Business Rules, flows, events, or
asynchronous work ran. `sys_trigger` rows are ephemeral, so absence is not proof that work was
never queued. A missing log phrase only means no matching readable row was found. Directly invoking
a dependency proves that dependency works in that context; it does not prove the trigger path ran.

For high-volume tables such as `syslog`, default `queryPolicy: "safe"` rejects text searches without
a bounded `sys_created_on`/`sys_updated_on` predicate. `limit` caps returned rows, not database scan
cost. Use a narrow window and separate OR terms; use `allow_expensive` only with explicit intent.

For attachments, prefer `filePath` (a path visible to the MCP server process) over base64
`fileContent`. Exactly one is required. The server reads the file locally and never returns the
base64 payload. Historical journal values such as `work_notes` do **not** need `sys_journal_field`
(which non-admins cannot read anyway): requesting the journal column with `displayValue: "all"`
returns the full entry stream with timestamps and authors.

### Data (read & write runtime records)
| Tool | What it does |
|---|---|
| `sn_query_records` | Read any table — encoded-query filters, field selection, **dot-walking**, pagination, display values, and `expand` for nested reference fields in one round trip; field names are checked before the query is sent; on MCP auth/transport failure, automatically tries an aligned `now-sdk query` profile |
| `sn_aggregate_records` | Counts / group-by / avg / sum / min / max via the **Stats API** (server-side, cheap) |
| `sn_create_record` | Insert a record (with schema field validation + typo hints, and write-routing guards) |
| `sn_update_record` | Patch/replace a record by sys_id; verifies persistence by default and classifies silent non-persistence |
| `sn_delete_records` | Delete **one or many** records by sys_id (destructive); verifies deletion by default in a single extra request |
| `sn_batch_create` / `sn_batch_update` | Create/update many records via the **Table Batch API** — one request per wave of 25 (default 50/call; not transactional) |
| `sn_diff_records` | Compare two records on a table field-by-field; returns only what differs |

`sn_delete_records` is one tool for both cardinalities — the underlying Table API
call is identical whether you pass one sys_id or fifty, so cardinality is data
rather than a different operation.

#### Failures ServiceNow does not report

Three behaviours return HTTP 200 and no error while giving you the wrong answer.
Each is handled where it happens rather than left to the caller to notice:

- **An unknown field in an encoded query is silently ignored**, dropping that
  condition. Measured on a live instance: `priority=1` matched 27 incidents,
  `priorityy=1` matched all 67. `sn_query_records` and `sn_aggregate_records`
  check field names (in `query`, `fields`, `groupBy`, `*Fields`) against the table
  schema first and report the typo with a suggestion. Pass
  `skipFieldValidation: true` to run a query as written. This is GlideRecord
  behaviour, not Table-API-specific — GraphQL resolves an unknown field to `null`
  with an empty `errors` array, so no transport change avoids it.
- **Journal fields read back empty.** `comments` / `work_notes` put the entry
  stream (timestamps, authors, text) in `display_value` and leave `value` as `""`,
  so the default `displayValue: false` makes a record with nine comments look like
  it has none. Requesting a journal field without a display value returns a
  warning saying so; use `displayValue: "all"`.
- **Inserts that bypass a required engine still return 201.** A direct
  `cmdb_ci_*` insert skips Identification and Reconciliation and creates duplicate
  CIs; a direct `sc_request` / `sc_req_item` insert produces a request no workflow
  picks up. Those inserts are blocked with the correct API named
  (`/api/now/identifyreconcile`, `/api/sn_sc/servicecatalog/…`); pass
  `acknowledgeRoutingRisk: true` to insert anyway. Routing is decided by actual
  table inheritance, not the name prefix — `cmdb_ci_outage` and the
  `cmdb_ci_m2m_*` join tables carry the prefix without extending `cmdb_ci`, and
  inserting them is ordinary work.

#### Transports

Reads and writes go over the REST Table/Stats/Attachment APIs. Two additions:

- **Table Batch API** (`/api/now/v1/batch`) carries a whole wave of batch
  create/update/delete calls in one request instead of one request per record.
  Instances without the endpoint fall back to the original looped path
  automatically (decided before anything is written, so nothing double-applies).
- **GraphQL** (`/api/now/graphql`) backs `expand` and the effective-access
  verdicts described below. It is an internal transport, not a tool: raw GraphQL
  would hand the model a surface where errors arrive as HTTP 200 with an `errors`
  array, where the schema spans ~6,200 tables with introspection disabled by
  default, and where an unknown field resolves to `null` silently. What it buys is
  a true total row count independent of pagination, per-field control over value
  vs. display value, and the platform's own per-caller access verdict. **Writes
  stay on REST** — a GraphQL mutation can report success with a null result and
  needs a re-read to confirm, which is strictly worse than the REST response.

### Schema discovery
| Tool | What it does |
|---|---|
| `sn_get_table_schema` | Fields, types, references, mandatory/read-only (cached) |
| `sn_get_table_structure_from_data` | Infer structure by **sampling real rows** — fallback when `sys_dictionary` is thin/incomplete |
| `sn_list_tables` | List/filter tables |
| `sn_get_choice_list` | Valid choice values for a field |
| `sn_get_security_info` | Consolidated table security posture — the API user's **effective** access verdict (table + field), plus the ACLs, role requirements, data policies and security business rules behind it |
| `sn_diagnose_mutation` | Read-only mutation preflight **as the background-script identity**: record/field capabilities, before BR abort risks, effective ACL coverage (write mapping, inheritance, wildcards, roles), and reference dependencies |

`sn_get_security_info` includes `aclRoleGroups`. Roles attached to one ACL are
reported as `requiredRolesAnyOf`; they are alternatives, not an all-of list.
The flattened `rolesByOperation` field is only an inventory: matching table and
field ACLs plus each ACL's role, condition, and script checks still participate
in access evaluation. `adminOverrides: false` means `admin` does not
automatically bypass that ACL.

#### Effective access: whether, not just why

Reading `sys_security_acl` tells you which rules exist. It cannot tell you what
they add up to for a given caller — so `sn_get_security_info` also returns
`effectiveAccess`: ServiceNow's own `canRead`/`canWrite`/`canCreate`/`canDelete`
verdict for the user this MCP authenticates as, plus per-field `canRead`/
`canWrite` for any `fields` you pass (`recordSysId` pins which record those field
verdicts describe). Measured on a demo instance as **admin**:
`sys_security_acl` comes back `canWrite=canCreate=canDelete=false`, because
instances do carry ACLs with `admin_overrides: false`. Absence is never a denial:
if the verdict cannot be obtained, the section says `available: false` with a
reason, and an unknown field name lands in `unresolvedFields` rather than being
reported as read-only.

Two consequences worth knowing:

- `sn_create_record`, `sn_update_record`, `sn_batch_create` and `sn_batch_update`
  accept `preflightAccess: true`, which asks for that verdict first and refuses
  locally — with the verdict quoted — instead of discovering the denial as a 403
  (or as a 200 that persisted nothing). Off by default: it costs one round trip,
  and only an explicit `false` blocks. If the probe itself fails, the write
  proceeds exactly as before.
- `sn_diagnose_mutation` answers for a **different user**. It runs over the
  background-script transport, whose identity is `system` (admin + snc_internal),
  and it now reports that identity in `identity`. Same table, two answers:
  `sys_security_acl` is read-only for the API user and `RWCD` under the
  background script — so a green verdict there does not mean the write tools can
  perform the write.

### Execution & files
| Tool | What it does |
|---|---|
| `sn_execute_background_script` | Run server-side JavaScript; reports transport path/outcome and supports a JSON application-result contract |
| `sn_upload_attachment` / `sn_download_attachment` | Attach / fetch files (base64) |
| `sn_get_attachment_metadata` | List attachments on a record (name, type, size) **without** downloading content |

### Instances *(only when more than one instance is configured)*
| Tool | What it does |
|---|---|
| `sn_switch_default_instance` | Repoint the session default instance (for calls that omit `instance`) + connectivity probe; in-memory only, no YAML write |

### Fluent SDK bridge *(only when `now-sdk` is installed)*
| Tool | What it does |
|---|---|
| `sn_sdk_status` | now-sdk version + auth profiles, and whether the MCP and now-sdk point at the **same instance** |

### Beyond tools
- **Smarter errors** — bad field names are caught before the API call with "did
  you mean…?" hints; 403/404/field errors and empty results come back with
  recovery guidance, not a bare error.
- **Resources** — `servicenow://instances` and a `servicenow://schema/{table}`
  template, so the model can pull context by URI without spending a tool call.
- **Prompts** — canned workflows: `verify_fluent_deploy`, `diagnose_deploy_failure`,
  `investigate_incident`, `cmdb_health_overview`.

---

## How it works with now-sdk

The MCP and `now-sdk` are two halves of one loop. **Don't make one reinvent the
other.**

| Job | Use | Why |
|---|---|---|
| Read records | `now-sdk query` **or** `sn_query_records` | now-sdk query is already aligned to your deploy instance |
| Capture instance config → Fluent | **`now-sdk transform`** | Real XML→Fluent with relationships |
| Author metadata (tables, BRs, ACLs…) | **Fluent `*.now.ts`** + `now-sdk deploy` | Source-controlled; never POST metadata |
| Counts / group-by | **`sn_aggregate_records`** | now-sdk can't aggregate |
| Write / delete data rows | **`sn_create/update/delete_record`** | now-sdk only writes app metadata |
| Run a server-side script | **`sn_execute_background_script`** | now-sdk has no script execution |
| Confirm both target the same instance | **`sn_sdk_status`** | Avoids "deployed to dev, queried prod" |

### Read-path recovery with `now-sdk query`

`now-sdk query` authenticates through the CLI's own profile, not now-mcp's HTTP
client credentials. Treat it as the first read-only diagnostic path when
now-mcp authentication, transport, server, or circuit-breaker
failures make repeated MCP calls unproductive. `sn_query_records` does this
automatically when now-sdk >=4.8 is installed **and** an auth profile matches
the selected MCP instance host. Successful fallback responses report
`meta.source: "now-sdk-query"` and `meta.fallbackProfile`; the host check fails
closed so recovery cannot silently query another environment. Writes never
fall back to the CLI.

### Auto-pairing the instance
By default (`SERVICENOW_FOLLOW_NOW_SDK` on), the active instance follows whichever
profile `now-sdk auth --use` selected — matched by host — so the MCP and Fluent
always target the same instance. List each instance's credentials in the YAML
once; `now-sdk` is the single switch (reconnect the MCP after switching).
`now-sdk` keeps its password in the OS keychain, so the YAML still supplies
credentials. Set `SERVICENOW_FOLLOW_NOW_SDK=false` to pin the YAML `default`, and
use `sn_sdk_status` to check alignment.

### Fluent workflow rules (auto-injected)
When a project is a Fluent app (`now.config.json` at its root), a SessionStart
hook (`scripts/bootstrap-fluent-claudemd.mjs`) appends a standing **Fluent
workflow** block to that project's `CLAUDE.md`. Because `CLAUDE.md` is loaded
into every session's system prompt, these rules are always in force — no skill
trigger to miss. The block covers the division of labour above (author metadata &
capture & reads → `now-sdk`; aggregation, data writes, script execution → the
MCP) and the "always `now-sdk explain` before writing Fluent" rule. It's
idempotent (won't stomp your edits) and opt-out via `FLUENT_BOOTSTRAP_CLAUDEMD=off`.
The injected text is not hardcoded — it lives in an editable file
(`scripts/claude-md-template.md`), or point `FLUENT_WORKFLOW_TEMPLATE` at your own
markdown to maintain your team's rules.
The `verify_fluent_deploy` / `diagnose_deploy_failure` MCP **prompts** package the
post-deploy verify and failure-diagnosis steps on demand.

---

## Typical scenarios

**1. "How many P1 incidents per assignment group this week?"**
`sn_aggregate_records` with `groupBy: ["assignment_group"]` — one call,
numbers computed server-side, no row-dumping.

**2. Build a Fluent app and prove it works.**
Read schema with the MCP → write `*.now.ts` → `now-sdk deploy` (Bash) →
`sn_query_records` to confirm it landed →
`sn_execute_background_script` to trigger logic → read `syslog`.

### Background-script prerequisites and 404 troubleshooting

`sn_execute_background_script` supports two execution paths:

1. **Scripted REST (recommended):** set `scriptApiPath` on the instance to an installed,
   active resource. It must accept `POST { "script": "..." }` and return
   `{ "result": { "success": true|false, "output"?: string, "error"?: string } }`.
   `/api/x_custom/script_runner/execute` is only an example convention; now-mcp does
   not install that route. It must exist on every instance whose config selects it.
2. **`sys_trigger` fallback:** when `scriptApiPath` is omitted, now-mcp creates a temporary
   `sys_properties` mailbox through the Table API, creates a Run Once `sys_trigger`, polls
   the mailbox, and deletes it. The integration user needs create/read/delete access to
   `sys_properties`, create access to `sys_trigger`, and an active ServiceNow scheduler.

If ServiceNow reports **“Requested URI does not represent any resource”**, use the phase and
endpoint in the now-mcp error:

- `POST <scriptApiPath>`: the Scripted REST API is missing, inactive, scoped under another
  path, or unavailable to the user. Correct the path/install/activation/ACL; now-mcp
  does not silently switch transports. Remove `scriptApiPath` only when you intentionally
  want the `sys_trigger` implementation and its prerequisites. `allowWrites` cannot fix
  this transport error: it is an MCP acknowledgement, not a role grant or ACL bypass.
  Use `sn_connection_status` to see the selected transport without making an API call;
  use `sn_diagnose_mutation` before retrying a failed/aborted write.
- `POST /api/now/table/sys_properties` or `sys_trigger`: the fallback's protected system
  table is not exposed through the Table API or the user lacks access. Install/configure a
  Scripted REST runner instead, or explicitly grant the required least-privilege access.
- `GET /api/now/table/sys_properties/<sys_id>`: the mailbox was deleted or became unreadable
  after the trigger was created. Check ACLs and automation that removes temporary properties.

Validate setup first with a harmless script such as `gs.info('hello world')`; only then run
scripts that mutate data.

On the `sys_trigger` path, completed calls include
`runtimeContext.observedIdentity`, captured inside the scheduled job (bounded
user name/id, role list, and interactive flag). This is diagnostic evidence,
not proof that ACLs were bypassed or a write persisted. Scripted REST calls
report an observed identity only when the companion endpoint returns a
`runtimeIdentity` object.

**3. Reverse-engineer legacy config into source control.**
`now-sdk transform --table <t>` to capture to Fluent → MCP reads to verify
behavior matches after redeploy to dev.

**4. Investigate an incident.**
Query the incident, dot-walk to `caller_id.department.manager`, pull related CIs
and recent changes — all via `sn_query_records`.

**5. Multi-instance work.**
Keep dev write-enabled and prod read-only in one YAML. By default the MCP tracks
whichever instance now-sdk is pointed at; set `SERVICENOW_FOLLOW_NOW_SDK=false`
to pin the YAML's own `default` instead.

---

## Safety model

- **Read-only by default.** Every instance is read-only unless you explicitly set
  `readOnly: false`. Write tools return a clear `AccessDeniedError` otherwise.
- **Verified mutations.** `sn_update_record` and `sn_delete_records` reread state
  by default and fail when the requested mutation did not persist. Pass
  `verify: false` only when the caller explicitly accepts weaker assurance.
  Verification failures return `failureType: "mutation_not_persisted"` and
  recommend `sn_diagnose_mutation`. Delete verification is batched into a single
  extra request regardless of how many records were deleted, so a record the API
  claimed to delete but which still exists is reported as a **failure** rather
  than a success with a flag on it.
- **ACL-aware diagnosis.** `sn_diagnose_mutation` maps record update to the
  ServiceNow `write` ACL operation and inspects exact, inherited, field, and
  wildcard coverage. No visible effective ACL is reported as
  `missing_acl_coverage`; unreadable security metadata is reported as unknown,
  never incorrectly as absent. Its verdicts belong to the background-script
  identity it reports in `identity`, not to the API user — for that user's
  verdict use `effectiveAccess` on `sn_get_security_info`, or `preflightAccess`
  on the write. ACL remediation remains an app-definition change and should go
  through Fluent/source control rather than a bypass.
- **Two-step metadata approval.** Background scripts require `allowWrites: true`
  for data writes and the additional `allowMetadataWrites: true` break-glass
  approval for metadata/security/config tables such as `sys_security_acl`.
  Prefer Fluent source control for metadata.
- **Transport is not business success.** Background-script responses expose
  `transportSuccess`, `executionPath`, and `outcome`. With `resultMode: "json"`,
  make the final logged line `{"success":true|false,...}` (or `ok`) so an
  application-level false becomes an MCP error instead of a misleading success.
- **Table allow/deny lists.** `SERVICENOW_BLOCKED_TABLES` / `SERVICENOW_ALLOWED_TABLES`
  gate every table operation (data ops *and* schema discovery) — deny wins, an
  allow-list is exclusive when set, trailing-`*` wildcards supported.
- **Anti-lockout.** A per-instance rate limiter caps concurrency, and a circuit
  breaker stops calling an instance after repeated failures (faster on 401/403)
  to avoid tripping ServiceNow account/ACL lockout — it fails fast instead of
  retrying into a wall.
- **Write audit log.** Every POST/PUT/PATCH/DELETE is recorded (stderr, and to a
  JSON-lines file if `SERVICENOW_AUDIT_LOG` is set), and every tool call logs a
  structured `{tool, durationMs, ok}` line. The file is size-capped and rotated
  to `<path>.1` at 10 MiB (override with `SERVICENOW_AUDIT_LOG_MAX_BYTES`; set to
  `0` to disable rotation).
- **No credential magic.** Credentials live in your YAML / env, never read from
  now-sdk's keychain. Keep config files out of git (the provided `.gitignore`
  already excludes them).

---

## Development

<details>
<summary>Local development (working inside this repo)</summary>

The committed `.mcp.json` uses `${CLAUDE_PLUGIN_ROOT}`, so it's meant for the
plugin runtime, **not** for opening the repo directly. To hack on the server in
this checkout, build and register it at user scope pointing at your config:

```bash
git clone <REPO_URL>
cd foundry-suite/plugins/now-mcp
pnpm install
pnpm build
claude mcp add now-mcp -s user \
  --env SERVICENOW_CONFIG_PATH="$PWD/config/sn-credential.yaml" \
  -- node "$PWD/build/index.js"
```

Or run the source directly without building: `pnpm exec tsx src/index.ts`.
</details>
