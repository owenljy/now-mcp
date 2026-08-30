---
name: sn-aia-agent-audit
description: Audits existing ServiceNow AI agents against best practices — checks for plain GlideRecord usage, missing max_auto_executions, wrong enums, oversized tool counts, missing processing messages, and reserved tool names. Use to validate agents before deployment or review agents already on an instance. Trigger on phrases like "audit agent", "check agent quality", "agent best practices", "validate agent", "agent health check", "review agent config".
---

# ServiceNow AI Agent Audit

Audits existing AI agents against the deployment guardrails and best practices — catches blockers before they cause runtime failures.

> **Prerequisite — check before proceeding:** This skill queries a live ServiceNow instance to inspect agent records, resolving the `read_records` capability against whatever MCP is connected (see [../../references/mcp-capability-resolution.md](../../references/mcp-capability-resolution.md)). If no matching tool is found, **tell the user explicitly** ("No ServiceNow MCP connected — I'll give you a background script to run manually instead") before switching to the background-script fallback. It can also audit local fluent files if you point it at a directory, which needs neither MCP nor now-sdk.

---

## Audit Modes

| Mode | When to use | How it works |
|---|---|---|
| **Instance audit (MCP)** | Agent is deployed — check live records | Resolves `read_records` and queries `sn_aia_*` tables via whatever tool matches |
| **Instance audit (scripts)** | Agent is deployed, no matching tool connected | Background script the user runs in Scripts > Background |
| **Local audit** | Agent is in fluent files, not yet deployed | Reads `.now.ts` files and server scripts in the repo |

---

## Step 1: Identify the Target

Use the current request and conversation to identify the target. If they already name an agent, sys_id, "all", or a Fluent directory, use it and skip the question below.

Otherwise ask: **What would you like to audit?** (one at a time)

1. **A specific agent** — provide the agent name or sys_id
2. **All agents on the instance** — scans every agent (may be slow on large instances)
3. **Local fluent files** — provide the path to the agent's fluent directory (e.g. `src/fluent/agent/ai-agent-my-helper/`)

If auditing a specific agent, ask: **Name or sys_id?**

---

## Step 2: Fetch Agent Data

### Instance audit — resolve `read_records`

Resolve the `read_records` capability (see
[../../references/mcp-capability-resolution.md](../../references/mcp-capability-resolution.md))
and run these queries **in parallel**. Params below (`tableName` string,
`query` encoded string, `fields` **array**, `limit`) are the illustrative
shape from the `servicenow` MCP's `sn_query_records` tool — adapt to
whichever tool actually resolves.

> **Column names are the DB columns, not the typed-API param names.** The MCP hits
> the Table API directly, so query the real `sn_aia_*` columns
> (`pre_message`/`post_message`, `version_name`/`version_number`), **not** the
> `AiAgent()` camelCase params (`preMessage`/`postMessage`). Verified against the
> live schema via `now-sdk query <table>`; re-confirm with `now-sdk explain
> aiagent-api` when the SDK version changes.

**2a. Agent record(s):**
```
sn_query_records
  tableName: sn_aia_agent
  query: name=<agent name>    (or sys_id=<sys_id>, or omit for all agents)
  fields: ["sys_id","name","description","instructions","role","processing_message","post_processing_message","record_type","sys_scope"]
  limit: 50
```

**2b. Tool mappings for the agent(s):**
```
sn_query_records
  tableName: sn_aia_agent_tool_m2m
  query: agent=<agent_sys_id>    (or omit for all)
  fields: ["sys_id","agent","tool","description","execution_mode","max_auto_executions","pre_message","post_message","display_output","output_transformation_strategy","tool_attributes"]
  limit: 100
```

**2c. Tool details:**
```
sn_query_records
  tableName: sn_aia_tool
  query: sys_idIN<comma-separated tool sys_ids from 2b>
  fields: ["sys_id","name","description","type","script","input_schema","target_document_table"]
  limit: 100
```

**2d. Version state:**
```
sn_query_records
  tableName: sn_aia_version
  query: target_id=<agent_sys_id>^target_table=sn_aia_agent
  fields: ["sys_id","state","target_id","version_name","version_number"]
  limit: 5
```

**2e. Usecase / workflow check:**
```
sn_query_records
  tableName: sn_aia_usecase
  query: sys_idIN<usecase_sys_ids if known>
  fields: ["sys_id","name","execution_mode","team","sys_scope"]
  limit: 10
```

### Instance audit — no matching tool found

Give the user this background script:

```js
// Paste in Scripts > Background (Global scope)
// Replace AGENT_NAME with the agent name, or remove the filter to scan all
(function() {
    var AGENT_NAME = '<agent name>';  // set to '' to scan all agents
    var results = { agents: [], findings: [] };

    var agentGr = new GlideRecord('sn_aia_agent');
    if (AGENT_NAME) {
        agentGr.addQuery('name', AGENT_NAME);
    }
    agentGr.query();

    while (agentGr.next()) {
        var agentId = agentGr.getUniqueValue();
        var agentName = agentGr.getValue('name');
        var agentInfo = {
            sys_id: agentId,
            name: agentName,
            description: agentGr.getValue('description'),
            processing_message: agentGr.getValue('processing_message'),
            post_processing_message: agentGr.getValue('post_processing_message'),
            record_type: agentGr.getValue('record_type'),
            role: agentGr.getValue('role'),
            tool_count: 0,
            tools: []
        };

        // Get tool mappings
        var m2m = new GlideRecord('sn_aia_agent_tool_m2m');
        m2m.addQuery('agent', agentId);
        m2m.query();

        while (m2m.next()) {
            agentInfo.tool_count++;
            var toolId = m2m.getValue('tool');
            var toolInfo = {
                m2m_sys_id: m2m.getUniqueValue(),
                tool_sys_id: toolId,
                execution_mode: m2m.getValue('execution_mode'),
                max_auto_executions: m2m.getValue('max_auto_executions'),
                pre_message: m2m.getValue('pre_message'),
                post_message: m2m.getValue('post_message'),
                tool_attributes: m2m.getValue('tool_attributes')
            };

            // Get tool details
            var toolGr = new GlideRecord('sn_aia_tool');
            if (toolGr.get(toolId)) {
                toolInfo.name = toolGr.getValue('name');
                toolInfo.type = toolGr.getValue('type');
                toolInfo.script = toolGr.getValue('script');
            }

            agentInfo.tools.push(toolInfo);

            // --- CHECKS ---

            // Check: missing max_auto_executions
            if (!m2m.getValue('max_auto_executions')) {
                results.findings.push({
                    agent: agentName,
                    check: 'missing_max_auto_executions',
                    severity: 'BLOCKER',
                    detail: 'M2M record ' + m2m.getUniqueValue() + ' for tool ' + (toolInfo.name || toolId) + ' has no max_auto_executions',
                    fix: "Set max_auto_executions to '10'"
                });
            }

            // Check: missing pre_message/post_message
            if (!m2m.getValue('pre_message') || !m2m.getValue('post_message')) {
                results.findings.push({
                    agent: agentName,
                    check: 'missing_tool_messages',
                    severity: 'BLOCKER',
                    detail: 'M2M record for tool ' + (toolInfo.name || toolId) + ' missing preMessage or postMessage',
                    fix: 'Add context-appropriate preMessage and postMessage'
                });
            }

            // Check: wrong execution_mode enum
            var validModes = ['autopilot', 'copilot'];
            if (m2m.getValue('execution_mode') && validModes.indexOf(m2m.getValue('execution_mode')) === -1) {
                results.findings.push({
                    agent: agentName,
                    check: 'wrong_execution_mode',
                    severity: 'BLOCKER',
                    detail: 'Tool ' + (toolInfo.name || toolId) + ' has execution_mode "' + m2m.getValue('execution_mode') + '"',
                    fix: 'Use "autopilot" or "copilot" — not "automatic" or "manual"'
                });
            }

            // Check: plain GlideRecord in script tools
            if (toolGr.getValue('script') && toolGr.getValue('script').indexOf('new GlideRecord(') > -1) {
                results.findings.push({
                    agent: agentName,
                    check: 'plain_gliderecord',
                    severity: 'BLOCKER',
                    detail: 'Tool ' + (toolInfo.name || toolId) + ' uses plain GlideRecord instead of GlideRecordSecure',
                    fix: 'Replace all GlideRecord with GlideRecordSecure and add canRead()/canWrite() gates'
                });
            }

            // Check: reserved tool names
            var reserved = ['Organize_general_knowledge', 'Math', 'Fallback', 'Finish', 'Join',
                'Generate_content', 'Check_with_other_agents', 'Communicator_agent',
                'Content analysis', 'User input', 'User output'];
            if (reserved.indexOf(toolInfo.name) > -1) {
                results.findings.push({
                    agent: agentName,
                    check: 'reserved_tool_name',
                    severity: 'BLOCKER',
                    detail: 'Tool "' + toolInfo.name + '" uses a reserved platform name',
                    fix: 'Rename the tool to avoid orchestrator confusion'
                });
            }
        }

        // Check: missing processing messages on agent
        if (!agentGr.getValue('processing_message') || !agentGr.getValue('post_processing_message')) {
            results.findings.push({
                agent: agentName,
                check: 'missing_agent_messages',
                severity: 'BLOCKER',
                detail: 'Agent missing processing_message or post_processing_message',
                fix: 'Add context-appropriate processing messages'
            });
        }

        // Check: wrong record_type enum
        var validRecordTypes = ['custom', 'template'];
        if (agentGr.getValue('record_type') && validRecordTypes.indexOf(agentGr.getValue('record_type')) === -1) {
            results.findings.push({
                agent: agentName,
                check: 'wrong_record_type',
                severity: 'BLOCKER',
                detail: 'Agent has record_type "' + agentGr.getValue('record_type') + '"',
                fix: 'Use "custom" (user-created) or "template" (system) — not "standard"'
            });
        }

        // Check: >15 tools
        if (agentInfo.tool_count > 15) {
            results.findings.push({
                agent: agentName,
                check: 'oversized_agent',
                severity: 'WARNING',
                detail: 'Agent has ' + agentInfo.tool_count + ' tools (max recommended: 15)',
                fix: 'Split into separate specialized agents with 3-5 tools each'
            });
        }

        // Check: marketing prose in role
        var role = agentGr.getValue('role') || '';
        var marketingPatterns = ['friendly, helpful', 'empathetic', 'best possible experience', 'happy to assist'];
        for (var p = 0; p < marketingPatterns.length; p++) {
            if (role.toLowerCase().indexOf(marketingPatterns[p]) > -1) {
                results.findings.push({
                    agent: agentName,
                    check: 'marketing_prose',
                    severity: 'WARNING',
                    detail: 'Agent role contains "' + marketingPatterns[p] + '" — wastes tokens',
                    fix: 'Remove marketing language. Use factual role description: "You are an expert X agent specializing in Y"'
                });
                break;
            }
        }

        results.agents.push(agentInfo);
    }

    gs.info('=== AGENT AUDIT === ' + JSON.stringify(results, null, 2));
})();
```

Ask the user to paste the output back so you can present the findings.

### Local audit

Read all `.now.ts` files and `.ts`/`.js` server scripts in the provided directory. Apply the same checks against the file contents:

1. Search for `new GlideRecord(` in server scripts (should be `GlideRecordSecure`)
2. Check M2M files for `max_auto_executions` property
3. Check M2M files for `preMessage` and `postMessage`
4. Check agent file for `processing_message` and `post_processing_message`
5. Check tool names against the reserved list
6. Check enum values: `recordType`, `executionMode`, `state`
7. Count tools — warn if >15
8. Check for marketing prose in role/instructions
9. If the agent has a mutating/deploy tool, check its instructions declare an independent verify step before success (cross-ref **W8**)
10. Check the instructions define an `escalated`/handoff terminal outcome for genuinely-stuck runs (cross-ref **W9**)
11. Check server scripts for hardcoded customer/environment values — endpoint URLs or non-hex config (thresholds, MID/group names) outside the connection helper (cross-ref **W10**; the hardcoded-hex case is scan check [12])
12. Check each state-mutating script tool has a config-driven dry-run/mock guard (cross-ref **W11**)

---

## Step 3: Run Checks

Apply all checks from the checklist below. For instance audits, the checks run against MCP query results. For local audits, they run against file contents.

### Blocker Checks (deployment will fail or cause runtime errors)

> **Source authority:** B1 (GlideRecordSecure) is enforced by the [P0 Agentic Security Directive](https://buildtools1.service-now.com/kb_view.do?sys_kb_id=13916f0493862250591c34a86cba10da). W1 (agent sizing) and W6 (RULES preamble) come from the [AI Agents Prompting Guide](https://servicenow.sharepoint.com/sites/PlatformEnablement/Shared%20Documents/00_Products/Now%20Assist/AI%20Agents/AI%20Agents%20Prompting%20Guide.pdf). Token governance guidance from the [AI Agent & LLM Token Best Practices KB](https://buildtools1.service-now.com/kb_view.do?sys_kb_id=5bba0716973fb69c877bf737f053af7c) (Mark Griffin / AI ARB).

| # | Check | What to look for | Fix |
|---|---|---|---|
| B1 | **Plain GlideRecord (P0 Security Directive)** | `new GlideRecord(` in tool scripts | Replace with `GlideRecordSecure`. Add `canRead()`/`canWrite()`/`canCreate()` gates. |
| B2 | **Missing max_auto_executions** | M2M records without `max_auto_executions` set | Set to `'10'` (string). Omitting allows runaway loops. |
| B3 | **Wrong recordType** | `recordType: 'standard'` | Use `'custom'` (user-created) or `'template'` (system). |
| B4 | **Wrong executionMode** | `execution_mode: 'automatic'` or `'manual'` | Use `'autopilot'` or `'copilot'`. |
| B5 | **Wrong state** | `state: 'active'` or `'inactive'` | Use `'published'`, `'draft'`, or `'withdrawn'`. |
| B6 | **Missing processing messages** | Agent record without `processing_message` or `post_processing_message` | Add context-appropriate messages based on agent purpose. |
| B7 | **Missing tool messages** | M2M record without `preMessage` or `postMessage` | Add messages describing what the tool is doing. |
| B8 | **Reserved tool names** | Tool named: `Organize_general_knowledge`, `Math`, `Fallback`, `Finish`, `Join`, `Generate_content`, `Check_with_other_agents`, `Communicator_agent`, `Content analysis`, `User input`, `User output` | Rename the tool. |
| B9 | **Non-unique names** | Agent or workflow name that duplicates an existing record across `sn_aia_agent` and `sn_aia_usecase` tables | Rename to be unique. |
| B10 | **Hand-rolled structure instead of typed API** (local audit only) | `Record({ table: 'sn_aia_agent' \| 'sn_aia_agent_config' \| 'sn_aia_version' \| 'sn_aia_tool' \| 'sn_aia_agent_tool_m2m' \| 'sn_aia_usecase' \| 'sn_aia_team' \| 'sn_aia_team_member' })` in `*.now.ts` | Re-emit via `AiAgent()` / `AiAgenticWorkflow()` — these auto-generate those records with correct relationships/defaults. Only keep `Record()` for a confirmed gap (see the builder's emitter "Gap policy"). Enforces builder rule A1. |
| B11 | **Hardcoded sys_id in agent structure** (local audit only) | A 32-char hex literal (`/[0-9a-f]{32}/`) anywhere in an `sn_aia_*` agent/workflow `*.now.ts` — e.g. a `strategy`, role, or type sys_id | Reference by name (`dataAccess.roleMap` / `securityAcl.roles` take names) or by JS variable; let now-sdk resolve it. Hardcoded sys_ids break across instances/releases with no type check. Enforces builder rule A2. |

### Warning Checks (won't block deployment but indicate quality issues)

| # | Check | What to look for | Fix |
|---|---|---|---|
| W1 | **Oversized agent** | Agent has >15 tools | Split into separate specialized agents (3-5 tools each). |
| W2 | **Marketing prose** | Role or instructions contain: "friendly, helpful", "empathetic", "best possible experience", "happy to assist" | Remove. Use factual descriptions. |
| W3 | **Journal fields via CRUD** | CRUD tool targeting `work_notes`, `comments`, or `activity_stream` columns | Use Script tool with `GlideRecordSecure` instead. |
| W4 | **Mixed placeholder styles** | File uses both `$variable`, `{{variable}}`, and `{VARIABLE}` styles | Pick one style (prefer `<angle_bracket>`) and enforce consistently. |
| W5 | **Wrong property names** | `versions` instead of `versionDetails` (agents), `runAs` instead of `runAsUser` (agents), `memory_scope` instead of `memoryScope` | Use correct camelCase property names per the common hallucinations table. |
| W6 | **Missing RULES preamble** | Agent instructions don't start with RULE 1-7 block | Add the standard RULES preamble from the prompting best practices. |
| W7 | **No published version** | No `sn_aia_version` record with `state: 'published'` for this agent | Run `/sn-eval-runner-builder` (Phase 0.1) to publish. |
| W8 | **State-mutating agent without an independent verify step** | Agent has a mutating/deploy tool (writes a record, deploys, calls an external write API) but its instructions declare no `# Verify` step before success | Add a `# Verify` step (independent read of the mutation's end-state; inconclusive-on-read-error → re-check/escalate). See builder instructions template. |
| W9 | **No honest terminal/escalate branch** | Instructions never define an `escalated`/handoff terminal outcome — a genuinely-stuck run has no labeled exit | Add an explicit escalate branch (`# Outcome`) that hands off to a named queue with the full trail. See [../../references/tool-output-patterns.md → Run-level terminal outcomes](../../references/tool-output-patterns.md). |
| W10 | **Hardcoded customer/environment value in a server script** | A literal endpoint URL, or **non-hex** config baked in (threshold values, MID/group names, software/serial strings), in a server script outside the connection-resolution helper. *(The hardcoded-hex-sys_id case is owned by scan check [12] — W10 defers to it, don't double-report.)* | Externalize to a system property (`gs.getProperty` + safe default) or a connection alias (builder rule A4). |
| W11 | **State-mutating tool with no dry-run/mock guard** | A tool that mutates (`.update()`, `.insert()`, `.setValue(`, or `setHttpMethod('POST'\|'PUT'\|'PATCH'\|'DELETE')`) with NO preceding `gs.getProperty(...dry_run...)` / mock short-circuit — so it can't be run safely in eval | Add the config-driven dry-run/mock guard from the tool-script templates (see builder Step 4). |

---

## Step 4: Present Findings

Generate a report grouped by severity:

```
## Audit Report: <Agent Name>

### Summary
- Blockers: X
- Warnings: Y
- Passed: Z checks passed

### Blockers (must fix before deployment)

| # | Check | Finding | Fix |
|---|---|---|---|
| B1 | Plain GlideRecord | Tool "Get Incidents" uses `new GlideRecord('incident')` | Replace with `new GlideRecordSecure('incident')`, add `canRead()` gate |
| B2 | Missing max_auto_executions | M2M for tool "Update Record" has no max_auto_executions | Add `max_auto_executions: '10'` |

### Warnings (recommended fixes)

| # | Check | Finding | Fix |
|---|---|---|---|
| W1 | Oversized agent | Agent has 18 tools | Split: group tools by domain into 3-4 smaller agents |
| W2 | Marketing prose | Role contains "happy to assist" | Remove. Lead with: "You are an expert X agent..." |

### Passed Checks
- ✓ GlideRecordSecure used in all script tools
- ✓ All M2M records have processing messages
- ✓ No reserved tool names
- ...
```

---

## After Auditing

Tell the user:
- Total blockers vs warnings
- If **blockers exist**: these must be fixed before deployment — offer to fix them now (for local files) or provide the specific field changes needed (for instance records)
- If **only warnings**: deployment will work but quality can be improved — list recommended fixes
- If **all passed**: agent follows best practices
- Suggest: **Run `/sn-aia-agent-builder`** (select "editing an existing one") to apply fixes to local fluent files
