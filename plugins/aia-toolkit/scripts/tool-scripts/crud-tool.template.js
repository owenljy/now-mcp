/**
 * CRUD tool script template — KNOWN-GOOD shape for the ServiceNow AI Agent Rhino runtime.
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
 *   - DO    inline every helper.
 *   - DO    reference platform globals (GlideRecordSecure, RESTMessageV2, gs, sn_cc, sn_ws) directly.
 *   - DO    return a value on EVERY path — never fall through to undefined.
 *   - DON'T use import / export / require — they throw or silently return undefined at runtime.
 *   - DON'T add a tsc/dist build step — Now.include() is fs.readFileSync(), not a compiler.
 *
 * `inputs` is injected by the runtime. For a crud tool it carries `crudInputs` (pre-defined —
 * never prompt the user for it) plus any fields declared in the tool's input_schema.
 */
(function (inputs) {
    // ---- inline helpers -----------------------------------------------------
    // Parse a {{placeholder}} encoded query against the input fields.
    function parseQuery(template, values) {
        return String(template || '').replace(/\{\{(\w+)\}\}/g, function (_, key) {
            return values[key] != null ? values[key] : '';
        });
    }

    // ---- resolve crud inputs ------------------------------------------------
    var crud = inputs.crudInputs || {};
    var table = crud.table;
    if (!table) {
        return { status: 'error', message: 'crudInputs.table is required' };
    }

    var gr = new GlideRecordSecure(table); // GlideRecordSecure, never plain GlideRecord (P0)
    if (!gr.canRead()) {
        return { status: 'error', message: 'Not authorized to read ' + table };
    }

    var encodedQuery = parseQuery(crud.query, inputs);
    if (encodedQuery) {
        gr.addEncodedQuery(encodedQuery);
    }
    gr.setLimit(crud.limit ? parseInt(crud.limit, 10) : 50);
    gr.query();

    // ---- collect whitelisted fields ----------------------------------------
    // Only return fields the section whitelists — never raw sys_ids or full records.
    var returnFields = (crud.returnFields || '').split(',').map(function (f) {
        return f.trim();
    }).filter(Boolean);

    var records = [];
    while (gr.next()) {
        var row = {};
        returnFields.forEach(function (field) {
            row[field] = gr.getDisplayValue(field);
        });
        records.push(row);
    }

    // ---- always return a structured result ----------------------------------
    return {
        status: 'success',
        count: records.length,
        records: records,
    };
})(inputs); // ← IIFE invoked: the value of this expression IS the tool output
