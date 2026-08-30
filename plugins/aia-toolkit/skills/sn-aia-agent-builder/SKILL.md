---
name: sn-aia-agent-builder
description: Designs a ServiceNow AI Agent from a plain-English description and emits it as now-sdk typed Fluent (AiAgent / AiAgenticWorkflow). Use whenever the user wants to create, scaffold, edit, or design a ServiceNow AI agent or agentic workflow (sn_aia_* tables). Trigger even on a bare description — "build me an agent that…", "create an AI agent for…". The skill owns intent→architecture→instructions→scripts→quality; now-sdk owns the table structure.
---

# ServiceNow AI Agent Builder

Turns a plain-English description into a reviewed **Agent Design Spec**, then emits
it as **now-sdk typed Fluent** and the agent's instructions + Rhino tool scripts.

> **Prerequisite — check before proceeding:** `now-sdk` must be in this repo's
> dependencies — it deploys the generated files and owns the agent structure. Check
> `package.json` for `@servicenow/sdk`. If it's missing, **stop and tell the user**:
> "now-sdk isn't a dependency in this repo — I can still design the agent, but
> deployment (Step 9+) will fail until it's installed." Don't discover this silently
> partway through. Always use the latest installed SDK; run `now-sdk explain
> aiagent-api` before emitting to surface the current param surface (see Step 3).

## Division of labour — work hand-in-hand with now-sdk

| Concern | Owner |
|---|---|
| Table relationships, columns, defaults, ACL/role plumbing, types | **now-sdk** (`AiAgent()` / `AiAgenticWorkflow()` / `Alias()` / `Acl()`) |
| Understanding intent, choosing the architecture, tool reuse | **this skill** (interview → Design Spec) |
| Instruction & proficiency authoring, error contract | **this skill** |
| Rhino `.js` tool/agent scripts (the runtime contract) | **this skill** |
| Anti-pattern / audit / deploy / smoke test | **this skill** |

**Do not hand-roll agent/workflow records with `Record()`** — the typed API
generates them (counts + rationale: [references/now-sdk-emitter.md](references/now-sdk-emitter.md)).
The *intent* structure is [references/agent-design-spec.md](references/agent-design-spec.md).
For exact param shapes, run `now-sdk explain aiagent-api` / `aiagenticworkflow-api`.

### Anti-staleness rules (non-negotiable)

- **A1 — Prefer the typed API.** Emit `AiAgent()` / `AiAgenticWorkflow()`. Use
  `Record({ table: 'sn_aia_*' })` only for a confirmed gap (see the emitter's
  "Gap policy"), in one commented place.
- **A2 — Never write a sys_id for `sn_aia_*` structure.** Roles by name
  (`roleMap` / `securityAcl.roles`), cross-refs by JS variable. A 32-char hex
  literal in an agent file is a bug — caught by anti-pattern scan check **[12]**
  (the old `strategy: 'b264…'` is exactly what this kills).
- **A3 — Externalize customer/environment-specific values.** Generalizes A2 to
  *all* environment-specific values (endpoint URL, queue/group sys_id, MID,
  threshold, software/serial name): a **server script** (tool script,
  `applicability`, or `context-processing`) must read them from a system property
  (`gs.getProperty` with a safe default) or the connection & credential alias at
  runtime — never bake them in or take them as an input if config can supply them
  (the Step 2b credential-minimization rule, generalized). Non-hex config is audit
  warning **W10**.

---

## Scope Model

Decide one scope vs two **before** generating:

| Mode | When | Structure |
|---|---|---|
| **Single scope** | Internal tools, prototypes, eval ships with the agent | Everything in `src/fluent/agent/ai-agent-<name>/` |
| **Two scopes** | Shipping to customers — agent is deliverable, eval dataset is internal-only | Agent in `src/fluent/agent/ai-agent-<name>/`; eval dataset + metrics in `src/fluent/eval/ai-agent-<name>/` |

The eval **runner** Script Include always lives with the agent scope (it's code,
not test data). Captured as `scope` in the Design Spec.

---

## Step 1: Interview the User

Ask **one question at a time**, waiting for each answer. For fixed-choice
questions (Q0, Q3–Q9) use **AskUserQuestion** with structured options; use free
text only for Q1 (name) and Q2 (capabilities) and explicit follow-ups. The
interview fills the **Agent Design Spec** — do not generate any file until the
Spec is reviewed (Step 2d).

### Express lane (skip what the description already answers)

Read the user's initial request and pre-fill every Spec field it already answers
(name, capabilities, scope, roles, active-on-deploy, connection need, workflow,
run-as identity, triggers, access). Present the inferred answers back in **one
batch** for confirmation, then ask only what's genuinely missing, one at a time.
If the description is vague, fall back to the full one-at-a-time interview. The
express lane changes batching/order only — it never skips the Spec review gate,
and Q1/Q2 must always be confirmed.

0. **New or editing?** — New agent / Editing an existing one.
   - **Editing:** ask for the agent's fluent folder, read every file in it first,
     then ask **What would you like to change?** (AskUserQuestion multi-select): add
     tool / edit tool / remove tool / change instructions / change name+description
     / change roles / change active status / other. Only ask follow-ups for the
     selected changes; touch only the affected files.
   - **New:** continue below.

0a. **Scope setup** — Same scope as agent, or separate eval-only scope? (Single /
    Two scopes). If two, get both scope names now.

1. **Agent name** — e.g. "Incident Triage Agent".
2. **What should it do?** — Questions it answers / tasks it performs, with concrete
   examples. If it calls external APIs, ask **which vendor(s)/service(s)**.
   - **Discover reusable resources before proposing any new tool.** Run the
     parallel discovery queries per capability keyword, then map hits to builder
     tool types — full query table + mapping in
     [references/tool-discovery-queries.md](references/tool-discovery-queries.md).
     If an existing agent covers the use case, suggest extending it (Q0 "editing").
   - **Propose the tool set.** For each: name, `kind` (oob / rag / capability /
     subflow / action / catalog / topic / mcp / crud / script), one-line purpose,
     and **Reuse** vs **New**. Apply the selection priority (Step 2b). Any `script`
     tool, and any capability discovery found nothing reusable for, needs a one-line
     reuse/governance rationale recorded in the Spec.
     - Script tools are **1:1 with a single external API call** — never chain
       multiple calls in one script; orchestrate across tools via instructions.
     - **Connection Lookup:** script tools that hit 3rd-party APIs need a
       `connectionSysId`. Add a `crud` tool that resolves an `http_connection` by
       name/sys_id and returns `sys_id`/`name`/`connection_url`, and have
       instructions call it first.
3. **Who can use it?** — Open / Restrict to specific roles → ask which **role names**.
4. **Active on deploy?** — Active / Inactive.
5. **HTTP connection alias?** — Yes / No. If yes, get a connection name. (Emitted
   via now-sdk's `Alias()` — see emitter ref, not a hand-rolled `sys_alias`.)
6. **Workflow/team?** — New workflow / Existing (reference it) / None.
7. **Run-as identity** — Dynamic User / AI User.
   - **Dynamic User** — runs as the invoking user, restricted to roles. Emits
     `dataAccess.roleMap: [<role names>]`. **Role NAMES, not sys_ids** (now-sdk
     resolves names per instance). Ask which roles. Mandatory in this mode.
   - **AI User** — runs as a service account. Emits `runAsUser: <user>`.
   - **If the agent has any trigger (Q8), Dynamic User is not allowed** — async
     trigger context requires a real run-as user. Forces AI User.
8. **Triggers** — None/manual / Record create-update / Scheduled / Email. Emitted
   as `triggerConfig` on `AiAgent()` (`triggerFlowDefinitionType`, `targetTable`,
   `triggerCondition`, `objectiveTemplate` with `${field}`; `schedule` for
   time-based). **The post-deploy `sys_security_acl` for triggers is still a
   `security_admin` Background Script, not SDK-written** — see
   [docs/trigger-mode-setup.md](../../references/trigger-mode-setup.md) for that script and
   the verification script.
9. **Access (who can invoke)** — Any authenticated user / Specific roles (ask which)
   / Public. Emitted as the `securityAcl` param (auto-builds the ACL + roles).

---

## Step 2: Clarify if Needed

If tools or instructions are ambiguous, ask ≤3 focused follow-ups (e.g. "does this
tool mutate state or is it read-only?" → drives autopilot vs copilot).

**Honest-outcome detection (drives the `# Verify` + `# Outcome` blocks below).** Ask:
**"Does the agent mutate state, deploy, or write to an external system?"** If yes:
- the generated instructions MUST include an independent **Verify** step before the agent
  declares success (a verify-time read error is **inconclusive** — re-check or escalate,
  never spun as success or failure);
- the instructions MUST resolve to a labeled run-level terminal outcome (`success` /
  `escalated`) — see `# Outcome` in the instructions template and
  [../../references/tool-output-patterns.md → Run-level terminal outcomes](../../references/tool-output-patterns.md).

## Step 2b: Tool Selection Priority (active gate)

Before locking the Spec, run this **per tool**, not as a passive preference:

1. **OOB first** — `web_automation`, `knowledge_graph`, `file_upload`,
   `deep_research`, etc.
2. **Reference-based** — `capability` (Now Assist skill), `subflow`, `action`,
   `catalog`, `topic` — reuse existing instance resources.
3. **crud** — direct DB ops (now-sdk auto-generates the script from `inputs`).
4. **script** — only when nothing above fits.

For each tool you'd make `script`, AND whenever discovery found nothing reusable,
ask: does this logic have **reuse or governance value** (other agents need it, it
mutates state, it warrants Flow Designer auditing)?
- **Yes** → make it an `action`/`subflow` referencing a Flow Designer backend
  (leave the backend as a TODO), not a script.
- **No** → script is acceptable.
Record the chosen `kind` + rationale in the Spec.

- **Journal-field rule (hard override):** `work_notes`, `comments`,
  `activity_stream` always use a **script** tool with `GlideRecordSecure`, never
  `crud`.
- **crud column check:** verify columns exist on the target table; note them.
- **Credential minimization:** don't add an input for anything a script can read
  from the connection/credential at runtime (e.g. Azure subscription id =
  `credential.getAttribute('user_name')`). Only expose values that genuinely vary
  per call. See [references/credential-auth.md](references/credential-auth.md).

## Step 2d: Produce & Review the Design Spec (the architecture gate)

Assemble everything into the **Agent Design Spec**
([references/agent-design-spec.md](references/agent-design-spec.md)) and present it
to the user as one YAML block — this is the architecture review. It supersedes a
separate file manifest: the Spec *is* the plan (shape, agents, tools+kinds,
run-as, access, triggers, scope, connections).

Ask the user to confirm or correct it. **Do not generate any file until the Spec
is approved.** This is the human-in-the-loop checkpoint.

---

## Step 3: Emit the Fluent (typed API)

Once the Spec is approved, **before writing any file**, run:

```bash
now-sdk explain aiagent-api
# if generating a workflow:
now-sdk explain aiagenticworkflow-api
```

Use the output as the authoritative param surface for the installed SDK version.
The emitter reference ([references/now-sdk-emitter.md](references/now-sdk-emitter.md))
shows structural patterns and rules — but `now-sdk explain` wins on specific param
names, required fields, and enum values. If the two conflict, follow `now-sdk explain`
and note the discrepancy.

Then generate files into `src/fluent/agent/ai-agent-<name>/`.

**Editing an existing agent:** edit only the affected parts of the single
`AiAgent()` file (add/remove a `tools[]` entry, change `versionDetails`
instructions, change `securityAcl`/`dataAccess`), and the matching `.md`/`.js`.
Don't regenerate unchanged files.

**New agent / workflow:**
- One `<agent>-agent.now.ts` per agent via `AiAgent({...})` — tools are entries in
  its `tools[]` array (no separate tool / m2m / config / version / acl files).
- `<agent>-instructions.md` and `<agent>-proficiency.md` (skill-owned content,
  pulled in via `Now.include` / `versionDetails`).
- If a workflow: one `<workflow>-workflow.now.ts` via `AiAgenticWorkflow({...})`
  whose `team.members` reference the agent variables. For an existing workflow,
  reference its team; don't regenerate it.
- Agent scripts (`applicability` / `context-processing`) and **script-tool**
  `.js` files under `src/server/agents/<agent>/…` (see Step 4 + Runtime Contract).
- HTTP connection alias → now-sdk `Alias()` (emitter ref), only if requested.

Per-tool execution fields (`executionMode`, `displayOutput`,
`outputTransformationStrategy`, `maxAutoExecutions`) live on each `tools[]`
entry — judgment, not plumbing. Defaults + override rules:
[references/now-sdk-emitter.md](references/now-sdk-emitter.md) (Per-tool execution
fields).

### Directory structure

```
src/fluent/agent/ai-agent-<agent>/     # AiAgent()/AiAgenticWorkflow() .now.ts + skill-owned .md
src/server/agents/<agent>/             # agent-scripts/ + tool-scripts/ (plain-JS IIFEs)
```

Full annotated tree in
[references/now-sdk-emitter.md](references/now-sdk-emitter.md) (Directory
structure). The per-table `Record()` sprawl is gone — the typed API generates
those records.

---

## Step 4: Author script-typed tool `.js` files

Only **`script`**-typed tools need a hand-written `.js` (crud scripts are
auto-generated by now-sdk from `inputs`). For each script tool, interview the user
one question at a time:

- **Does it call a 3rd-party API?** If so, **which vendor/API?** Then, *before
  writing code*:
  1. Search `src/server/` for existing files for that vendor; read the API-call
     files **and** the auth/helper logic they reference (helpers are inlined per
     the Runtime Contract, not imported).
  2. Trace credentials end-to-end — find where the vendor client is constructed,
     follow the credential back to its source, read it. Don't assume the credential
     accessor (e.g. AWS needs `getAuthCredentialByID()`, not `getCredentialByID()`).
  3. Only then write the IIFE, mirroring the codebase's auth/HTTP/parse pattern. If
     no vendor code exists, find the API docs (ask for a link if needed).
- If it's not an API call, get inputs/outputs/logic; implement if simple, else
  leave a clear TODO.
- **Minimize inputs** (credential-minimization rule, Step 2b).
- Write the file at `src/server/agents/<agent>/tool-scripts/<tool-name>.js` as a
  plain-JS IIFE (see Runtime Contract). Reference it from the tool's `script` field
  via `Now.include('<source .js>')`. No `.ts`, no `dist/`.

> Start from the known-good templates:
> [`scripts/tool-scripts/rest-tool.template.js`](../../scripts/tool-scripts/rest-tool.template.js)
> (REST + connection lookup) and
> [`scripts/tool-scripts/action-tool.template.js`](../../scripts/tool-scripts/action-tool.template.js)
> (soft-fail action). Vendor `getAttribute` keys / special auth:
> [references/credential-auth.md](references/credential-auth.md).

**Dry-run / mock guard (SHOULD, for script-typed state-mutating tools).** A state-mutating
**script** tool SHOULD support a config-driven dry-run guard: it runs the real code path
(resolve connection, build payload, validate, check permissions) and skips **only** the
irreversible side-effect, returning a distinctly-labeled result (`dryRun: true` / `mock:
true`). This makes the tool eval-safe and demoable offline with no rebuild — an admin flips
a system property (`gs.getProperty('<scope>.dry_run')`). The opt-in guards are already in
the two templates above. Return shapes + the flag→outcome rule live in
[../../references/tool-output-patterns.md → Run-level terminal outcomes](../../references/tool-output-patterns.md).
This is a SHOULD, not a MUST. `action`/`subflow` tools get their dry-run behavior in Flow
Designer, not here.

## Step 5: Test scripts (optional, do not skip the ask)

After generating each script `.js`, ask **Do you want to test this before moving
on?** Build a **testable version**: a hardcoded `TEST VALUES` block replacing every
`inputs.<field>`, the function body inlined, and every `return <v>;` rewritten to
`gs.info(JSON.stringify(<v>));`.
- **Resolve `run_privileged_script`** (see
  [../../references/mcp-capability-resolution.md](../../references/mcp-capability-resolution.md))
  and run it via that tool, showing the captured output. (On the `servicenow`
  MCP this is `sn_execute_background_script`, not `execute_script` —
  that tool no longer exists.)
- **No match found:** present the testable version in a `js` block and ask the
  user to run it at `sys.scripts.do` and share output.
Debug failures before the next script.

## Step 6: MCP-typed tools

For each `mcp`-kind tool entry, get the vendor/server and capability. If the MCP
server is connected and its tools are in ToolSearch, fetch the schema and use the
**exact** tool function name and description verbatim, and derive `inputs` from its
parameters. The MCP tool name must match the server's function name exactly — a
mismatch causes routing failure. Reference an existing `sn_mcp_server` by its
record, or create one via now-sdk if needed (don't hand-roll if a typed path
exists; check `now-sdk explain`).

---

## Runtime Contract for Tool & Agent Scripts (READ FIRST)

**The runtime is a Rhino sandbox, not Node.js.** Any script stored in a record
field — a `script`-tool's source, `applicabilityScript`, `contextProcessingScript`
— is saved as a string and `eval`'d by Rhino. Rhino has **no module system**: no
`exports`/`module`/`require`/`import`/`export`. `Now.include('<path>')` is
`fs.readFileSync()` — it does not compile or transform. Whatever bytes are in the
file are what Rhino runs.

**So these scripts are plain `.js` IIFEs, and `Now.include()` must point at the
source `.js`, never a `dist/` output.** Copy the canonical IIFE template from
[references/runtime-contract.md](references/runtime-contract.md) (Required IIFE
shape) — that file also holds the full Rhino-failure rationale.

Rules (enforced by `scripts/anti-pattern-scan.sh`):
- **IIFE** whose final top-level expression is `(function(inputs){…})(inputs)`.
- **No `import`/`export`/`require`.** Reference `GlideRecordSecure`,
  `RESTMessageV2`, `gs.*`, `sn_cc.*` directly.
- **Inline every helper** (no shared `utils.js` — Rhino can't load it).
- **Return on every path**, success and error; never fall through to `undefined`.
- **`Now.include()` the source `.js`** — never `dist/`.

> now-sdk may support a module-import form for `script`-tool content in newer
> SDKs; if you use it, follow `now-sdk explain aiagent-api`. The `Now.include`
> source-`.js` path above is the safe, runtime-correct default.

### Agent scripts (applicability / context-processing)

Same Rhino rules. `applicability` returns a boolean; `context-processing` returns
the (possibly modified) context object `{ pageContext, triggerContext }`. Author as
plain-JS IIFEs and `Now.include` the source. **Include-path depth:** resolve every
`Now.include` relative to the `.now.ts` that contains it — count the `../` hops to
`src/` and continue down (note the hop that lands in `src/` means the path resumes
at `server/…`, not `src/server/…`). Anti-pattern scan check **[10]** verifies every
include resolves to a real source file — recount if it fires.

---

## File content the skill owns

The builder generates three markdown files per agent — `<agent>-instructions.md`
(with the `# Verify` gate and `# Outcome` block), the runtime **Step 8 — Error
handling** contract (required for API agents), and `<agent>-proficiency.md`. The
full templates, instruction rules, and the phantom-success / verify-gate rationale
live in **[references/instructions-template.md](references/instructions-template.md)** —
read it before writing any of these files.

Key reminders (full detail in the reference):
- Classify each tool into output patterns 1–4 before writing instructions; if you
  can't, the tool does too much — split it.
- The `escalated` outcome must be reachable from the `# Outcome` block for mutating
  agents that skip Step 8 (no external API).
- The builder *prevents* phantom success; `/sn-aia-trace-analyzer` *catches* it at
  runtime if it slips through.


---

## ID Generation Rules

- `Now.ID['<descriptive-name>']` for every `$id` — deterministic, stable sys_id.
- Cross-references use the JS variable (`agent`, `team`), not `Now.ID[...]` again.
- Names unique within scope (kebab-case, include record kind). Reusing a name
  collides two records onto one sys_id — the second silently overwrites. Scan check
  **[11]** must be zero.

## Workflow vs Single Agent

1. Multiple tasks (AND / THEN)? No → **single agent**. Yes → continue.
2. Different **capability types** (search + summarize; table A + table B)? No →
   single agent, multiple tools. Yes → **workflow, multiple agents**.

Decompose by capability / by domain / by phase. Split at >5 tools per agent; 2–3
agents for most workflows; non-overlapping responsibilities; clear names. (This is
judgment; `now-sdk explain building-ai-agents-guide` has the platform's own
decision tree if you need it.)

---

## Step 7: Lint

`npx eslint --fix <generated files…>` (list paths explicitly; server scripts are
plain JS — lint as scripts). Fix remaining errors manually and re-lint before the
summary.

## Step 7b: Anti-pattern scan

```bash
scripts/anti-pattern-scan.sh .
```
Fix every "MUST be zero" hit — including **[10]** (all `Now.include`s resolve to a
real `.js`/`.md` source, not `dist/` or a miscounted depth) and **[11]** (no
duplicate `Now.ID`). **Add/confirm these checks** (see Step "audit"):
- no `Record({ table: 'sn_aia_*' })` where a typed API exists;
- no 32-char hex literal in agent files (rule A2).

Manual spot-check: instructions start with the RULES preamble; role is one
paragraph; every script uses `GlideRecordSecure` with `canRead()/canWrite()`;
every script is an IIFE with no module syntax returning on every path; placeholder
style consistent; instructions ≤ 400 lines.

## Step 7c: Static self-audit

Run `/sn-aia-agent-audit` in **Local audit** mode on the generated folder; apply
all blocker and warning checks the audit reports in Local audit mode. Fix blockers
(re-enter Step 3 → 7 → 7b → 7c) before the summary; surface warnings with it.

## Step 8: Copy to target deployment repo & deploy

This repo is a workspace. Ask which repo to deploy to, copy the files, then:
1. **Re-derive every `Now.include` path** from its new depth (a path correct here
   is almost never correct at the target).
2. Server scripts stay plain `.js` source (no `dist/`).
3. Re-run `scripts/anti-pattern-scan.sh <target>` — checks [3] (no `dist/`) and
   [10] (includes resolve) must be zero.
4. Deploy with **`now-sdk deploy`** (this skill only scaffolds; it does not deploy).

## Step 9: End-to-end smoke test (optional — requires a resolved MCP tool + opt-in)

Triple-gated: a matching MCP tool resolves, the connected instance is
confirmed non-production, AND user says yes.

**Instance safety gate — before any write.** "Prefer a non-prod instance" is
documentation, not enforcement — this step writes real records to whatever
instance now-sdk/MCP are currently connected to. Before running:
1. Resolve the connected target: call `sn_sdk_status` if the MCP
   exposes it (or inspect the active now-sdk profile / `now.config.json`), and
   state the resolved instance name/host to the user.
2. If resolution fails, or the name/host looks like a customer or production
   tenant, stop and ask the user to explicitly confirm this instance is
   intended for a real-record smoke test before proceeding. Do not proceed
   silently.

Confirm the agent/usecase is deployed by resolving `read_records` on
`sn_aia_agent` / `sn_aia_usecase` (see
[../../references/mcp-capability-resolution.md](../../references/mcp-capability-resolution.md)),
pick one example question from the Spec, launch-and-poll by resolving
`run_privileged_script` (the pattern in `/sn-aia-trace-analyzer` Phase 1
Option C), and inspect for failure / phantom success (a
`sn_aia_tools_execution` row `completed` but empty `response`). On any
failure, route to `/sn-aia-trace-analyzer` with the execution plan sys_id.

## After generating

Tell the user: which files were generated and why; the target repo; that
action-typed tools need their Flow Designer backend built; that a requested
connection alias needs finishing at `sys_alias.list` after deploy; and offer the
Step 9 smoke test (or remind them to test manually and use `/sn-aia-trace-analyzer`
if a deployed run misbehaves). Ask if they want to adjust anything before saving.
```

> **Next steps after this skill:** `/sn-aia-dataset-builder` (eval test cases),
> `/sn-eval-runner-builder` (publish version + isolated team + runner),
> then `/sn-aia-agent-audit` and `/sn-aia-trace-analyzer` for ongoing quality.
