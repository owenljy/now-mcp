# aia-toolkit

Portable Agent Skills for building and evaluating **ServiceNow AI Agents**. Part of
the [`foundry-suite`](../../README.md) marketplace; pairs with the
[`now-mcp`](../now-mcp/README.md) plugin for live-instance reads and script
execution.

---

## Prerequisites

These skills are designed to work on top of a ServiceNow development stack:

- **A ServiceNow MCP** — connected to your agent host to query the instance, run
  background scripts, and verify agent configurations. `now-mcp` (this suite) is
  the natural pair, but the skills resolve against whatever ServiceNow MCP is
  connected.
- **now-sdk** — CLI tool for validating tables, columns, and API shapes against
  the live instance (`now-sdk query`, `now-sdk explain`).

Both are optional (skills include fallback background-script references and
embedded docs), but the full experience and fastest verification requires them.

## Installation

Follow the Claude, Codex, or Cursor instructions in the suite
[README](../../README.md#install).

`aia-toolkit` is **skills-only** — no setup form and no connection details of its
own. It uses whatever ServiceNow MCP you have connected for its live-instance
reads, so installing [`now-mcp`](../now-mcp/README.md) alongside it is the usual
setup.

---

## Skills

| Skill | What it does |
|---|---|
| `sn-aia-agent-builder` | Scaffold all agent files from a plain-English description (includes tool discovery) |
| `sn-aia-agent-audit` | Audit agents against best practices and deployment guardrails |
| `sn-aia-dataset-builder` | Create `aia_artifact_dataset` test case records |
| `sn-eval-runner-builder` | Publish version + isolated eval team + generate Script Include runner; also diagnoses failed runs |
| `sn-aia-trace-analyzer` | Analyze a deployed agent's runtime execution trace — wrong answers, phantom success, GAIC errors |

---

## Where to start

| Situation | Skill |
|---|---|
| New agent | `sn-aia-agent-builder` |
| Quality check on deployed agent | `sn-aia-agent-audit` |
| Set up platform evals | `sn-eval-runner-builder` → `sn-aia-dataset-builder` |
| Add test cases to existing agent | `sn-aia-dataset-builder` |
| Re-score after instruction changes | Now Assist → Evaluations → New → Choose from existing datasets |
| Eval failed / null results / stuck run | `sn-eval-runner-builder` (Troubleshooting section) |
| Deployed agent gave wrong/empty answer | `sn-aia-trace-analyzer` |

---

## Eval flow (code path)

1. `sn-aia-agent-builder` — generate agent files, deploy
2. `sn-eval-runner-builder` — publish version, create isolated eval team, generate runner
3. `sn-aia-dataset-builder` — generate test cases, deploy
4. Run `new <AgentName>EvalRunner().run()` in Scripts > Background (agent app scope)
5. Results at **Now Assist > Evaluations**

**Metrics:** Auto Chat uses agentic metrics only — Tool performance, Tool calling,
Task completeness. Do NOT use Faithfulness/Correctness with Auto Chat — they
produce garbage scores. See [references/eval-metrics.md](references/eval-metrics.md).

---

## Runtime testing

Template: `scripts/background/run-agent-test.template.js` — fill in
`USECASE_ID` and `OBJECTIVE`, run in Scripts > Background (global scope).
