# Original Vendor Playbook (source material)

Verbatim copy (figures/base64 images stripped) of the internal
"ServiceNow AI Agent A2A Authentication Playbook — Google Agent2Agent Protocol
Setup Guide" this skill was built from. Kept for citation and because its
architecture explanation (§1, §7.2) is accurate and worth keeping — **but its
step-by-step setup (§5–§9) has real gaps** that [../SKILL.md](../SKILL.md) and
[troubleshooting.md](troubleshooting.md) correct. Don't follow §5–§9 here
literally without cross-referencing the corrected Setup order in SKILL.md —
in particular, §7.3's "if it exists, verify Auth Scopes includes
a2aauthscope" step is necessary but **not sufficient**: the wizard populates
`oauth_entity_auth_scope_mapping` but not the classic `oauth_entity_scope`
table that `/oauth_token.do` actually checks (see troubleshooting #3).

Platform version at time of writing: Zurich Patch 4+ / Yokohama Patch 11+,
Now Assist AI Agents 6.0.x+, Google A2A v0.3.0.

---

## 1. Overview

The Agent2Agent (A2A) protocol, developed by Google, is an open standard that
enables AI agents built on different platforms to communicate with each other
using JSON-RPC over HTTP. It defines two key operations:

- **Agent Card Discovery (GET)**: external agents discover what a ServiceNow
  AI agent can do — capabilities, skills, supported auth schemes.
- **Agent Execution (POST)**: external agents send tasks to a ServiceNow AI
  agent and receive results via JSON-RPC.

**End-to-end flow:** Step 1 — Token Request: caller sends Client ID + Secret
to `/oauth_token.do`, receives a Bearer Token. Step 2 — Agent Card Discovery:
caller optionally calls `GET /api/sn_aia/a2a/id/{agent_id}/well_known/agent_json`
(no auth required by default). Step 3 — Agent Execution: caller calls
`POST /api/sn_aia/a2a/v2/agent/id/{agent_id}` with the Bearer Token; ServiceNow
validates the token and executes the AI Agent.

**Why OAuth:** the execution endpoint handles sensitive operations — querying
internal data, creating records, triggering workflows. OAuth provides identity
verification, scope control (`a2aauthscope` limits token usage to A2A
endpoints only), and token expiry.

**Why Agent Card discovery is public by default:** per the Google A2A 0.3.0
spec, the card is a "menu" meant to be publicly discoverable so agent
ecosystems can find agents without pre-registration. Security matters at the
execution endpoint, not discovery. (📌 to hide capabilities from external
parties, set `Requires Authentication = true` on the Agent Card endpoint —
this modifies a protected OOB record and may require ServiceNow Support.)

## 2. Prerequisites

- Platform: Yokohama Patch 11+ (Jan 2026) or Zurich Patch 4+ (Dec 2025).
- Now Assist AI Agents 6.0.x+ (Dec 2025).
- Verify via All > Application Manager > search "Now Assist AI Agents" >
  Installed tab.
- Tools: Postman (or any REST client), ServiceNow admin account, at least one
  active AI Agent in AI Agent Studio.

## 3. Enable External Agent Settings

- `sn_aia.external_agents.enabled = true` — ServiceNow calls out to external
  agents (primary/orchestrating side).
- `sn_aia.internal_agents.enabled_external = true` — external agents can call
  into ServiceNow AI Agents (secondary/invoked side — this is the one this
  skill sets up).
- Both live under AI Agent Studio > Settings.

## 4. Service Account Setup

A dedicated service account is recommended over reusing an admin account:
least privilege, resilience (integration doesn't break if an admin's password
changes), auditability. Suggested roles: `sn_aia.integration` (production
runtime), `sn_aia_admin` (testing only), `rest_service`,
`snc_platform_rest_api_access`. (📌 admin is acceptable for Postman testing
only — always use a scoped service account in production. This skill's Setup
order step 5 goes further: derive the role from what the specific agent
actually reads, rather than using a fixed role list.)

## 5. Select and Configure Your AI Agent

The A2A protocol uses the AI Agent's `sys_id` in the endpoint URL. In AI Agent
Studio > Create and manage > AI agents, select the agent, copy its `sys_id`,
ensure "Enable this AI agent for discovery" is ON (sets `External
discoverable = true` on the AI Agent Config record — without this the agent
won't appear in Agent Card responses), and confirm the agent's channel/status
is Active.

Endpoint URL pattern: `https://{instance}.service-now.com/api/sn_aia/a2a/v2/agent/id/{agent_sys_id}`

## 6. Configure Messaging Channel for Testing

A2A operates in two modes: asynchronous (production — response pushed to a
callback URL) and synchronous (required for Postman/most first-pass testing,
since a plain REST client has no callback). Go to Messaging Channels
[`sys_cs_channel`], personalize the list to show Synchronous, switch to the
Now Assist AI Agents application scope, find "AI Agent A2A Channel", set
`Synchronous = true`. (📌 for production, set up a callback URL in
[`sn_aia_ea_push_notification_url`] / External Agent Push Notification and
use async mode.)

## 7. Application Registry for OAuth

The Application Registry is ServiceNow's OAuth token issuer — who can get
tokens, how (grant type), and what scopes those tokens grant.

| Component | Role | Analogy |
|---|---|---|
| Application Registry | Token issuer | The key-making machine |
| Inbound Auth Profile | Token validator | The door guard checking the key |
| API Access Policy | Connects auth profiles to endpoints | Which doors use which guard |

Steps: System OAuth > Application Registry. Check if "A2A OAuth External
Agents" already exists as an OOB record; if so verify Active=true, Auth
Scopes includes `a2aauthscope`, Client ID/Secret populated. If not, New >
"Create an OAuth API endpoint for external clients", name it, add
`a2aauthscope` under Auth Scopes, save to auto-generate Client ID/Secret.

## 8. Inbound Authentication Profile

Tells ServiceNow which Application Registry (OAuth Entity) to use when
validating incoming tokens on the A2A API — without this link the system
can't verify the token's cryptographic signature (it's re-verified against
the Client Secret stored in the Application Registry the profile points to).

ServiceNow ships an OOB record "OAuth in External AIA for A2A" in the Now
Assist AI Agents scope — **this record is protected by a protection policy
and its OAuth Entity field is empty and read-only, even under
security_admin elevation.** A background script attempting to change
`sys_policy` fields on it fails with: *"The Protection policy field cannot be
changed for application Now Assist AI Agents."*

Since it can't be edited: create a **new** Inbound Authentication Profile
(System Web Services > API Access Policies > Inbound Authentication Profile >
New > "Create standard http authentication profiles"), Type: OAuth, OAuth
Entity: your Application Registry.

## 9. API Access Policy

Ties everything together — applies the Inbound Auth Profile to the A2A REST
API endpoints. ServiceNow ships "AI Agent A2A API Access Policy" pre-covering
`sn_aia/a2a`, with two OOB auth profiles already attached. Add your new
profile to this policy (switch to the Now Assist AI Agents scope via the globe
icon if the record is read-only). (📌 the doc notes the OOB profile "often
handles authentication correctly even without the OAuth Entity set
explicitly" and suggests testing before modifying — in practice, on the
instance this skill was built against, the OOB profile alone was not
sufficient; adding the new profile via `sys_auth_profile_mapping` was
necessary. Your mileage may vary by instance/patch level.)

## 10. Testing with Postman

**Step 1 — Agent Card (GET, no auth):**
`GET https://{instance}.service-now.com/api/sn_aia/a2a/id/{agent_sys_id}/well_known/agent_json`

**Step 2 — Get an OAuth Token:** new POST request, Authorization tab, OAuth
2.0, Grant Type: Authorization Code (or Resource Owner Password Credentials),
Auth URL `{instance}/oauth_auth.do`, Access Token URL `{instance}/oauth_token.do`,
Client ID/Secret from the Application Registry. Get New Access Token, log in
via the popup, Use Token.

**Step 3 — Execute (POST):**
`POST https://{instance}.service-now.com/api/sn_aia/a2a/v1/agent/id/{agent_sys_id}`
with the Bearer Token, `Content-Type: application/json`. Initial body:

```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "message/send",
  "params": {
    "message": {
      "messageId": "msg-001",
      "kind": "message",
      "role": "user",
      "parts": [{ "kind": "text", "text": "Hello, can you help me?" }]
    }
  }
}
```

To continue a conversation, include `contextId` and `taskId` from the
previous response in the next `message` object.

## 11. Interpreting A2A Responses

```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "result": {
    "kind": "task",
    "id": "task-sys-id",
    "contextId": "context-id",
    "status": { "state": "input-required", "message": { "..." : "..." } }
  }
}
```

Task states: `input-required` (waiting for more input — use contextId/taskId
to continue), `completed` (results may be in `artifacts[]`), `working`
(processing — poll `tasks/get` or wait for push notification), `failed`
(check the `error` field).

## 12. Troubleshooting (from the original doc)

| Error | Likely Cause | Resolution |
|---|---|---|
| 401 Unauthorized | Token not included or expired | Get a new access token, click Use Token |
| Invalid JSON-RPC Request (-32600) | Body empty or malformed | Raw JSON body, correct Content-Type |
| Message Id missing (-32602) | `messageId` missing | Add it inside the `message` object |
| Kind missing (-32602) | `kind` missing | Add `"kind": "message"` inside the `message` object |
| Protection policy read-only error | Editing OOB Now Assist AI Agents records | Create new records instead, or open a Support case |

Debug logging: `com.snc.platform.security.oauth.debug = true`,
`glide.auth.debug.enabled = true`. Flow Designer tracing (sub-prod only):
Flow Administration > Settings > Reporting=Trace, Logging=Debug. Key tables:
Execution Plan [`sn_aia_execution_plan`], External Agent Execution History
[`sn_aia_external_agent_exec_history`].

## 13. Reference

**Endpoint summary:**

| Method | Version | URL Pattern |
|---|---|---|
| GET | V1 | `/api/sn_aia/a2a/id/{agent_id}/well_known/agent_json` |
| GET | V2 | `/api/sn_aia/a2a/v2/agent_card/id/{agent_id}` |
| POST | V1 | `/api/sn_aia/a2a/v1/agent/id/{agent_id}` |
| POST | V2 | `/api/sn_aia/a2a/v2/agent/id/{agent_id}` |

**Navigation paths:** Application Settings → AI Agent Studio > Settings;
Application Registry → System OAuth > Application Registry; Inbound Auth
Profile → System Web Services > API Access Policies > Inbound Authentication
Profile; API Access Policy → System Web Services > API Access Policies > REST
API Access Policies; Messaging Channels → `sys_cs_channel` (table navigator);
AI Agents list → AI Agent Studio > Create and manage > AI agents; Background
Script → System Definition > Scripts - Background; System Properties → System
Properties (table navigator).

**Further reading:** ServiceNow Community — "Authentication for Google A2A -
ServiceNow as Secondary Agent"; ServiceNow Docs — Now Assist AI Agents A2A
Setup (Zurich); Google A2A Protocol Specification —
a2a-protocol.org/v0.3.0/specification.
