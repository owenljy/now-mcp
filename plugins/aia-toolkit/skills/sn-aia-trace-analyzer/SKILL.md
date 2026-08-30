---
name: sn-aia-trace-analyzer
description: Analyzes AI Agent execution traces, spans, and logs on a ServiceNow instance to diagnose runtime failures, wrong answers, slow runs, stuck executions, and "phantom success" (a tool reports success but returned empty/undefined output). Walks the execution plan → tasks → tool calls → LLM logs → performance events chain. Includes GAIC error code interpretation, Rhino tool-script error-signature detection, performance metrics computation, and structured diagnostic checklists. Can also trigger a test run to populate tracing tables. Use after an agent is deployed and running. Trigger on phrases like "trace analysis", "analyze agent run", "why did the agent fail", "agent gave wrong answer", "agent returned empty/blank/placeholder data", "tool succeeded but no data", "agent is slow", "debug agent run", "execution trace", "inspect spans", "root cause analysis", "agent runtime issue", "what went wrong", "analyze execution plan", "GAIC error", "error code", "LLM error".
---

# ServiceNow AI Agent Trace Analyzer

Diagnoses runtime issues with deployed AI Agents by walking the execution trace — the layered trail of records the platform writes for every agent run. This is the skill to use when the agent is deployed and running but producing wrong answers, failing, running slow, or behaving unexpectedly.

Use the current request and conversation as the diagnostic context, including any execution-plan sys_id, agent name, symptom, and expected behavior already provided.

> **Not for eval infrastructure issues.** If your problem is "eval run produced null results" or "Auto Chat didn't start," use `/sn-eval-runner-builder` instead. This skill is for "the agent ran but did something wrong."

> **Prerequisite:** The agent must have been invoked at least once so tracing records exist. If no execution plan exists yet, this skill can trigger a test run first (Phase 1). This skill reads via the `read_records` capability, resolved against whatever MCP is connected (see [../../references/mcp-capability-resolution.md](../../references/mcp-capability-resolution.md)); if nothing matches, **tell the user explicitly** before falling back to the background scripts in [references/background-scripts.md](references/background-scripts.md).

---

## How a Run is Traced

When an AI Agent runs, the platform writes a layered trail — all joined by **Execution Plan sys_id**:

```
Execution Plan (sn_aia_execution_plan)          ← the run itself
  └─ Execution Tasks (sn_aia_execution_task)    ← every step (think, tool, ask, delegate)
       ├─ Tool Executions (sn_aia_tools_execution)  ← raw request/response per tool call
       ├─ LLM Logs (sys_generative_ai_log)          ← actual prompt + model response + GAIC error codes
       └─ Performance Events (sn_aia_perf_event)    ← timing spans
  └─ Messages (sn_aia_message)                  ← per-plan message view
  └─ Syslog (syslog)                            ← platform errors, stamped with plan ID
  └─ Feedback (sn_aia_execution_feedback)       ← user thumbs/rating
```

**The trick: get the Execution Plan sys_id, then pivot everywhere.**

---

## Phase 1: Get an Execution Plan to Analyze

Ask: **Do you already have an execution plan sys_id, or do you need to trigger a test run?**

### Option A: User provides an execution plan sys_id

Proceed directly to Phase 2.

### Option B: Find a recent execution plan

#### Resolve `read_records`:

> **Every query block in this skill** shows the illustrative param shape
> (`tableName` string, `query` encoded string, `fields` **array** of strings,
> `limit`) from the `servicenow` MCP's `sn_query_records` tool.
> Resolve `read_records` per
> [`../../references/mcp-capability-resolution.md`](../../references/mcp-capability-resolution.md)
> against whatever MCP is actually connected, and adapt these param names to
> its real schema. Field names below are the **real `sn_aia_*` DB columns** —
> verified against the live instance via `now-sdk query` and re-checkable with
> `now-sdk explain aiagent-api`. Watch the traps: `sn_aia_tools_execution` keys
> off **`execution_plan_id`** + **`execution_status`** (not
> `execution_plan`/`status`); `sn_aia_execution_task` identifies its target via
> **`target_document_table`/`target_document_id`** (there is no
> `agent_name`/`tool_name` column). For a reference field's human label (e.g.
> `definition` on `sys_generative_ai_log`), look for a display-value
> equivalent on whichever tool resolves — there is no `<field>_dv`
> pseudo-column.

```
sn_query_records
  tableName: sn_aia_execution_plan
  query: objectiveLIKE<keyword>^ORDERBYDESCsys_created_on
  fields: ["sys_id","objective","state","state_reason","run_type","execution_time_ms","start_time","end_time"]
  limit: 10
```

Present the results and ask the user to pick one.

#### No match found:

Give the user the recent-plans script from [`references/background-scripts.md`](references/background-scripts.md#option-b--find-a-recent-execution-plan).

### Option C: Trigger a new test run

Ask for:
- **Usecase sys_id** — from `sn_aia_usecase.list`
- **Objective** — the prompt/goal for the agent
- **Target record** (optional) — table + sys_id if the agent needs context

#### Either way:

Use the launch-and-poll script from [`references/background-scripts.md`](references/background-scripts.md#option-c--trigger-a-new-test-run) — resolve `run_privileged_script` and execute it if a matching tool is connected, otherwise give it to the user to run in **Scripts > Background** (Global scope) and ask them to paste back the execution plan sys_id.

> **Prerequisites for triggering a run:**
> - `sn_aia` (nowassist-ai-agents) >= 7.1.8
> - Agent usecase deployed and active
> - LLM connection configured and active
> - AIS status Green/ACTIVE (check `<instance>/xmlstats.do?include=ais`)

---

## Phase 2: Trace Analysis

Once you have the execution plan sys_id, walk the trace **in order**, Step 1 → Step 10.
For each step: resolve `read_records` and run the query in
[`references/trace-walk.md`](references/trace-walk.md), reading the result against that step's
interpretation table there. If no MCP tool resolves, use the matching background script in
[`references/background-scripts.md`](references/background-scripts.md) instead.

> **On `GlideRecord` vs `GlideRecordSecure`:** the background scripts are **read-only diagnostics** run interactively by an admin in Scripts > Background — they intentionally use plain `GlideRecord` to see all trace records regardless of ACLs. Deployed tool scripts must use `GlideRecordSecure` because they run as the agent's user. Do not "fix" these diagnostic scripts to `GlideRecordSecure` — that would hide records you need to see.

| Step | Table | What it tells you |
|---|---|---|
| 1 — Execution Plan Overview | `sn_aia_execution_plan` | `state`/`state_reason`, timing, latency metrics — the run's verdict |
| 2 — Execution Task Tree | `sn_aia_execution_task` | Every step in order; first `error` task = where it broke; last task = where it's stuck; `gen_ai` count = ReAct iterations |
| 3 — Tool Executions | `sn_aia_tools_execution` | Raw request/response per tool call — including **phantom success** (see trace-walk.md definition) |
| 4 — LLM Logs | `sys_generative_ai_log` | The actual prompt + response + GAIC `error_code` — the first stop when the agent says something weird |
| 5 — AIA Messages | `sn_aia_message` | User inputs vs agent responses vs injected history/profile |
| 6 — Platform Errors | `syslog` | Platform errors stamped with the plan ID |
| 7 — Performance | `sn_aia_perf_event` | Timing spans; slowest span = bottleneck; LLM vs Tool vs Orchestration split |
| 8 — User Feedback (opt) | `sn_aia_execution_feedback` | Thumbs / rating |
| 9 — External Agent Calls (opt) | `sn_aia_external_agent_*` | A2A/MCP callback timing and status |
| 10 — Conversational Framework (opt) | `sys_cs_*` | Only when run through Virtual Agent / Now Assist panel |

**Completion criterion for Phase 2:** every non-optional step (1–7) has been queried and its
result recorded, OR the walk stopped at the first `error`/stuck task with the cause identified.
Do not proceed to Phase 3 with steps 1–7 unexamined. GAIC `error_code`s from Step 4 are decoded
via [`references/gaic-error-codes.md`](references/gaic-error-codes.md).

---

## Phase 3: Diagnostic Checklist

After collecting data from Phase 2, run through this structured checklist before presenting findings. Mark each item as PASS, FAIL, or SKIP:

### Core Health Checks

| # | Check | Table | Condition | Severity |
|---|---|---|---|---|
| 1 | Execution plan completed | `sn_aia_execution_plan` | `state` = `completed` | CRITICAL if not |
| 2 | No execution task errors | `sn_aia_execution_task` | No tasks with `status` = `error` or `cancelled` | CRITICAL |
| 3 | No tool execution failures | `sn_aia_tools_execution` | No tools with `execution_status` in (`error`, `timeout`, `cancelled`) | CRITICAL |
| 4 | No GAIC error codes | `sys_generative_ai_log` | No records with non-empty `error_code` | CRITICAL — decode via [`references/gaic-error-codes.md`](references/gaic-error-codes.md) |
| 5 | No LLM empty responses | `sys_generative_ai_log` | All records have non-empty `response` | WARNING |
| 6 | No LLM error messages | `sys_generative_ai_log` | No records with non-empty `error` field (without error_code) | ERROR |
| 7 | No syslog errors | `syslog` | No error-level entries in time window | WARNING |
| 8 | Performance within bounds | `sn_aia_perf_event` | No single span > 30s | WARNING if > 10s, ERROR if > 30s |
| 9 | Reasonable ReAct iterations | `sn_aia_execution_task` | Count of `gen_ai` type tasks ≤ 10 | WARNING if > 10 (possible loop) |
| 10 | Token usage reasonable | `sys_generative_ai_log` | Total prompt tokens < 100K per call | WARNING if high |
| 11 | No phantom-success tools | `sn_aia_tools_execution` | No tool with `execution_status` = `completed` AND empty/`undefined`/`{}` `response` | CRITICAL — tool returned no data despite "success"; fix the tool script (see Runtime Contract) |

### Performance Metrics Summary

After collecting data, compute and present these metrics:

```
## Performance Summary

| Metric | Value |
|---|---|
| Total Execution Time | <execution_time_ms>ms |
| LLM Time (total) | <sum of time_taken from sys_generative_ai_log>ms |
| Tool Time (total) | <sum of execution_time_ms from sn_aia_tools_execution>ms |
| Orchestration Overhead | <execution_time - llm_time - tool_time>ms |
| LLM Calls | <count> |
| Tool Calls | <count> |
| ReAct Iterations | <count of gen_ai execution tasks> |
| Total Prompt Tokens | <sum of prompt_token_count> |
| Total Response Tokens | <sum of response_token_count> |
| Avg Tokens per LLM Call | <total_tokens / llm_calls> |
| Slowest Operation | <category>: <duration_ms>ms |
| LLM P95 Latency | <from execution plan> |
| Tool P95 Latency | <from execution plan> |
```

---

## Phase 4: Root Cause Classification

After the diagnostic checklist, classify the issue using this decision tree:

### Debug-by-Symptom Playbook

| Symptom | Start here | Then drill into |
|---|---|---|
| **Agent gave a wrong or weird answer** | LLM Log (`sys_generative_ai_log`) → read the `prompt` field | Was the prompt correct? Were variables filled in? Was the tool list complete? |
| **Agent emitted empty / placeholder / blank values despite tools "succeeding"** | Tool Execution (`sn_aia_tools_execution`) → `execution_status = completed` but `response` empty/`undefined` (phantom success) | The tool script returned `undefined`. Check it returns a value on every path; most often it used `export function`/`require`/a `dist/` bundle instead of a plain-JS IIFE — see Runtime Contract in `/sn-aia-agent-builder` |
| **Agent says "I don't have any instructions or actions"** | LLM Log `prompt` field — the tool list section is empty | Check agent's tool wiring in AI Agent Studio |
| **A tool failed** | Tool Execution filtered by plan → `execution_status` and `error_message` | Then Syslog around that timestamp |
| **LLM returned an error code** | LLM Log `error_code` field → look up in [`references/gaic-error-codes.md`](references/gaic-error-codes.md) | Follow the workaround for that specific code |
| **Guardrail blocked the response** | LLM Log `error_code` = 300000/300100/300200/300300 | Check `sys_generative_ai_metric` for flagged categories |
| **Run is stuck `in_progress` and never completes** | Execution Task for the plan, sort by `order` desc — last row shows where it stuck | Check Syslog around that time |
| **Run is slow** | Performance Event for the plan, sort `duration_ms` desc | Identify the bottleneck category. Compute LLM vs Tool vs Orchestration split. |
| **Trigger should have fired but didn't** | Syslog filtered by `source` containing `Trigger` | Look for license, ACL, or condition rejections |
| **Worked yesterday, broken today, no plugin update** | Update XML (`sys_update_xml`) with `category = customer` on the agent, tools, prompt config | Someone modified OOB records |
| **Cost went up** | GenAI Usage Log joined to recent Execution Plans | Plus Report Metric trends. Check token counts in LLM logs. |
| **Eval score dropped after a change** | Agent Execution Eval (`sn_aia_agent_execution_eval`) filtered by `source_id` and date range | Compare before/after |
| **External / A2A agent call hung** | External Agent Callback Registry (compare `expected_at` vs `received_at`) | External Agent Execution History for the request payload |

### Failure Pattern Taxonomy

Once you've identified the symptom, classify the root cause:

| Pattern | What to look for in traces | Where to fix |
|---|---|---|
| **Prompt / Instructions** | LLM log shows wrong/missing instructions, variables not resolved | Agent instructions, role, or prompt config |
| **Tool Wiring** | Tool list empty in LLM prompt, or tool not found errors | Agent-tool M2M records (`sn_aia_agent_tool_m2m`) |
| **Tool Script Error** | Tool execution has `error_message`, script threw exception | Tool script code |
| **Rhino Module Syntax** | `error_message` or syslog contains `"exports" is not defined`, `require is not defined`, or `RhinoEcmaError … .script : Line(N)` | Tool script used `import`/`export`/`require` or a compiled `dist/` bundle. Rewrite as a plain-JS IIFE per the Runtime Contract and `sn-aia-agent-builder` skill. |
| **Phantom Success** | Tool `execution_status = completed` but `response` empty/`undefined`/`{}`; LLM then fabricates or emits placeholders | Tool script doesn't `return` on every path (often a bare `export function` that is never invoked). Rewrite as a plain-JS IIFE that returns a value on success AND error |
| **ACL / Permission** | `access_verification` task failed, `security_violation` state_reason | ACL rules, role assignments, `runAsUser` config |
| **Data Quality** | Tool returns stale/wrong data, GlideRecord returns no results | Source data on the instance |
| **Reasoning Error** | Agent picks wrong tool or runs them in wrong order | Refine agent instructions, add decision gates |
| **Hallucination** | Agent fabricates values not in any tool output | Add grounding constraints, tighten tool output formatting |
| **Context Management** | Agent loses conversation context mid-trajectory | Check token limits, simplify multi-step workflows |
| **GAIC Pre-Processing** | Error codes 100001-100006 in LLM logs | Fix input format, prompt config, or capability attributes |
| **GAIC LLM Request** | Error codes 200000-200001 in LLM logs | Fix LLM connection, API key, or JSON format config |
| **GAIC Post-Processing** | Error codes 300000-300300 in LLM logs | Adjust guardrail thresholds, fix trust builder config |
| **GAIC Pipeline** | Error codes 400001-400002 in LLM logs | Check subflow execution logs or scriptable API calls |
| **External Dependency** | External agent/MCP call timed out or returned error | External service availability, callback config |
| **Configuration Drift** | Update XML shows customer modification to OOB records | Revert the modification |

---

## System Health Checks

Before deep-diving into a specific run, verify the platform is configured for observability:

### Check system properties

#### Resolve `read_records`:
```
sn_query_records
  tableName: sys_properties
  query: nameSTARTSWITHsn_aia.enable
  fields: ["name","value","description"]
  limit: 10
```

#### No match found — see [`references/background-scripts.md#system-health`](references/background-scripts.md#system-health--check-system-properties)

| Property | What it controls | Recommended |
|---|---|---|
| `sn_aia.enable_perf_logs` | Performance Event capture | `true` for debugging |
| `sn_aia.enable_conversational_debugger` | Verbose conversation-level debug data | `true` for debugging |
| `sn_aia.enable_episodic_memory` | Memory writes | Depends on agent design |
| `sn_aia.episodic_memory_limit` | Cap on memory entries per session | Default is fine |

### Check AIS status

Tell the user to verify: `<instance>/xmlstats.do?include=ais` — must show Green/ACTIVE.

### Retention warning

Execution Plans, Execution Tasks, Tool Executions, and Performance Events **do not auto-purge**. They grow forever unless an admin adds a custom cleanup job. Flag this if the instance has been running agents at scale for a long time.

---

## Comprehensive Background Script (All-in-One)

When MCP is not available, give the user the all-in-one collection script from
[`references/background-scripts.md`](references/background-scripts.md#all-in-one--comprehensive-collection-script) —
it gathers the plan, tasks, tool executions, LLM logs, messages, performance events, syslog
errors, and feedback for a given execution plan in one pass, plus a computed summary
(performance breakdown, token usage, phantom-success detection, top slowest spans).

---

## Presenting Results

After collecting and analyzing the trace data, present findings in this format:

```
## Trace Analysis: <objective excerpt>

### Execution Summary
- **Plan ID:** <sys_id>
- **State:** <state> (<state_reason>)
- **Duration:** <execution_time_ms>ms

### Performance Breakdown
| Metric | Value | % of Total |
|---|---|---|
| LLM Time | <llm_time>ms | <pct>% |
| Tool Time | <tool_time>ms | <pct>% |
| Orchestration Overhead | <overhead>ms | <pct>% |

### Efficiency
| Metric | Value |
|---|---|
| LLM Calls | <count> |
| Tool Calls | <count> |
| ReAct Iterations | <count> |
| Total Tokens | <prompt> in / <response> out |
| Avg Tokens/Call | <avg> |

### Diagnostic Checklist
| # | Check | Result |
|---|---|---|
| 1 | Plan completed | ✅ PASS / ❌ FAIL |
| 2 | No task errors | ✅ PASS / ❌ FAIL |
| 3 | No tool failures | ✅ PASS / ❌ FAIL |
| 4 | No GAIC error codes | ✅ PASS / ❌ FAIL: <code> — <name> |
| 5 | No empty LLM responses | ✅ PASS / ⚠️ WARN |
| 6 | No syslog errors | ✅ PASS / ⚠️ WARN |
| 7 | Performance OK | ✅ PASS / ⚠️ WARN: <bottleneck> |
| 8 | No phantom-success tools | ✅ PASS / ❌ FAIL: <tool> returned empty despite success |

### Root Cause
**Pattern:** <pattern from taxonomy>
**Description:** <what went wrong>
**Evidence:** <specific data from the trace>

### Findings

| # | Layer | Finding | Severity |
|---|---|---|---|
| 1 | Tool Execution | Tool "Get Incidents" returned error: "ACL denied" | CRITICAL |
| 2 | LLM (GAIC) | Error code 200000: LLM execution error — invalid API key | CRITICAL |
| 3 | Performance | LLM call took 45s (P95 is 8s) | WARNING |

### Recommended Fixes
1. <specific fix with before/after values>
2. <specific fix>

### Next Steps
- Run `/sn-aia-agent-audit` to check agent configuration
- Run `/sn-aia-agent-builder` to fix tool wiring
- Re-run the agent and re-analyze with `/sn-aia-trace-analyzer`
```

---

## Cross-References

| If you need to... | Use this skill |
|---|---|
| Debug eval infrastructure (null results, Auto Chat issues) | `/sn-eval-runner-builder` |
| Audit agent config against best practices | `/sn-aia-agent-audit` |
| Fix a tool script (phantom success, Rhino module-syntax error) — see its Runtime Contract section | `/sn-aia-agent-builder` |
| Fix agent files (instructions, tools, wiring) | `/sn-aia-agent-builder` |
| Create test cases for systematic evaluation | `/sn-aia-dataset-builder` |
| Set up eval metrics and publish a version | `/sn-eval-runner-builder` (Phase 0) |
| Generate an eval runner for programmatic eval runs | `/sn-eval-runner-builder` |
