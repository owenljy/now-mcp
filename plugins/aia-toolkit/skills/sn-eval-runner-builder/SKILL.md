---
name: sn-eval-runner-builder
description: Sets up the full ServiceNow platform eval pipeline for AI agents — publishes a version, creates an isolated eval team, and generates a Script Include eval runner (Auto Chat, no UI wizard). Also diagnoses failed eval runs — null results, stuck runs, NA metric scores. Trigger on phrases like "set up eval", "platform eval", "eval setup", "publish version for eval", "eval runner", "run evals in code", "background script eval", "programmatic eval", "NowAssistSkillKitAPI", "Auto Chat eval", "eval failed", "debug eval", "eval broken", "null results", "zero traces".
---

# ServiceNow Eval Runner Builder

Sets up the full platform eval pipeline for an AI agent: publishes a version, creates an isolated eval team, then generates and deploys a Script Include runner that triggers Auto Chat eval runs from Scripts > Background — no UI wizard needed.

Supports two deployment paths:
- **Fluent (now-sdk):** Generate `.now.ts` + `.server.js` files, deploy with `pnpm run build:install`
- **Platform UI:** Create records directly in ServiceNow

> **Prerequisite — check before proceeding:** If deploying via now-sdk (fluent records), check `package.json` for `@servicenow/sdk` before generating files. If it's missing, **tell the user explicitly** and offer the Platform UI path instead. Also resolve `read_records` / `run_privileged_script` against whatever MCP is connected (see [../../references/mcp-capability-resolution.md](../../references/mcp-capability-resolution.md)); if nothing matches, tell the user before falling back to background scripts.

> **Instance safety gate — check before any write.** This skill writes real records (published version, eval team, script include, then eval runs/datasets/metric results) directly to whatever instance now-sdk/MCP are currently connected to — the two-scope separation below only protects a *packaged* customer install, it does nothing if you're live-connected to a customer's production tenant. Before Phase 0:
> 1. Resolve the connected target: call `sn_sdk_status` if the MCP exposes it (or inspect the active now-sdk profile / `now.config.json`), and state the resolved instance name/host to the user.
> 2. If resolution fails, or the name/host looks like a customer or production tenant, stop and ask the user to explicitly confirm this instance is intended before proceeding. Do not proceed silently.
> 3. **Prefer dry-run/mock over real side-effects.** If the agent's state-mutating tools support the config-driven dry-run/mock guard (builder Step 4 / [../../references/tool-output-patterns.md → Run-level terminal outcomes](../../references/tool-output-patterns.md)), enable it for the eval run — it exercises the full real tool path on the instance without the irreversible writes, far safer than pointing eval at production writes. **Fidelity caveat:** a dry-run/mock eval covers tool selection and the pre-mutation path but NOT the real side-effect, so a mutating agent still needs one non-dry-run validation in a safe (non-prod) sandbox before go-live.

---

## Phase 0: Eval Prerequisites

Before generating the runner, ensure the instance has what it needs. Ask: **which agent, and single scope or two scopes?**

| Mode | When | Eval file location |
|---|---|---|
| **Single scope** | Internal tools, prototypes | `src/fluent/agent/ai-agent-<name>/eval/` |
| **Two scopes** | Shipping to customers | `src/fluent/eval/` |

### 0.1 — Publish a version

Read `src/fluent/agent/ai-agent-<name>/<name>-agent.now.ts` and check whether a `<name>-version.now.ts` with `state: 'published'` already exists. If yes, skip. Otherwise create:

```ts
import { Record } from '@servicenow/sdk/core'
import { aiAgent } from './<name>-agent.now'

Record({
    $id: Now.ID['<name>-version'],
    table: 'sn_aia_version',
    data: {
        instructions: Now.include('./<name>-instructions.md'),
        state: 'published',
        target_id: aiAgent,
        target_table: 'sn_aia_agent',
        version_name: 'V1',
        version_number: '1',
        sys_domain: 'global',
    },
})
```

> Use a descriptive `Now.ID` key — UUID keys get moved to the `deleted` block on next transform.

### 0.2 — Create an isolated eval team *(required for Auto Chat path)*

An isolated one-agent team prevents context leakage from production team configurations. The runner resolves the team via the usecase's `team` field — if that points at a production team containing other agents, Auto Chat picks up irrelevant context and scores are meaningless.

> **Why `Record()` here and not `AiAgenticWorkflow()`?** This adds a standalone team to an *already-deployed* agent and points an existing usecase's `team` field at it — a targeted modification the regenerate-everything typed API can't express piecemeal. That's the one legitimate `Record({ table: 'sn_aia_*' })` gap in the Fluent metadata rules.

**a. Eval team:**
```ts
import { Record } from '@servicenow/sdk/core'

Record({
    $id: Now.ID['<name>-eval-team'],
    table: 'sn_aia_team',
    data: {
        name: '<Agent display name> Evaluation',
        description: 'Isolated team for evaluating the <name> agent. Contains only this agent to prevent context leaks from other agents during Auto Chat.',
        sys_domain: 'global',
    },
})
```

**b. Team member:**
```ts
import { Record } from '@servicenow/sdk/core'
import { aiAgent } from '../<name>-agent.now'

Record({
    $id: Now.ID['<name>-eval-team-member'],
    table: 'sn_aia_team_member',
    data: {
        agent: aiAgent,
        memory_scope: 'conversation',
        sys_domain: 'global',
        team: Now.ID['<name>-eval-team'],
    },
})
```

**c. Wire the usecase to the eval team:**
```ts
Record({
    $id: Now.ID['<name>-eval-usecase'],
    table: 'sn_aia_usecase',
    data: {
        team: Now.ID['<name>-eval-team'],  // isolated eval team, NOT a production team
    },
})
```

### 0.3 — Eval metric configs *(UI wizard path only — skip for Auto Chat code runner)*

> **Skip this on the Auto Chat code-runner path.** These non-agentic metric records (Faithfulness, Correctness) produce garbage scores under Auto Chat — the pipeline never populates their `{{grounded_prompt}}`/`{{generated_response}}` template variables. Only generate these if scoring through the Now Assist → Evaluations UI wizard.

Check whether `sys_one_extend_eval_strategy_metric` files already exist in `src/fluent/`. If so, skip. Otherwise generate under the scope path from above.

> **Verify these platform sys_ids against your instance before deploying** — they can differ by release. Confirm with: `now-sdk query sys_one_extend_eval_strategy_metric -q metric_nameLIKECorrectness -o json` or by resolving the `read_records` capability (see [../../references/mcp-capability-resolution.md](../../references/mcp-capability-resolution.md)).

```ts
// eval-metric-faithfulness.now.ts
Record({ $id: Now.ID['eval-metric-faithfulness'], table: 'sys_one_extend_eval_strategy_metric',
    data: { active: 'true', definition: 'a5d3dae1a3d20210883c25d1d71e6108',
            eval_strategy: '0dd275d4ffe4b2102454fffffffffffe', gen_ai_config: 'aa55d2e5a3d20210883c25d1d71e6102',
            metric_name: 'Faithfulness Metric', sys_domain: 'global' } })

// eval-metric-correctness.now.ts
Record({ $id: Now.ID['eval-metric-correctness'], table: 'sys_one_extend_eval_strategy_metric',
    data: { active: 'true', definition: 'cbf929b27fe242100a03b6257d866548',
            eval_strategy: '0dd275d4ffe4b2102454fffffffffffe', gen_ai_config: 'c834087d7f5202100a03b6257d866503',
            metric_name: 'Correctness Metric', sys_domain: 'global' } })

// eval-metric-correctness-golden.now.ts (only if test cases will have ground truth)
Record({ $id: Now.ID['eval-metric-correctness-golden'], table: 'sys_one_extend_eval_strategy_metric',
    data: { active: 'true', definition: 'e34cc1d97f14121071cab6257d8665b2',
            eval_strategy: '0dd275d4ffe4b2102454fffffffffffe', gen_ai_config: 'be27f08a7f4702100a03b6257d86655c',
            metric_name: 'Correctness Metric with Golden Response', sys_domain: 'global' } })
```

---

## Prerequisites

### Cross-scope access (two-scope setups only)

If the eval runner lives in a different scope from the agent, it reads tables from other scopes (`sn_aia_usecase`, `sn_aia_version`, `aia_artifact_dataset`, etc.). The `now.config.json` must have:

```json
{
  "accessControls": {
    "runtimeAccessTracking": "permissive"
  }
}
```

This auto-grants `sys_scope_privilege` records on first access instead of blocking with "Security restricted" errors. Verify this is set before generating a runner.

### Usecase + version records

The eval runner resolves the agent's `sn_aia_usecase` and `sn_aia_version` records at runtime. These must exist on the instance before running. If the usecase was created via the SkillKit UI (Now Assist > AI Agent Studio), it already exists — find its sys_id with:

```js
var gr = new GlideRecord('sn_aia_usecase');
gr.addQuery('name', '<Agent Display Name>');
gr.query();
if (gr.next()) gs.info(gr.getUniqueValue());
```

The usecase sys_id goes into the runner's `DEFAULT_USECASE_ID` constant. No fluent record is required if the usecase was created in the UI.

### Existing datasets

Dataset records (`aia_artifact_dataset`) must exist before the runner can pull them. If none exist, run `/sn-aia-dataset-builder` first. The runner and datasets are independent — regenerating the runner does not touch existing datasets.

---

## How It Works

A single call to `run()` completes the full eval flow on cloud instances — it creates the eval run, creates the dataset, then auto-invokes `this.process()` to start the Auto Chat conversations.

```
var runner = new <scope>.<AgentName>EvalRunner();
var r = runner.run({ maxRows: '3' });    // runs all 3 steps automatically
         |
         +-- NowAssistSkillKitAPI.createAgenticEvalRun()       [step 1]
         +-- NowAssistSkillKitAPI.createAgenticEvalDataset()    [step 2]
         +-- this.process() -> processAgenticEvalRun()          [step 3, auto]
         +-- Auto Chat tasks execute -> metrics scored
         |
         v
Now Assist -> Evaluations dashboard
```

> **Cloud vs localhost.** Single-step `run()` reliably auto-invokes `process()` on cloud instances. Localhost dev instances often miss the KMF/crypto modules `processAgenticEvalRun()` depends on, so the auto-invocation fails. When that happens, `run()` returns `{ success: false, step: 'processAgenticEvalRun', evalRunId, datasetId }` — re-invoke `process(evalRunId, datasetId)` manually in a separate Scripts > Background execution. The records created by `run()` (eval run + dataset) survive across executions, so the fallback only re-runs step 3.

### Patterns baked into the template

The template below already includes the patterns that have been verified end-to-end against real eval runs. You don't need to graft them in from elsewhere:

- **Comprehensive `_preflight()`** — 7 checks: usecase ACL via `GlideRecordSecure`, published `sn_aia_version`, agent record exists, `sn_aia_agent_config.active=true`, `sn_aia_team_member` references the agent, `sn_aia_agent_tool_m2m` has active tools, `aia_artifact_dataset` rows match filter. Catches the long tail of `state_reason: no_activity` failures **before** any records are created. For agents that use MCP tools, add an 8th check: verify the `sn_mcp_server` `sys_connection` + credential are wired.
- **`opts.filter`** — caller-overridable encoded query (default `unique_idSTARTSWITH<prefix>-^ground_truthISNOTEMPTY`). Auto-appends `^ground_truthISNOTEMPTY` unless the caller already constrained `ground_truth`, since GT-scored metrics can't evaluate rows without GT.
- **`opts.agentId`** — configurable agent for preflight. Defaults to the agent's known sys_id; pass to override for tests.
- **`STEP 2.5` patches `query_override`** on the batch_run after dataset creation so the dashboard's task filter resolves correctly.
- **`groundtruthsysid` attribute mapping** — required by `Tool calling correctness (GT)` and other GT-based metrics. The basic template below already includes this; remove the entry if the eval doesn't use any GT-based metric.

> For an end-to-end working reference, see the runner generated in [`observ-ai-agents-autoeval`](https://code.devsnc.com/dev/observ-ai-agents-autoeval) — it consumes this template verbatim and is verified against live eval runs.

---

## Scope

The eval runner is internal eval infrastructure — it does not ship to customers.

### Single scope (agent + evals in one repo)

Everything lives together. No cross-scope access needed.

| Component | Location |
|---|---|
| Eval runner | `src/fluent/agent/ai-agent-<name>/eval-runner/` |
| Dataset records | `src/fluent/agent/ai-agent-<name>/eval/` |
| Agent source | `src/fluent/agent/ai-agent-<name>/` |

### Two scopes (agent repo + separate eval repo)

Agent ships in one scope, evals live in a dedicated eval scope. Requires `runtimeAccessTracking: "permissive"`.

| Component | Repo | Location |
|---|---|---|
| Eval runner | eval repo | `src/fluent/generated/` |
| Dataset records | eval repo | `src/fluent/generated/` |
| Agent source | agent repo | `src/fluent/agent/ai-agent-<name>/` |

---

## Step 1: Gather Agent Config

Ask or determine:
- **Agent name** (e.g. `IncidentTriage`, `ChangeRisk`) — used for the class name
- **Agent internal name** — the `internal_name` field on the `sn_aia_usecase` record (e.g. `'global.<scope>.<Agent Name>'`) — more stable than display name for runtime lookup
- **Usecase sys_id** — from the `sn_aia_usecase` record on the instance (the eval runner resolves this at runtime by sys_id first, then falls back to internal_name)
- **Agent sys_id** — from the `sn_aia_agent` record; used by `_preflight()` to verify the agent is active, has a team membership, and has tools attached before creating any eval records
- **unique_id prefix** — the `unique_id` prefix on `aia_artifact_dataset` records (e.g. `my-agent-`)
- **Number of test cases** — used for `maxRowLimit`

---

## Step 2: Generate the `.now.ts` Wrapper (fluent/now-sdk only)

> **Not using fluent?** Skip to Step 3 for the runner code, then see Step 5 Option B to deploy via the ServiceNow UI.

Create the fluent wrapper in the repo:

```ts
import { ScriptInclude } from '@servicenow/sdk/core'

ScriptInclude({
    $id: Now.ID['<agent>-eval-runner'],
    name: '<AgentName>EvalRunner',
    script: Now.include('./<agent>-eval-runner.server.js'),
    description: 'Programmatically creates and triggers an agentic eval run for the <Agent display name> agent. Call from Scripts > Background (Global scope) — no UI wizard required.',
    apiName: '<scope>.<AgentName>EvalRunner',
    clientCallable: false,
    mobileCallable: false,
    sandboxCallable: false,
    accessibleFrom: 'public',
    active: true,
})
```

---

## Step 3: Generate the `.server.js` Implementation

Copy [`references/eval-runner.template.js`](references/eval-runner.template.js) into the
runner implementation and replace every `<angle-bracket>` placeholder (`<AgentName>`,
`<scope>`, `<usecase-sys-id>`, `<internal-name>`, `<agent-sys-id>`, `<unique-id-prefix>`,
`<N>`, `<agent_slug>`, `<Agent display name>`) with the values gathered in Step 1. The
template bakes in the patterns listed under "Patterns baked into the template" above — do
not regenerate this logic from scratch.

---

## Step 4: Register the ID in `keys.ts` (fluent/now-sdk only)

> **Not using fluent?** Skip to Step 5 Option B.

Add to the `explicit` block in the repo's `keys.ts`:

```ts
          '<agent>-eval-runner': {
            table: 'sys_script_include';
            id: '<new-uuid>';
          };
```

---

## Step 5: Deploy

### Option A: Deploy via fluent (now-sdk)

```bash
pnpm run build:install
```

### Option B: Deploy via ServiceNow UI

1. Navigate to **System Definition > Script Includes** (or `sys_script_include.list`)
2. Click **New**
3. Fill in:
   - **Name**: `<AgentName>EvalRunner`
   - **API Name**: `<scope>.<AgentName>EvalRunner`
   - **Accessible from**: All application scopes
   - **Active**: true
4. Paste the runner code from Step 3 into the **Script** field
5. Save

---

## Step 6: Run the Eval

In **Scripts > Background** (Global scope — always use global, not the eval scope):

```js
var runner = new <scope>.<AgentName>EvalRunner();
var r = runner.run({ maxRows: '3' });
gs.info(JSON.stringify(r));
if (r.success) {
    gs.info('Dashboard: /now/now-assist-skillkit/evaluation-results-dashboard/' + r.evalRunId);
} else if (r.step === 'processAgenticEvalRun') {
    // Auto-process failed (e.g. localhost). Re-invoke manually:
    var p = runner.process(r.evalRunId, r.datasetId);
    gs.info(JSON.stringify(p));
}
```

`run()` auto-invokes `process()` internally, so a single call completes the full eval flow on cloud instances. Only call `process()` manually as a fallback if `run()` returns `step: 'processAgenticEvalRun'`.

Search system log for `[<scope>]`. Dashboard link is logged at the end.

> **Verify the deploy actually pushed.** The ServiceNow SDK can silently skip the push if it thinks the content hash is unchanged — `pnpm run build:install` reports success but the script include's `sys_updated_on` doesn't change. Query `sys_script_include` for your runner and check `sys_updated_on`. If stale, force a clean rebuild: `rm -rf dist build .now-cache && touch <runner>.server.js && pnpm run build:install`.

### Verify metrics actually scored (do not skip)

`auto_chat_task.status=complete` and `success_rate=100` only mean the agent finished its conversation. They do NOT prove each metric scored. Misconfigured metric mappings (especially GT-based) silently fall back to `NA` while Auto Chat reports success. After every run, confirm every configured metric produced at least one numeric score:

```js
var evalRunId = '<paste from r.evalRunId>';
var resultGr = new GlideRecord('sys_one_extend_eval_metric_result');
resultGr.addQuery('batch_run', evalRunId);
resultGr.query();
var byMetric = {};
while (resultGr.next()) {
    var name = resultGr.getDisplayValue('metric_capability') || 'unknown';
    var score = resultGr.getValue('score');
    byMetric[name] = byMetric[name] || { total: 0, na: 0, scored: 0 };
    byMetric[name].total++;
    if (score === '' || score === null || String(score) === '-2') byMetric[name].na++;
    else byMetric[name].scored++;
}
gs.info(JSON.stringify(byMetric, null, 2));
```

If any metric reports `scored: 0`, the eval is broken even if Auto Chat completed — see the Troubleshooting section below. The most common cause for GT metrics is a missing `attributeId` or wrong template path on the `groundtruthsysid` mapping.

---

## API Reference

`NowAssistSkillKitAPI.createAgenticEvalRun` signature (sn_skill_builder):

```
createAgenticEvalRun(name, testDatasetId, usecaseId, evaluationMethods,
                     usecaseTable, usecaseVersionId, usecaseVersionTable, evaluationType)
```

| Param | Position | Notes |
|---|---|---|
| `name` | 1 | Eval run display name |
| `testDatasetId` | 2 | Pass `''` — dataset is created separately |
| `usecaseId` | 3 | sys_id of `sn_aia_usecase` record |
| `evaluationMethods` | 4 | Array of metric objects |
| `usecaseTable` | 5 | `null` |
| `usecaseVersionId` | 6 | **VERSION_ID goes here** — sys_id of published `sn_aia_version` |
| `usecaseVersionTable` | 7 | `null` |
| `evaluationType` | 8 | `'agentic_ai'` |

---

## Eval Metrics

### Agentic-native metrics (use these)

Metrics are resolved dynamically by `_resolveMetrics()` — no hardcoded sys_ids. The method walks `sys_one_extend_capability` -> `sys_one_extend_capability_definition` -> `sys_generative_ai_config`.

| Metric capability name | What it scores |
|---|---|
| Overall task completeness evaluation | Whether the agent achieved the stated objective |
| Tool performance evaluation | Whether the agent selected appropriate tools |
| Tool calling evaluation | Whether tool calls used correct parameters |
| Plan evaluation | Quality of the agent's execution plan (optional) |

> **Verify metric names on your instance.** Names come from `sys_one_extend_capability` and may vary across platform versions. The `_resolveMetrics()` function will warn if a name isn't found.

### Non-agentic metrics (do NOT use for Auto Chat)

| Metric | Why incompatible |
|---|---|
| Faithfulness | Template expects `{{context}}` / `{{generated_response}}` — agentic pipeline doesn't populate these |
| Correctness | Same issue — null inputs produce garbage scores |
| Correctness w/ Golden | Same issue |

---

## Troubleshooting Failed Eval Runs

**Triage order — always check code before instance:**

```
1. CODE   — is the deployed runner correct? (most failures are here)
2. INSTANCE — is the required infrastructure present?
3. RUNTIME — check execution logs if both above are fine
```

### 1. Check the deployed runner

The generated template is correct by construction, but a stale deploy is common. Verify `sys_updated_on` on the `sys_script_include` record — if it's stale, the SDK silently skipped the push. Force a clean rebuild:

```bash
rm -rf dist build .now-cache && touch <runner>.server.js && pnpm run build:install
```

If still stale, delete the script include record on the instance and redeploy — the fluent record will recreate it.

Key fields to sanity-check in the deployed `.server.js`:

| Field | Must be | Wrong value (causes null results) |
|---|---|---|
| `testDataset.datasetSource` | `'ai'` | `'table'` — skips Auto Chat entirely |
| `datasetOutputTemplate` | `'{{auto_chat_level_one_result.execution_record}}'` | `'{{sn_aia_execution_plan.sys_id}}'` |
| `autoChatConfigDetails.context_scenario` | `'{{aia_artifact_dataset.context_scenario}}'` | missing/empty |
| `evaluationMethods` | agentic metrics only | Faithfulness/Correctness included — they score garbage on the Auto Chat path |
| `testDataset.table` | `'aia_artifact_dataset'` | `'sn_aia_execution_plan'` |

### 2. Check instance infrastructure

If the runner code is correct, verify the instance has what it needs (usecase, published
version, dataset records, Auto Chat config, REST endpoint) via MCP queries or a background
script, and see the Scope/ACL gotcha for "usecase not found" false negatives — see
[`references/troubleshooting.md#2-check-instance-infrastructure`](references/troubleshooting.md#2-check-instance-infrastructure).

### 3. Stuck runs

When the dashboard shows "in progress" forever, use `EvalCleanup` (or the manual unstick script
if it's unavailable) — see
[`references/troubleshooting.md#3-stuck-runs`](references/troubleshooting.md#3-stuck-runs).

### Common failure patterns

| Symptom | Root cause | Fix |
|---|---|---|
| All results null, zero agent traces | `datasetSource: 'table'` in runner | Change to `'ai'`, redeploy |
| Results null, Auto Chat tasks exist | Wrong `datasetOutputTemplate` | Change to `auto_chat_level_one_result.execution_record` |
| "capability value undefined" | Auto Chat infrastructure missing | Run infra checks above; create `auto_chat_configuration` |
| "Usecase not found" but record exists | Scope/ACL — Global can't see app-scoped records | Hardcode usecase sys_id in runner |
| `Security restricted: Read operation on 'sn_aia_usecase' denied` | Missing cross-scope access | Add `runtimeAccessTracking: "permissive"` to `now.config.json` |
| Scores all 0 but agent ran | Non-agentic metrics included (Faithfulness/Correctness) | Replace with agentic metrics: Tool perf, Tool calling, Task completeness |
| GT metric scores all `NA` | `groundtruthsysid` mapping misconfigured | Set `mandatory: true`, `attributeId: '21ffd174ff3362109903ffffffffff24'`, template `'{{aia_artifact_dataset.ground_truth}}'` |
| Dashboard stuck on "in progress" | Errored metrics don't increment `errored_capability_count` | Run `EvalCleanup` or unstick script above |
| Eval stuck at `draft`, `sys_one_extend_batch_run_task` shows old code | SDK silent-skip on redeploy (content hash unchanged) | `rm -rf dist build .now-cache && touch <runner>.server.js && pnpm run build:install` |
| Metrics not resolved | Capability names changed on instance | Query `sys_one_extend_capability` for available names |
| `undefined is not a function` for runner class | Script Include not deployed or wrong scope | Verify record exists on instance; redeploy |

---

## Files Generated

### Fluent (now-sdk) deployment

| File | Purpose |
|---|---|
| `<agent>-eval-runner.now.ts` | Fluent wrapper — deploys the Script Include |
| `<agent>-eval-runner.server.js` | The eval runner logic |
| `keys.ts` | Updated with the new ID |

### Platform UI deployment

| Output | Purpose |
|---|---|
| Script Include code | Paste into a new `sys_script_include` record on the instance |
