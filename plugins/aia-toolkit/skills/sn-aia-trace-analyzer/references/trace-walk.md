# Trace Analyzer — Phase 2 query blocks & interpretation tables

On-demand reference for `/sn-aia-trace-analyzer` Phase 2. The SKILL.md keeps only the
walk order and each step's completion criterion; the per-step `read_records` query and the
tables you read the result against live here. When no MCP tool resolves, the equivalent
background script is in [`background-scripts.md`](background-scripts.md).

Every query block shows the illustrative param shape (`tableName` string, `query` encoded
string, `fields` **array** of strings, `limit`) from the `servicenow` MCP's
`sn_query_records` tool. Resolve `read_records` per
[`../../../references/mcp-capability-resolution.md`](../../../references/mcp-capability-resolution.md) against
whatever MCP is actually connected, and adapt these param names to its real schema.

> **Field-name traps** (real `sn_aia_*` DB columns, verified via `now-sdk query`, re-checkable
> with `now-sdk explain aiagent-api`): `sn_aia_tools_execution` keys off **`execution_plan_id`**
> + **`execution_status`** (not `execution_plan`/`status`); `sn_aia_execution_task` identifies
> its target via **`target_document_table`/`target_document_id`** (no `agent_name`/`tool_name`
> column). For a reference field's human label (e.g. `definition` on `sys_generative_ai_log`),
> use whatever display-value equivalent the resolved tool offers — there is no `<field>_dv`
> pseudo-column.

---

## phantom success (canonical definition)

**phantom success** = a tool row with `execution_status = completed` **and** a `response` that
is empty / `null` / `undefined` / `{}` / the literal string `"undefined"`. The tool "succeeded"
but returned no data, so the LLM downstream fabricates or emits placeholders.

It is the **runtime signature of a script-tool that doesn't return a value on every path** —
most often a tool authored with module syntax (`export function …` / `require`) or a compiled
`dist/` bundle instead of a **plain-JS IIFE** (see the Runtime Contract in
the `sn-aia-agent-builder` skill and its PLAIN-JS IIFE blocker). **The fix is in the tool
script, not the agent.** Every other mention of "phantom success" in the skill refers back to
this definition.

---

## Step 1 — Execution Plan Overview

```
sn_query_records
  tableName: sn_aia_execution_plan
  query: sys_id=<plan_sys_id>
  fields: ["sys_id","objective","state","state_reason","run_type","execution_time_ms","start_time","end_time","gen_ai_usage_log","llm_p95_latency","tool_p95_latency","llm_token_avg"]
  limit: 1
```

**Interpret the state:**

| State | Meaning |
|---|---|
| `completed` | Normal finish — check if the *output* was correct |
| `terminated` | Abnormal end — check `state_reason` below |
| `in_progress` | Still running or stuck |
| `gatherData` | Waiting for user input — won't complete without interaction |

**Interpret state_reason (for terminated runs):**

| `state_reason` | Meaning | Next step |
|---|---|---|
| `no_activity` | Timeout — nothing happened for too long | Check last execution task |
| `execution_failed` | A tool or step threw an error | Check tool executions |
| `planning_failed` | LLM couldn't produce a usable plan | Check LLM logs |
| `user_exited` | User left the conversation (not a bug) | No action needed |
| `live_agent_requested` | Handed off to a human | Check if this was intentional |
| `fallback_redirected` | Routed elsewhere by fallback config | Check fallback configuration |
| `security_violation` | ACL / permission failure | Check access verification task |

---

## Step 2 — Walk the Execution Task Tree

```
sn_query_records
  tableName: sn_aia_execution_task
  query: execution_plan=<plan_sys_id>^ORDERBYorder
  fields: ["sys_id","type","description","status","order","output","metadata","target_document_table","target_document_id","parent"]
  limit: 50
```

**Execution task types:**

| `type` | What it represents | What to look for |
|---|---|---|
| `access_verification` | Initial ACL gate | If status=error, user/agent lacks permission |
| `agent` | Agent reasoning loop | Parent container for gen_ai + tool tasks |
| `gen_ai` | One LLM call (the "think" step) | Check Output for the agent's reasoning |
| `tool` | A tool invocation | Cross-reference Tool Execution record |
| `communicator` | Agent asking the user a question | Check if this was expected |
| `manager` | Plan-management housekeeping | Usually not the problem |

**Execution task status indicators:**

| Status | Severity | Meaning |
|---|---|---|
| `completed` | OK | Task finished normally |
| `error` | ERROR | Task failed — this is where things went wrong |
| `cancelled` | ERROR | Task was cancelled |
| `queued` | WARNING | Task is waiting to run |
| `ready` | WARNING | Task is ready but hasn't started |
| `ongoing` | WARNING | Task is still running |

**Reading the trace:**
1. Sort by `order` — read top-to-bottom.
2. The first task with `status = error` is where things went wrong.
3. If no error but the run is stuck, the *last* task shows where it stopped.
4. For `gen_ai` tasks, `output` holds the LLM's structured reasoning (JSON nested in JSON — pretty-print it).
5. `parent` shows task nesting — `gen_ai` tasks are children of `agent` tasks.
6. Count `gen_ai` tasks = **ReAct iterations** (each is one reason-act loop).

---

## Step 3 — Inspect Tool Executions

```
sn_query_records
  tableName: sn_aia_tools_execution
  query: execution_plan_id=<plan_sys_id>
  fields: ["sys_id","request","response","execution_status","error_message","execution_time_ms","execution_mode","run_as_user","tool"]
  limit: 20
```

**What to look for:**
- `execution_status` — did the tool succeed or fail?
- `error_message` — the actual error text.
- `request` — were the right parameters sent?
- `response` — did the tool return what the agent expected? Empty on a `completed` row = **phantom success** (see definition above).
- `execution_time_ms` — is this tool slow?
- `execution_mode` — `sync` vs `async` (async tools may time differently).

**Tool execution status indicators:**

| Status | Severity | Meaning |
|---|---|---|
| `completed` | OK | Tool finished normally |
| `error` | ERROR | Tool failed |
| `timeout` | ERROR | Tool timed out |
| `cancelled` | ERROR | Tool was cancelled |
| `processing` | WARNING | Tool is still running |

---

## Step 4 — Inspect LLM Logs (GAIC error codes)

```
sn_query_records
  tableName: sys_generative_ai_log
  query: sys_created_onBETWEEN<start_time>@<end_time>
  fields: ["sys_id","definition","prompt","response","error","error_code","time_taken","prompt_token_count","response_token_count","prompt_config_id","skill_config_id","output_metadata","started_at","completed_at"]
  limit: 20
```

> `sys_generative_ai_log` has no direct `execution_plan` FK. Filter by the plan's time window
> (start_time→end_time); if multiple agents run concurrently, also filter by `conversation` if available.

**In the `prompt` field:**
- `{{variable_name}}` literally in the text — a variable failed to resolve.
- Empty tool list at the bottom — agent has no tools wired up.
- Missing system instructions — the agent's role/instructions weren't injected.
- Truncated conversation history — context window exceeded.

**In the `response` field:**
- Hallucinated tool names — agent called a tool that doesn't exist.
- Wrong action format — malformed JSON the orchestrator can't parse.
- Refusal — model refused (safety filter).
- Empty response — model returned nothing (check `error_code`).

When `error_code` is present, look it up in [`gaic-error-codes.md`](gaic-error-codes.md) —
pre-processing (100xxx), LLM request (200xxx), post-processing (300xxx), pipeline (400xxx).

---

## Step 5 — Check AIA Messages

```
sn_query_records
  tableName: sn_aia_message
  query: execution_plan.sys_id=<plan_sys_id>
  fields: ["sys_id","name","role","message","sys_created_on"]
  limit: 30
```

| Role | Meaning |
|---|---|
| `user` | User input message |
| `agent` | Agent response |
| `history` | Conversation history context |
| `user_profile` | User profile data injected as context |

Check: user messages captured correctly? agent response matches what the user saw?
history growing too large (context pressure)? user profile injected when expected?

---

## Step 6 — Check Platform Errors (Syslog)

```
sn_query_records
  tableName: syslog
  query: sourceLIKEsn_aia^messageLIKE<plan_sys_id>^level=0
  fields: ["sys_id","level","source","message","sys_created_on"]
  limit: 20
```

Broader AIA errors in the time window:
```
sn_query_records
  tableName: syslog
  query: sourceSTARTSWITHsn_aia^level=0^sys_created_onBETWEEN<start_time>@<end_time>
  fields: ["sys_id","level","source","message","sys_created_on"]
  limit: 20
```

---

## Step 7 — Performance Analysis

```
sn_query_records
  tableName: sn_aia_perf_event
  query: execution_plan=<plan_sys_id>^ORDERBYDESCduration_ms
  fields: ["sys_id","event_category","duration_ms","sequence","description"]
  limit: 20
```

| Category | What it times |
|---|---|
| `llm_call` | One round-trip to the LLM |
| `tool_execution` | One tool invocation |
| `script_execution` | A script tool's execution |
| `user_interaction` | Time waiting for user reply |
| `workflow_control` | Plan-level state transitions |
| `topic_switch` | Conversation topic change |
| `subflow_call` | Flow/subflow dispatch |

- Sort by `duration_ms` DESC — top entry is the bottleneck.
- `llm_call` dominates → model is slow (check model config, context length).
- `tool_execution` dominates → a specific tool is slow (check the tool script).
- `user_interaction` dominates → agent waited on the user (not a perf issue).
- **Orchestration Overhead** = Total − LLM Time − Tool Time. High → platform routing is the bottleneck.

> Perf events are captured only if `sn_aia.enable_perf_logs = true`. No events → check that property.

---

## Step 8 — Check User Feedback (optional)

```
sn_query_records
  tableName: sn_aia_execution_feedback
  query: execution_plan=<plan_sys_id>
  fields: ["sys_id","rating","feedback_text","sys_created_on"]
  limit: 5
```

---

## Step 9 — Check External Agent Calls (A2A/MCP, if applicable)

```
sn_query_records
  tableName: sn_aia_external_agent_exec_history
  query: execution_plan=<plan_sys_id>
  fields: ["sys_id","request","response","status","duration_ms"]
  limit: 10
```

```
sn_query_records
  tableName: sn_aia_external_agent_callback_registry
  query: execution_plan=<plan_sys_id>
  fields: ["sys_id","expected_at","received_at","status"]
  limit: 10
```

- `expected_at` vs `received_at` — large gap = external agent slow or hung.
- `status` — did the callback complete?

---

## Step 10 — Conversational Framework Tables (optional)

> **When to use:** populated only when the agent runs through the **Virtual Agent / Now Assist
> conversational framework** (Now Assist panel, VA widget). Skip if invoked directly via API or
> background script.

**Conversation Tasks:**
```
sn_query_records
  tableName: sys_cs_conversation_task
  query: conversation=<conversation_sys_id>
  fields: ["sys_id","topic_type","state","calling_task","context","sys_created_on","sys_updated_on"]
  limit: 20
```

| State | Severity |
|---|---|
| `completed` | OK |
| `faulted`, `canceled`, `abandoned`, `timedOut` | ERROR |
| `init`, `greet`, `gatherData`, `invokeAction`, `confirm`, `actionInProgress`, `suspended` | WARNING (in-progress) |

**FDIH Invocations (Flow Designer Integration Hub):**
```
sn_query_records
  tableName: sys_cs_fdih_invocation
  query: calling_cs_conversation_task.conversation.sys_id=<conversation_sys_id>
  fields: ["sys_id","name","response_state","type","execution_mode","error","outputs","sys_created_on","sys_updated_on"]
  limit: 20
```

| State | Severity |
|---|---|
| `COMPLETE` | OK |
| `ERROR`, `CANCELLED`, `TIMED_OUT` | ERROR |
| `IN_PROGRESS` | WARNING |

**AIA Step Logs:**
```
sn_query_records
  tableName: sys_cs_aia_step_log
  query: conversation_id=<conversation_sys_id>
  fields: ["sys_id","step_name","bundle_name","state","status","response","additional_args","parent_step","execution_plan_id","sys_created_on","sys_updated_on"]
  limit: 30
```

| State/Status | Severity |
|---|---|
| `completed` | OK |
| `errored`, `error`, `cancelled` | ERROR |
| `pending`, `processing`, `skipped` | WARNING |

- Empty `response` AND empty `additional_args` — step produced no output.
- `errored` state — check `response` for error details.
- `parent_step` — builds the step-execution hierarchy.

---

## System Health Checks (before deep-diving)

```
sn_query_records
  tableName: sys_properties
  query: nameSTARTSWITHsn_aia.enable
  fields: ["name","value","description"]
  limit: 10
```

| Property | What it controls | Recommended |
|---|---|---|
| `sn_aia.enable_perf_logs` | Performance Event capture | `true` for debugging |
| `sn_aia.enable_conversational_debugger` | Verbose conversation-level debug data | `true` for debugging |
| `sn_aia.enable_episodic_memory` | Memory writes | Depends on agent design |
| `sn_aia.episodic_memory_limit` | Cap on memory entries per session | Default is fine |

- **AIS status:** verify `<instance>/xmlstats.do?include=ais` shows Green/ACTIVE.
- **Retention:** Execution Plans/Tasks/Tool Executions/Perf Events **do not auto-purge** — they
  grow forever unless an admin adds a cleanup job. Flag this at scale.
