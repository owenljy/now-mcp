/**
 * REST tool script template — KNOWN-GOOD shape for an external HTTP API call from the
 * ServiceNow AI Agent Rhino runtime.
 *
 * Copy this into src/server/agents/<agent>/tool-scripts/<tool-name>.js and adapt the marked
 * spots. Then reference it from the tool's fluent record:
 *
 *   script: Now.include('../../../../server/agents/<agent>/tool-scripts/<tool-name>.js'),
 *
 * The tool .now.ts lives at src/fluent/agent/ai-agent-<agent>/tools/ (five segments deep), so four
 * ../ hops land inside src/ and the path resumes at server/... with NO redundant src/ segment.
 * A leading ../../../../src/server/... would resolve to src/src/server/... and fail scan check [10].
 *
 * WHY THIS SHAPE (read the agent-builder SKILL.md runtime-contract section):
 * the script is stored as a STRING in sn_aia_tool.script and eval'd by a Rhino sandbox — NOT
 * Node.js. There is no module system.
 *   - DO    wrap everything in an IIFE; the last expression is the tool's return value.
 *   - DO    inline every helper (connection lookup, REST execution, envelope unwrap).
 *   - DO    reference platform globals (GlideRecordSecure, RESTMessageV2, gs, sn_cc, sn_ws) directly.
 *   - DO    return a value on EVERY path — never fall through to undefined.
 *   - DO    surface failures as `{ __error_code, __error_message }` so the agent's Step 8 fires.
 *   - DON'T use import / export / require — they throw or silently return undefined at runtime.
 *   - DON'T add a tsc/dist build step — Now.include() is fs.readFileSync(), not a compiler.
 *
 * OPT-IN TESTABILITY SEAMS (see docs/tool-output-patterns.md — "Run-level terminal outcomes"):
 *   - mock-endpoint branch (top): if gs.getProperty('<scope>.mock_endpoint') is set, return
 *     { success: true, mock: true, ... } without any real call — eval-safe / offline.
 *   - dry-run guard (before the call): for a MUTATING method (POST/PUT/PATCH/DELETE) with
 *     gs.getProperty('<scope>.dry_run') === 'true', skip only the real call and return
 *     { success: true, dryRun: true, ... }. Both are removable when the tool is read-only.
 *     <scope> is the FULL scoped app name incl. the x_ prefix — never write 'x_<scope>'.
 *
 * WHY ENVELOPE UNWRAP (see docs/tool-output-patterns.md — Pattern 1):
 * many APIs wrap responses in `{ success, data, error }`. The LLM should see flat fields
 * (`customer_id`, `plan_name`) and not have to navigate `.data.customer_id`. Unwrap before
 * returning; map vendor error codes to `__error_code` so the agent's Step 8 error contract
 * (scoped to `__error_code` presence — NOT `success: false`) fires correctly.
 *
 * `inputs` is injected by the runtime. The schema below assumes `connectionSysId` (the
 * sys_id of an http_connection record carrying the vendor URL + credential) plus any other
 * fields declared in the tool's input_schema.
 */
(function (inputs) {
    // ---- opt-in mock-endpoint branch (remove if this tool has no external call) ------
    // Offline/eval mode: short-circuit BEFORE touching the real connection or API, so a
    // mock needs no real connection (lowest fidelity — skips connection/credential lookup
    // entirely; move this block below resolveConnection if you want that lookup exercised).
    // <scope> is the FULL scoped app name incl. x_ (e.g. 'x_acme_foo.mock_endpoint').
    // Return shape (mock flag → derived run outcome mock_success): see
    // docs/tool-output-patterns.md → "Run-level terminal outcomes".
    if (gs.getProperty('<scope>.mock_endpoint')) {
        return { success: true, mock: true, note: 'mock endpoint — real call skipped' };
    }
    // ----------------------------------------------------------------------------------

    // ---- inline helpers -----------------------------------------------------
    // Resolve an http_connection record and pull its endpoint URL + credential metadata.
    // Returns either { endpoint, apiKey, headerName } OR an __error_code object — never throws.
    function resolveConnection(connectionSysId) {
        if (!connectionSysId) {
            return { __error_code: 'CONNECTION_NOT_FOUND', __error_message: 'connectionSysId is required' };
        }
        var gr = new GlideRecordSecure('http_connection'); // GlideRecordSecure, never plain GlideRecord (P0)
        if (!gr.canRead() || !gr.get(connectionSysId)) {
            return {
                __error_code: 'CONNECTION_NOT_FOUND',
                __error_message: 'http_connection ' + connectionSysId + ' not readable or not found',
            };
        }
        var endpoint = (gr.getValue('connection_url') || '').replace(/\/$/, '');
        var credentialId = gr.getValue('credential') || '';
        var credProvider = new sn_cc.StandardCredentialsProvider();
        var credential = credProvider.getCredentialByID(credentialId);
        return {
            endpoint: endpoint,
            apiKey: credential ? (credential.getAttribute('api_key') || '') : '',
            headerName: credential ? (credential.getAttribute('header') || 'X-API-Key') : 'X-API-Key',
        };
    }

    // Execute a REST call and unwrap the response envelope. Returns either flat `data`
    // on success OR an __error_code object on any failure path.
    function executeAndUnwrap(method, url, headers, queryParams, body) {
        var request = new sn_ws.RESTMessageV2();
        request.setHttpMethod(method);
        request.setEndpoint(url);
        Object.keys(headers || {}).forEach(function (k) {
            request.setRequestHeader(k, headers[k]);
        });
        // Use setQueryParameter — never append to URL; ServiceNow rejects URLs with un-escaped specials
        // even when percent-encoded.
        Object.keys(queryParams || {}).forEach(function (k) {
            request.setQueryParameter(k, queryParams[k]);
        });
        if (body) {
            request.setRequestBody(typeof body === 'string' ? body : JSON.stringify(body));
        }

        var response = request.execute();
        var status = response.getStatusCode();
        var rawBody = response.getBody() || '';

        if (status >= 400) {
            return { __error_code: 'HTTP_' + status, __error_message: 'API_ERROR_' + status, __raw_body: rawBody };
        }
        var parsed;
        try {
            parsed = JSON.parse(rawBody);
        } catch (e) {
            return { __error_code: 'PARSE_ERROR', __error_message: 'Response body was not JSON', __raw_body: rawBody };
        }

        // Envelope unwrap: many vendor APIs use { success: bool, data: ..., error: { code, message } }.
        // Flatten so the LLM sees data fields directly, or surface __error_code on failure.
        if (parsed && typeof parsed === 'object' && 'success' in parsed) {
            if (parsed.success === true) {
                return parsed.data === undefined || parsed.data === null ? {} : parsed.data;
            }
            if (parsed.success === false && parsed.error) {
                return {
                    __error_code: parsed.error.code || 'UNKNOWN_ERROR',
                    __error_message: parsed.error.message || '',
                };
            }
        }
        // No recognizable envelope — return the parsed body verbatim.
        return parsed;
    }

    // ---- resolve connection -------------------------------------------------
    var conn = resolveConnection(inputs.connectionSysId);
    if (conn.__error_code) {
        return conn; // surface CONNECTION_NOT_FOUND directly
    }

    // ---- build + execute the request ----------------------------------------
    // === ADAPT THESE FOR YOUR API ===
    var path = '/api/v1/your-endpoint';                                  // ← vendor path
    var method = 'GET';                                                  // ← vendor method
    var queryParams = {
        // your_param: inputs.yourParam,                                 // ← per-call query params
    };
    var requestBody = null;                                              // ← POST/PUT body if any
    // ================================

    var headers = { Accept: 'application/json' };
    headers[conn.headerName] = conn.apiKey;

    // ---- opt-in dry-run guard (activates ONLY for mutating HTTP methods) -------------
    // Dead-inert in this shipped GET template; activates once `method` is a mutating verb.
    // Runs connection resolution + request build above; skips only the real mutating call.
    // <scope> is the FULL scoped app name incl. x_ (e.g. 'x_acme_foo.dry_run').
    if (/^(POST|PUT|PATCH|DELETE)$/.test(method) && gs.getProperty('<scope>.dry_run') === 'true') {
        return { success: true, dryRun: true, note: 'dry-run — HTTP ' + method + ' skipped' };
    }
    // ----------------------------------------------------------------------------------

    return executeAndUnwrap(method, conn.endpoint + path, headers, queryParams, requestBody);
})(inputs); // ← IIFE invoked: the value of this expression IS the tool output
