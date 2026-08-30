# Trace Analyzer — Background Script Fallbacks

On-demand reference for `/sn-aia-trace-analyzer`. These are the **MCP-not-authenticated
fallback scripts** — every diagnostic step in the skill prefers a `sn_query_records`
MCP call; only reach for the matching script below when MCP isn't available. Paste each in
**Scripts > Background** (Global scope).

> **Plain `GlideRecord`, not `GlideRecordSecure`, is intentional here.** These are read-only
> diagnostics run interactively by an admin — they need to see all trace records regardless of
> ACLs. This is the opposite of the deployed tool-script rule (`GlideRecordSecure`
> for deployed tool scripts because those run as the agent's user). Do not "fix" these scripts
> to `GlideRecordSecure` — that would hide records you need to see.

> **Logging: use `gs.info(...)`, not `gs.print(...)`.** These scripts intentionally use `gs.info`
> for output. `gs.print` is a global-scope-only API — in a scoped Script Include or scoped
> background script it is blocked (calls fail or are silently swallowed). Default to `gs.info` in
> any scoped context; its output appears in **System Logs → System Log (syslog)**, not the
> background-script result panel. (In Global scope both work, but `gs.info` keeps these scripts
> copy-paste-safe if someone runs them inside an application scope.)

---

## Option B — Find a recent execution plan

```js
// Paste in Scripts > Background (Global scope)
// Find recent execution plans — adjust the filter as needed
(function() {
    var gr = new GlideRecord('sn_aia_execution_plan');
    // Optional: filter by objective keyword
    // gr.addQuery('objective', 'CONTAINS', '<keyword>');
    gr.orderByDesc('sys_created_on');
    gr.setLimit(10);
    gr.query();

    var plans = [];
    while (gr.next()) {
        plans.push({
            sys_id: gr.getUniqueValue(),
            objective: gr.getValue('objective'),
            state: gr.getValue('state'),
            state_reason: gr.getValue('state_reason'),
            run_type: gr.getValue('run_type'),
            execution_time_ms: gr.getValue('execution_time_ms'),
            start_time: gr.getValue('start_time'),
            end_time: gr.getValue('end_time'),
        });
    }
    gs.info('=== RECENT EXECUTION PLANS ===\n' + JSON.stringify(plans, null, 2));
})();
```

---

## Option C — Trigger a new test run

```js
// Launch AI Agent conversation and return the execution plan ID
(function() {
    var USECASE_ID = '<usecase_sys_id>';
    var OBJECTIVE = '<user_objective>';
    var TARGET_RECORD_ID = '<optional_record_sys_id>';
    var TARGET_TABLE = '<optional_table_name>';

    var adminGr = new GlideRecord('sys_user');
    adminGr.addQuery('user_name', 'admin');
    adminGr.setLimit(1);
    adminGr.query();
    var adminId = adminGr.next()
        ? adminGr.getValue('sys_id')
        : '6816f79cc0a8016401c5a33be04be441';

    var util = new sn_aia.AiAgentRuntimeUtil();
    var result = util.startAiAgentConversation({
        usecaseId: USECASE_ID,
        objective: OBJECTIVE,
        conversationUser: adminId,
        conversationLabel: 'Trace analysis test — ' + new GlideDateTime().getValue(),
        targetRecordId: TARGET_RECORD_ID || '',
        targetTable: TARGET_TABLE || '',
        canInteractWithUser: false,
        sessionId: gs.generateGUID(),
    });

    if (result.status !== 'success') {
        gs.error('Launch failed: ' + JSON.stringify(result));
        return;
    }

    var planId = result.data.executionPlanId;
    gs.info('=== AGENT LAUNCHED ===');
    gs.info('Execution Plan ID: ' + planId);
    gs.info('Conversation ID: ' + result.data.conversationId);

    // Poll for completion (max 180s)
    var maxWaitMs = 180000;
    var startTime = new GlideDateTime().getNumericValue();
    while (true) {
        var now = new GlideDateTime().getNumericValue();
        if (now - startTime > maxWaitMs) {
            gs.info('TIMEOUT — agent still running after 180s');
            break;
        }
        var checkGr = new GlideRecord('sn_aia_execution_plan');
        checkGr.get(planId);
        var state = checkGr.getValue('state');
        if (state === 'completed' || state === 'terminated') {
            gs.info('DONE — state: ' + state + ', reason: ' + checkGr.getValue('state_reason'));
            break;
        }
        if (state === 'gatherData') {
            gs.info('WARN — agent paused in gatherData (needs user input)');
            break;
        }
        GlideSystem.sleep(500);
    }

    gs.info('Execution Plan sys_id for analysis: ' + planId);
})();
```

> **Prerequisites for triggering a run:**
> - `sn_aia` (nowassist-ai-agents) >= 7.1.8
> - Agent usecase deployed and active
> - LLM connection configured and active
> - AIS status Green/ACTIVE (check `<instance>/xmlstats.do?include=ais`)

---

## Step 1 — Execution Plan Overview

```js
(function() {
    var planId = '<plan_sys_id>';
    var gr = new GlideRecord('sn_aia_execution_plan');
    if (!gr.get(planId)) { gs.info('Plan not found: ' + planId); return; }
    gs.info('=== EXECUTION PLAN ===');
    gs.info('Objective: ' + gr.getValue('objective'));
    gs.info('State: ' + gr.getValue('state'));
    gs.info('State Reason: ' + gr.getValue('state_reason'));
    gs.info('Run Type: ' + gr.getValue('run_type'));
    gs.info('Execution Time (ms): ' + gr.getValue('execution_time_ms'));
    gs.info('LLM P95 Latency: ' + gr.getValue('llm_p95_latency'));
    gs.info('Tool P95 Latency: ' + gr.getValue('tool_p95_latency'));
    gs.info('LLM Token Avg: ' + gr.getValue('llm_token_avg'));
    gs.info('Start: ' + gr.getValue('start_time'));
    gs.info('End: ' + gr.getValue('end_time'));
})();
```

---

## Step 2 — Walk the Execution Task Tree

```js
(function() {
    var planId = '<plan_sys_id>';
    var gr = new GlideRecord('sn_aia_execution_task');
    gr.addQuery('execution_plan', planId);
    gr.orderBy('order');
    gr.query();

    gs.info('=== EXECUTION TASKS (' + gr.getRowCount() + ' total) ===');
    var tasks = [];
    while (gr.next()) {
        var task = {
            order: gr.getValue('order'),
            type: gr.getValue('type'),
            status: gr.getValue('status'),
            description: (gr.getValue('description') || '').substring(0, 200),
            target_table: gr.getValue('target_document_table'),  // identifies agent/tool task target
            target_id: gr.getValue('target_document_id'),
            parent: gr.getValue('parent'),
        };
        tasks.push(task);

        // Flag errors
        if (gr.getValue('status') === 'error') {
            gs.info('>>> ERROR at order ' + task.order + ': ' + task.type +
                ' | ' + task.description);
        }
    }
    gs.info(JSON.stringify(tasks, null, 2));
})();
```

---

## Step 3 — Inspect Tool Executions

```js
(function() {
    var planId = '<plan_sys_id>';
    var gr = new GlideRecord('sn_aia_tools_execution');
    gr.addQuery('execution_plan_id', planId);
    gr.query();

    gs.info('=== TOOL EXECUTIONS (' + gr.getRowCount() + ' total) ===');
    while (gr.next()) {
        gs.info('--- Tool: ' + gr.getDisplayValue('tool') + ' ---');
        gs.info('Status: ' + gr.getValue('execution_status'));
        gs.info('Mode: ' + gr.getValue('execution_mode'));
        gs.info('Error: ' + (gr.getValue('error_message') || 'none'));
        gs.info('Time (ms): ' + gr.getValue('execution_time_ms'));
        gs.info('Run As: ' + gr.getValue('run_as_user'));
        gs.info('Request: ' + (gr.getValue('request') || '').substring(0, 500));
        gs.info('Response: ' + (gr.getValue('response') || '').substring(0, 500));
    }
})();
```

---

## Step 4 — Inspect LLM Logs

```js
(function() {
    var planId = '<plan_sys_id>';

    // Get the plan's time window
    var planGr = new GlideRecord('sn_aia_execution_plan');
    if (!planGr.get(planId)) { gs.info('Plan not found'); return; }
    var startTime = planGr.getValue('start_time');
    var endTime = planGr.getValue('end_time') || new GlideDateTime().getValue();

    var gr = new GlideRecord('sys_generative_ai_log');
    gr.addQuery('sys_created_on', '>=', startTime);
    gr.addQuery('sys_created_on', '<=', endTime);
    gr.orderBy('sys_created_on');
    gr.query();

    gs.info('=== LLM LOGS (' + gr.getRowCount() + ' in time window) ===');
    var totalPromptTokens = 0, totalResponseTokens = 0, totalTimeTaken = 0;
    while (gr.next()) {
        var errorCode = gr.getValue('error_code') || '';
        var error = gr.getValue('error') || '';
        var timeTaken = parseInt(gr.getValue('time_taken') || '0', 10);
        var promptTokens = parseInt(gr.getValue('prompt_token_count') || '0', 10);
        var responseTokens = parseInt(gr.getValue('response_token_count') || '0', 10);

        totalPromptTokens += promptTokens;
        totalResponseTokens += responseTokens;
        totalTimeTaken += timeTaken;

        gs.info('--- LLM Call: ' + gr.getUniqueValue() + ' ---');
        gs.info('Definition: ' + (gr.getDisplayValue('definition') || gr.getValue('definition')));
        gs.info('Time Taken (ms): ' + timeTaken);
        gs.info('Tokens: ' + promptTokens + ' prompt / ' + responseTokens + ' response');
        if (errorCode) gs.info('ERROR CODE: ' + errorCode);
        if (error) gs.info('Error: ' + error);
        gs.info('Prompt (first 1000 chars): ' + (gr.getValue('prompt') || '').substring(0, 1000));
        gs.info('Response (first 1000 chars): ' + (gr.getValue('response') || '').substring(0, 1000));
    }
    gs.info('=== TOTALS: ' + totalTimeTaken + 'ms LLM time | ' +
        totalPromptTokens + ' prompt tokens | ' + totalResponseTokens + ' response tokens ===');
})();
```

---

## Step 5 — Check AIA Messages

```js
(function() {
    var planId = '<plan_sys_id>';
    var gr = new GlideRecord('sn_aia_message');
    gr.addQuery('execution_plan', planId);
    gr.orderBy('sys_created_on');
    gr.query();

    gs.info('=== AIA MESSAGES (' + gr.getRowCount() + ' total) ===');
    while (gr.next()) {
        gs.info('[' + gr.getValue('role') + '] ' + gr.getValue('name') +
            ': ' + (gr.getValue('message') || '').substring(0, 500));
    }
})();
```

---

## Step 6 — Check Platform Errors (Syslog)

```js
(function() {
    var planId = '<plan_sys_id>';

    // Get time window
    var planGr = new GlideRecord('sn_aia_execution_plan');
    if (!planGr.get(planId)) { gs.info('Plan not found'); return; }
    var startTime = planGr.getValue('start_time');
    var endTime = planGr.getValue('end_time') || new GlideDateTime().getValue();

    // Errors mentioning this plan
    var gr = new GlideRecord('syslog');
    gr.addQuery('source', 'STARTSWITH', 'sn_aia');
    gr.addQuery('level', '0');  // errors only
    gr.addQuery('sys_created_on', '>=', startTime);
    gr.addQuery('sys_created_on', '<=', endTime);
    gr.orderBy('sys_created_on');
    gr.query();

    gs.info('=== SYSLOG ERRORS (' + gr.getRowCount() + ' in time window) ===');
    while (gr.next()) {
        gs.info('[' + gr.getValue('source') + '] ' +
            (gr.getValue('message') || '').substring(0, 500));
    }
})();
```

---

## Step 7 — Performance Analysis

```js
(function() {
    var planId = '<plan_sys_id>';
    var gr = new GlideRecord('sn_aia_perf_event');
    gr.addQuery('execution_plan', planId);
    gr.orderByDesc('duration_ms');
    gr.query();

    gs.info('=== PERFORMANCE EVENTS (sorted by duration) ===');
    var totalMs = 0;
    var byCategory = {};
    while (gr.next()) {
        var durationMs = parseInt(gr.getValue('duration_ms') || '0', 10);
        var category = gr.getValue('event_category') || 'unknown';
        totalMs += durationMs;
        byCategory[category] = (byCategory[category] || 0) + durationMs;
        gs.info(category + ' | ' +
            durationMs + 'ms | seq=' + gr.getValue('sequence') +
            ' | ' + (gr.getValue('description') || '').substring(0, 200));
    }
    gs.info('=== BREAKDOWN BY CATEGORY ===');
    for (var cat in byCategory) {
        gs.info('  ' + cat + ': ' + byCategory[cat] + 'ms (' +
            Math.round(byCategory[cat] / totalMs * 100) + '%)');
    }
    gs.info('Total span time: ' + totalMs + 'ms');
})();
```

---

## System Health — Check System Properties

```js
(function() {
    var props = [
        'sn_aia.enable_perf_logs',
        'sn_aia.enable_conversational_debugger',
        'sn_aia.enable_episodic_memory',
        'sn_aia.episodic_memory_limit',
    ];
    for (var i = 0; i < props.length; i++) {
        gs.info(props[i] + ' = ' + gs.getProperty(props[i], '(not set)'));
    }
})();
```

---

## All-in-One — Comprehensive Collection Script

When MCP is not available, give the user this single script that collects everything (plan,
tasks, tool executions, LLM logs, messages, performance events, syslog errors, feedback) for a
given execution plan in one pass, plus a computed summary (performance breakdown, token usage,
phantom-success detection, top slowest spans).

```js
// =============================================================================
// AI Agent Trace Analyzer — All-in-One Collection Script (Enhanced)
// Paste in Scripts > Background (Global scope)
// =============================================================================
(function() {
    var PLAN_ID = '<execution_plan_sys_id>';
    var report = {
        plan: null, tasks: [], tools: [], llmLogs: [], messages: [],
        perfEvents: [], syslogErrors: [], feedback: [],
        metrics: { llmTimeMs: 0, toolTimeMs: 0, promptTokens: 0, responseTokens: 0,
                   llmCalls: 0, toolCalls: 0, reactIterations: 0, errorCodes: [] }
    };

    // 1. Execution Plan
    var planGr = new GlideRecord('sn_aia_execution_plan');
    if (!planGr.get(PLAN_ID)) {
        gs.info('ERROR: Execution plan not found: ' + PLAN_ID);
        return;
    }
    report.plan = {
        sys_id: planGr.getUniqueValue(),
        objective: planGr.getValue('objective'),
        state: planGr.getValue('state'),
        state_reason: planGr.getValue('state_reason'),
        run_type: planGr.getValue('run_type'),
        execution_time_ms: planGr.getValue('execution_time_ms'),
        start_time: planGr.getValue('start_time'),
        end_time: planGr.getValue('end_time'),
        llm_p95_latency: planGr.getValue('llm_p95_latency'),
        tool_p95_latency: planGr.getValue('tool_p95_latency'),
        llm_token_avg: planGr.getValue('llm_token_avg'),
    };
    var startTime = planGr.getValue('start_time');
    var endTime = planGr.getValue('end_time') || new GlideDateTime().getValue();

    // 2. Execution Tasks
    var taskGr = new GlideRecord('sn_aia_execution_task');
    taskGr.addQuery('execution_plan', PLAN_ID);
    taskGr.orderBy('order');
    taskGr.query();
    while (taskGr.next()) {
        var taskType = taskGr.getValue('type');
        if (taskType === 'gen_ai') report.metrics.reactIterations++;
        report.tasks.push({
            order: taskGr.getValue('order'),
            type: taskType,
            status: taskGr.getValue('status'),
            description: (taskGr.getValue('description') || '').substring(0, 300),
            target_table: taskGr.getValue('target_document_table'),  // identifies agent/tool task target
            target_id: taskGr.getValue('target_document_id'),
            parent: taskGr.getValue('parent'),
            output_preview: (taskGr.getValue('output') || '').substring(0, 500),
        });
    }

    // 3. Tool Executions
    var toolGr = new GlideRecord('sn_aia_tools_execution');
    toolGr.addQuery('execution_plan_id', PLAN_ID);
    toolGr.query();
    while (toolGr.next()) {
        var toolTimeMs = parseInt(toolGr.getValue('execution_time_ms') || '0', 10);
        report.metrics.toolTimeMs += toolTimeMs;
        report.metrics.toolCalls++;
        report.tools.push({
            tool: toolGr.getDisplayValue('tool'),
            execution_status: toolGr.getValue('execution_status'),
            execution_mode: toolGr.getValue('execution_mode'),
            error_message: toolGr.getValue('error_message') || '',
            execution_time_ms: toolTimeMs,
            request_preview: (toolGr.getValue('request') || '').substring(0, 500),
            response_preview: (toolGr.getValue('response') || '').substring(0, 500),
        });
    }

    // 4. AIA Messages
    var msgGr = new GlideRecord('sn_aia_message');
    msgGr.addQuery('execution_plan', PLAN_ID);
    msgGr.orderBy('sys_created_on');
    msgGr.query();
    while (msgGr.next()) {
        report.messages.push({
            role: msgGr.getValue('role'),
            name: msgGr.getValue('name'),
            message_preview: (msgGr.getValue('message') || '').substring(0, 500),
        });
    }

    // 5. Performance Events
    var perfGr = new GlideRecord('sn_aia_perf_event');
    perfGr.addQuery('execution_plan', PLAN_ID);
    perfGr.orderByDesc('duration_ms');
    perfGr.query();
    var perfByCategory = {};
    while (perfGr.next()) {
        var cat = perfGr.getValue('event_category') || 'unknown';
        var dur = parseInt(perfGr.getValue('duration_ms') || '0', 10);
        perfByCategory[cat] = (perfByCategory[cat] || 0) + dur;
        report.perfEvents.push({
            event_category: cat,
            duration_ms: dur,
            sequence: perfGr.getValue('sequence'),
        });
    }

    // 6. Syslog Errors
    var logGr = new GlideRecord('syslog');
    logGr.addQuery('source', 'STARTSWITH', 'sn_aia');
    logGr.addQuery('level', '0');
    logGr.addQuery('sys_created_on', '>=', startTime);
    logGr.addQuery('sys_created_on', '<=', endTime);
    logGr.orderBy('sys_created_on');
    logGr.setLimit(20);
    logGr.query();
    while (logGr.next()) {
        report.syslogErrors.push({
            source: logGr.getValue('source'),
            message: (logGr.getValue('message') || '').substring(0, 500),
            created: logGr.getValue('sys_created_on'),
        });
    }

    // 7. Feedback
    var fbGr = new GlideRecord('sn_aia_execution_feedback');
    fbGr.addQuery('execution_plan', PLAN_ID);
    fbGr.query();
    while (fbGr.next()) {
        report.feedback.push({
            rating: fbGr.getValue('rating'),
            feedback_text: fbGr.getValue('feedback_text'),
        });
    }

    // 8. LLM Logs (by time window — no direct FK to execution plan)
    var llmGr = new GlideRecord('sys_generative_ai_log');
    llmGr.addQuery('sys_created_on', '>=', startTime);
    llmGr.addQuery('sys_created_on', '<=', endTime);
    llmGr.orderBy('sys_created_on');
    llmGr.setLimit(20);
    llmGr.query();
    while (llmGr.next()) {
        var timeTaken = parseInt(llmGr.getValue('time_taken') || '0', 10);
        var promptTokens = parseInt(llmGr.getValue('prompt_token_count') || '0', 10);
        var responseTokens = parseInt(llmGr.getValue('response_token_count') || '0', 10);
        var errorCode = llmGr.getValue('error_code') || '';

        report.metrics.llmTimeMs += timeTaken;
        report.metrics.llmCalls++;
        report.metrics.promptTokens += promptTokens;
        report.metrics.responseTokens += responseTokens;
        if (errorCode) report.metrics.errorCodes.push(errorCode);

        report.llmLogs.push({
            definition: llmGr.getDisplayValue('definition') || llmGr.getValue('definition'),
            time_taken: timeTaken,
            prompt_tokens: promptTokens,
            response_tokens: responseTokens,
            error: llmGr.getValue('error') || '',
            error_code: errorCode,
            prompt_preview: (llmGr.getValue('prompt') || '').substring(0, 1000),
            response_preview: (llmGr.getValue('response') || '').substring(0, 1000),
        });
    }

    // Compute derived metrics
    var execTimeMs = parseInt(report.plan.execution_time_ms || '0', 10);
    report.metrics.orchestrationOverheadMs = Math.max(0,
        execTimeMs - report.metrics.llmTimeMs - report.metrics.toolTimeMs);
    report.metrics.avgTokensPerCall = report.metrics.llmCalls > 0
        ? Math.round((report.metrics.promptTokens + report.metrics.responseTokens) / report.metrics.llmCalls)
        : 0;

    // ===================== SUMMARY =====================
    gs.info('=== TRACE ANALYSIS REPORT ===');
    gs.info('Plan: ' + report.plan.state + ' (' + (report.plan.state_reason || 'n/a') + ')');
    gs.info('Execution Time: ' + execTimeMs + 'ms');

    // Performance breakdown
    gs.info('--- PERFORMANCE BREAKDOWN ---');
    gs.info('LLM Time: ' + report.metrics.llmTimeMs + 'ms (' +
        (execTimeMs > 0 ? Math.round(report.metrics.llmTimeMs / execTimeMs * 100) : 0) + '%)');
    gs.info('Tool Time: ' + report.metrics.toolTimeMs + 'ms (' +
        (execTimeMs > 0 ? Math.round(report.metrics.toolTimeMs / execTimeMs * 100) : 0) + '%)');
    gs.info('Orchestration Overhead: ' + report.metrics.orchestrationOverheadMs + 'ms (' +
        (execTimeMs > 0 ? Math.round(report.metrics.orchestrationOverheadMs / execTimeMs * 100) : 0) + '%)');

    // Counts
    gs.info('--- COUNTS ---');
    gs.info('Tasks: ' + report.tasks.length + ' | ReAct Iterations: ' + report.metrics.reactIterations);
    gs.info('Tool Calls: ' + report.metrics.toolCalls + ' | LLM Calls: ' + report.metrics.llmCalls);
    gs.info('Messages: ' + report.messages.length);
    gs.info('Perf Events: ' + report.perfEvents.length);
    gs.info('Syslog Errors: ' + report.syslogErrors.length);

    // Token usage
    gs.info('--- TOKEN USAGE ---');
    gs.info('Prompt Tokens: ' + report.metrics.promptTokens +
        ' | Response Tokens: ' + report.metrics.responseTokens +
        ' | Avg per Call: ' + report.metrics.avgTokensPerCall);

    // GAIC Error Codes
    if (report.metrics.errorCodes.length > 0) {
        gs.info('>>> GAIC ERROR CODES DETECTED: ' + report.metrics.errorCodes.join(', '));
    }

    // Error tasks
    var errorTasks = report.tasks.filter(function(t) { return t.status === 'error'; });
    if (errorTasks.length > 0) {
        gs.info('>>> ERROR TASKS: ' + errorTasks.length);
        for (var i = 0; i < errorTasks.length; i++) {
            gs.info('  [' + errorTasks[i].order + '] ' + errorTasks[i].type + ': ' + errorTasks[i].description);
        }
    }

    // Failed tools
    var failedTools = report.tools.filter(function(t) { return t.error_message; });
    if (failedTools.length > 0) {
        gs.info('>>> FAILED TOOLS: ' + failedTools.length);
        for (var j = 0; j < failedTools.length; j++) {
            gs.info('  ' + failedTools[j].tool + ': ' + failedTools[j].error_message);
        }
    }

    // Phantom-success tools: status=completed but empty/undefined response
    var phantomTools = report.tools.filter(function(t) {
        if (t.execution_status !== 'completed') return false;
        var r = (t.response_preview || '').trim();
        return r === '' || r === 'undefined' || r === 'null' || r === '{}';
    });
    if (phantomTools.length > 0) {
        gs.info('>>> PHANTOM SUCCESS (completed but no data — check tool script returns a value): ' + phantomTools.length);
        for (var p = 0; p < phantomTools.length; p++) {
            gs.info('  ' + phantomTools[p].tool + ' | response="' + phantomTools[p].response_preview + '"');
        }
    }

    // Top 3 slowest spans
    if (report.perfEvents.length > 0) {
        gs.info('>>> TOP 3 SLOWEST SPANS:');
        for (var k = 0; k < Math.min(3, report.perfEvents.length); k++) {
            gs.info('  ' + report.perfEvents[k].event_category + ': ' + report.perfEvents[k].duration_ms + 'ms');
        }
    }

    // Perf breakdown by category
    if (Object.keys(perfByCategory).length > 0) {
        gs.info('>>> PERF BY CATEGORY:');
        for (var pc in perfByCategory) {
            gs.info('  ' + pc + ': ' + perfByCategory[pc] + 'ms');
        }
    }

    gs.info('=== FULL REPORT ===');
    gs.info(JSON.stringify(report, null, 2));
})();
```
