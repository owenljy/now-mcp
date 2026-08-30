/**
 * Action (state-mutating) tool script template — KNOWN-GOOD shape for ServiceNow AI Agent
 * Rhino runtime. Use this for tools that WRITE to a record: case work-note, handoff, ticket
 * update, comment, etc.
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
 *   - DO    use GlideRecordSecure with canWrite() / canCreate() gates (P0 Security Directive).
 *   - DO    return a value on EVERY path — never fall through to undefined.
 *   - DO    SOFT-FAIL when context is missing (see "WHY SOFT-FAIL" below).
 *   - DON'T use import / export / require — they throw or silently return undefined at runtime.
 *   - DON'T add a tsc/dist build step — Now.include() is fs.readFileSync(), not a compiler.
 *   - DON'T use CRUD tools for journal fields (work_notes, comments, activity_stream) — those
 *     are write-only via GlideRecordSecure + setValue; CRUD tools strip them.
 *
 * WHY SOFT-FAIL (see docs/tool-output-patterns.md — Pattern 4):
 * Action tools get invoked in contexts where the target record may not exist — Agent Studio
 * Manual Test attaches no case, standalone API invocation may pass an empty sys_id, a test
 * harness may omit the field entirely. Returning `{ success: false, error: 'NOT_FOUND' }`
 * makes the agent's Step 8 error path fire and derails the user-facing flow over an audit-
 * trail miss that doesn't matter. The handoff intent is recorded by the conversation log
 * regardless of whether the case-side write succeeded. So:
 *
 *   - Missing context  → return { success: true, note: '<why we skipped>' }    (soft-fail)
 *   - Record not found → return { success: true, note: '<why we skipped>' }    (soft-fail)
 *   - No write perm    → return { success: true, note: '<why we skipped>' }    (soft-fail)
 *   - Genuine data corruption risk → return { __error_code: '...' }            (hard-fail; rare)
 *
 * Examples that should NEVER soft-fail: "charge customer's credit card" — if customerId is
 * missing, hard-fail. Use judgment: would a silent skip leave the system in a bad state?
 *
 * DRY-RUN GUARD vs SOFT-FAIL (different concepts — see docs/tool-output-patterns.md →
 * "Run-level terminal outcomes"):
 *   - soft-fail  → *missing context* (no caseSysId) forces a skip; passive.
 *   - dry-run    → a config switch (gs.getProperty('<scope>.dry_run')) intentionally skips
 *                  ONLY the irreversible write, after the whole real path has run. This makes
 *                  the tool eval-safe and demoable offline. The return carries `dryRun: true`
 *                  so it can never be read as a real success (derived outcome dry_run_success).
 *
 * The guard below is opt-in: delete it if this tool has no irreversible effect.
 *
 * `inputs` is injected by the runtime. The schema below assumes a target record sys_id
 * (e.g. `caseSysId`) plus the write payload.
 */
(function (inputs) {
    // ---- inline helpers -----------------------------------------------------
    function isEmpty(v) {
        return v === undefined || v === null || String(v).length === 0;
    }

    // ---- soft-fail on missing context ---------------------------------------
    // === ADAPT: name of the sys_id field your tool takes ===
    var caseSysId = inputs.caseSysId;
    // =====================================================
    if (isEmpty(caseSysId)) {
        return { success: true, note: 'No caseSysId provided — write skipped' };
    }

    // ---- resolve target record ----------------------------------------------
    // === ADAPT: target table for your action ===
    var targetTable = 'sn_customerservice_case';
    // ===========================================
    var gr = new GlideRecordSecure(targetTable); // GlideRecordSecure, never plain GlideRecord (P0)
    if (!gr.get(caseSysId)) {
        return { success: true, note: 'CASE_NOT_FOUND — write skipped', caseSysId: caseSysId };
    }
    if (!gr.canWrite()) {
        return { success: true, note: 'NO_WRITE_PERMISSION — write skipped', caseSysId: caseSysId };
    }

    // ---- opt-in dry-run guard (remove if this tool has no irreversible effect) ----
    // Runs the real code path above (connection/record/permission checks all executed);
    // skips ONLY the mutation below. Read from a system property so an admin can flip it
    // with no rebuild. NOTE: <scope> is the FULL scoped app name incl. the x_ prefix
    // (e.g. 'x_acme_foo.dry_run') — do NOT write 'x_<scope>...', that double-prefixes.
    // (optional) put any audit/bookkeeping write ABOVE this guard so it runs even in
    // dry-run — the guard skips only the *consequential* effect, not *all* writes.
    // Return shape (dryRun flag → derived run outcome dry_run_success): see
    // docs/tool-output-patterns.md → "Run-level terminal outcomes".
    if (gs.getProperty('<scope>.dry_run') === 'true') {
        return { success: true, dryRun: true, note: 'dry-run — mutation skipped', caseSysId: caseSysId }; // rename caseSysId to your tool's id field
    }
    // -------------------------------------------------------------------------------

    // ---- perform the mutation ----------------------------------------------
    // === ADAPT: which fields to set + the payload validation ===
    // Journal fields (work_notes, comments) are write-only — setValue appends an entry,
    // not overwrites. For other fields, validate inputs first before setValue.
    if (!isEmpty(inputs.workNote)) {
        gr.setValue('work_notes', inputs.workNote);
    }
    // gr.setValue('state', 'transferred');
    // gr.setValue('assignment_group', '<live-agent-queue-sys-id>');
    // ===========================================================
    gr.update();

    // ---- always return a structured success ---------------------------------
    return {
        success: true,
        caseSysId: caseSysId,
        // include any other fields the agent's instructions reference downstream
    };
})(inputs); // ← IIFE invoked: the value of this expression IS the tool output
