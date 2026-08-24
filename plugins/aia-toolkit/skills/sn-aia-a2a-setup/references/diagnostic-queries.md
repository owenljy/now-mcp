# A2A Setup — Diagnostic Queries

On-demand reference for `/sn-aia-a2a-setup`. The client-side error for every
failure mode in [troubleshooting.md](troubleshooting.md) is generic, wrapped,
or outright wrong (`access_denied`/`server_error` for what's actually
`invalid_scope`; a 401 that's actually a missing token, not bad credentials).
These two tables carry the real signal. Run via whatever resolves the
`run_privileged_script` capability (see [../SKILL.md](../SKILL.md)); direct
table reads on `syslog`/`syslog_transaction` also work if the connected
capability allows it.

## `syslog_transaction` — did the request even reach the instance?

This is the fastest way to split "ServiceNow rejected it" from "the request
never arrived" (CORS, wrong URL, client-side crash before send). Filter on the
API path and read `http_response_code`, `remote_ip`, and `user_agent`:

```js
var gr = new GlideRecordSecure('syslog_transaction');
gr.addQuery('url', 'CONTAINS', 'a2a');          // or 'oauth_' for the OAuth dance
gr.orderByDesc('sys_created_on');
gr.setLimit(15);
gr.query();
var out = [];
while (gr.next()) {
  out.push(gr.getValue('sys_created_on') + ' | ' + gr.getValue('http_response_code')
    + ' | remote_ip=' + gr.getValue('remote_ip')
    + ' | ua=' + gr.getValue('user_agent')
    + ' | ' + gr.getValue('url'));
}
gs.info(JSON.stringify(out, null, 1));
```

Reading the output:
- **A browser `user_agent` (Mozilla/Chrome/Safari) hitting a discovery URL** at
  the moment the caller's UI showed a connect/validate error, with
  `http_response_code: 200` → CORS. The server answered fine; the browser
  discarded the response. See troubleshooting #1.
- **Nothing shows up at all** for the moment the caller reported an error →
  the request never left the caller (client-side failure, e.g. it errored out
  before making the call at all — check the caller's own console/logs, not
  ServiceNow's).
- **A repeating 3-hop pattern** on `oauth_auth.do` (`scope=...` →
  `oauth_auth_check_action=authorize` → `scope=...&logoutfirst=false` →
  repeat) with no forward progress → redirect loop, usually Safari ITP. See
  troubleshooting #8.
- **Exactly one `oauth_token.do` hit, no matching prior `oauth_auth.do`** →
  something's using a cached/stale authorization code, or you're testing the
  wrong grant type's endpoint.

## `syslog` — the real OAuth/server error, not the client-facing wrapper

The internal OAuth engine logs its real error class before the response gets
wrapped into whatever generic shape the client sees:

```js
var gr = new GlideRecordSecure('syslog');
gr.addQuery('sys_created_on', '>=', gs.hoursAgoStart(1));
gr.addQuery('message', 'CONTAINS', 'token flow');   // also try: 'a2a', 'oauth'
gr.orderByDesc('sys_created_on');
gr.setLimit(10);
gr.query();
var out = [];
while (gr.next()) {
  out.push(gr.getValue('sys_created_on') + ' | ' + gr.getValue('message'));
}
gs.info(JSON.stringify(out, null, 1));
```

`Exception on token flow - invalid_scope: ...` here, while the client only
ever shows `{"error":"server_error","error_description":"access_denied"}`, is
exactly the case in troubleshooting #3/#4 — the client wrapper doesn't
surface the real OAuth error code at all.

**Don't chase every log line near the timestamp as if it's related.** A
same-second, unrelated async business-rule error (e.g. an unrelated
`RhinoEcmaError` from a Mosaic-metadata-sync rule on `oauth_credential`,
`when: async_always`) is a coincidence of timing, not causation — check the
rule's `when`/`collection` before assuming it's in the failure's call chain.
If it's `async_always` on a different table than what you're debugging, it's
noise.

## Correlating the two

Pull both around the exact timestamp the caller reported an error (use a
tight ±2 minute window, both instance clock and caller UI are usually close
enough), and read them together: `syslog_transaction` tells you *whether* the
request arrived and what HTTP status went back; `syslog` tells you *why*, when
the transaction log's status code alone doesn't explain the client's error.

## When both logs look clean but the caller still fails

Test the exact same OAuth flow yourself, outside the caller entirely — see
[bruno-isolation-test.md](bruno-isolation-test.md). If that succeeds with
identical client_id/secret/scope, the problem has moved to the caller's side
(see troubleshooting #6, #8, #9) and no further ServiceNow-side log digging
will find it.
