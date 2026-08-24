# A2A Setup — Bruno/Postman Isolation Test

On-demand reference for `/sn-aia-a2a-setup`. Before troubleshooting a
third-party connector (Copilot Studio, etc.), test the OAuth flow directly
against ServiceNow with a generic client. If this succeeds, the ServiceNow
side is fine and the problem is in the connector; if it fails identically,
you have a clean, connector-free repro to keep debugging against (see
[troubleshooting.md](troubleshooting.md) and
[diagnostic-queries.md](diagnostic-queries.md)).

Postman works the same way — the field names below are Bruno's `.bru` schema,
but the concepts (grant type, authorization/token URLs, client id/secret,
scope, redirect/callback URL) map 1:1 onto Postman's OAuth 2.0 auth tab.

## Collection layout

```
a2a-test/
  bruno.json
  environments/
    Demo.bru
  1-agent-card-no-auth.bru
  2-get-token-and-test.bru
  3-execute-agent.bru
```

`bruno.json`:
```json
{ "version": "1", "name": "SN A2A Test", "type": "collection", "ignore": ["node_modules", ".git"] }
```

`environments/Demo.bru` — fill in `base_url`/`agent_id`/`client_id` as plain
vars; put `client_secret` in the `vars:secret` block so it isn't stored in
plaintext in the file:
```
vars {
  base_url: https://{instance}.service-now.com
  agent_id: {agent_sys_id}
  client_id: {oauth_entity.client_id}
}

vars:secret [
  client_secret
]
```

## Request 1 — Agent Card, no auth (confirms discovery + CORS-free access)

```
meta { name: 1 - Agent Card (no auth); type: http; seq: 1 }
get {
  url: {{base_url}}/api/sn_aia/a2a/v2/agent_card/id/{{agent_id}}
  body: none
  auth: none
}
```

## Request 2 — full OAuth round trip (Authorization Code)

**Known Bruno gotcha:** variable interpolation (`{{base_url}}`) inside the
`auth:oauth2` block is unreliable in some Bruno versions — if you get "invalid
url" errors here but request 1 (plain URL, no auth block) worked fine with
the same variables, hardcode the literal URLs inside the `auth:oauth2` block
instead of using `{{base_url}}`. `client_secret` as a var reference is
generally fine; if the token exchange fails oddly, paste the literal secret
into the file directly as a first isolation step, then move it back to a
secret var once the flow is confirmed working.

```
meta { name: 2 - Get Token (Auth Code) + Test Card; type: http; seq: 2 }
get {
  url: {{base_url}}/api/sn_aia/a2a/v2/agent_card/id/{{agent_id}}
  body: none
  auth: oauth2
}
auth:oauth2 {
  grant_type: authorization_code
  callback_url: http://localhost:8080/callback
  authorization_url: https://{instance}.service-now.com/oauth_auth.do
  access_token_url: https://{instance}.service-now.com/oauth_token.do
  client_id: {oauth_entity.client_id}
  client_secret: {{client_secret}}
  scope: a2aauthscope
  state: bruno-test-1
  pkce: false
  credentials_placement: body
  token_placement: header
  token_header_prefix: Bearer
  auto_fetch_token: true
  auto_refresh_token: false
}
```

Click **Send** (not just save) — Bruno pops a browser window for the
ServiceNow login + consent page, then exchanges the resulting code for a
token automatically.

**Before this will work at all:** the `oauth_entity.redirect_url` for the app
you're testing must match `callback_url` above **exactly**
(`http://localhost:8080/callback`). If the app's real `redirect_url` is
already set to a production caller's callback (e.g. Copilot Studio's Azure
APIM redirect), **temporarily change it for this test and change it back
afterward** — don't leave a test app's redirect pointed at localhost, and
don't leave a production app's redirect pointed at localhost either. State
both the temporary change and the revert explicitly when doing this; it's a
real (if brief) config change to a live app registration.

## Request 3 — execute the agent (JSON-RPC over the token from request 2)

```
meta { name: 3 - Execute Agent (POST); type: http; seq: 3 }
post {
  url: {{base_url}}/api/sn_aia/a2a/v2/agent/id/{{agent_id}}
  body: json
  auth: oauth2
}
headers { Content-Type: application/json }
body:json {
  {
    "jsonrpc": "2.0",
    "id": "1",
    "method": "message/send",
    "params": {
      "message": {
        "messageId": "msg-001",
        "kind": "message",
        "role": "user",
        "parts": [{ "kind": "text", "text": "{your test prompt here}" }]
      }
    }
  }
}
auth:oauth2 {
  ... same block as request 2 ...
}
```

If this 400s with `-32602 Push Notification URL is required for asynchronous
requests`, that's the `sys_cs_channel` sync/async setting, not an OAuth
problem — see troubleshooting #7.

## Reading the result

| Bruno result | Meaning |
|---|---|
| Request 2 succeeds, returns the Agent Card | Full OAuth round trip works server-side. If the real caller still fails, the problem is client-side (troubleshooting #6/#8/#9) — stop editing ServiceNow config. |
| Request 2 fails with the same error the real caller shows | Confirmed server-side — keep working through [troubleshooting.md](troubleshooting.md). |
| Request 3 succeeds after request 2 succeeded | End-to-end proven. Any remaining real-caller failure is 100% on that caller's side. |
