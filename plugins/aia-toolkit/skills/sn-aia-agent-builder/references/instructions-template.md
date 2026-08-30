# File content the skill owns

Templates and authoring rules for the markdown files the builder generates for an
agent: `<agent>-instructions.md`, the generated agent's runtime "Step 8 — Error
handling" section, and `<agent>-proficiency.md`.

---

## `<agent>-instructions.md`

```md
# Objectives
Your objective is to <state the goal clearly>.

# Validations
- First check <precondition>. Do NOT proceed until confirmed.

# Steps
1. <First step — reference the tool by its exact name>
   1.1. <sub-step / conditional>
   - If <condition>, then <action>.
2. <Next step — gate pattern>
   - Do NOT move forward until <prior output> is collected.

# Verify   <!-- emit ONLY for mutating/deploy agents (see Step 2 honest-outcome detection) -->
- Before declaring success, independently confirm <desired state> holds (re-read the record
  / re-query the external system — do NOT trust the mutating tool's own success return).
- If the verify read fails, treat it as **inconclusive**: re-check once, then escalate.
  Do NOT report success or failure on an inconclusive read.

# Expected Output
- **Field**: [value]

# Success Criteria
- <criterion>

# Outcome   <!-- run-level terminal outcome; always at least success + escalated -->
- **success** — only after the `# Verify` step confirms <desired state>. If a tool returned
  `dryRun: true` / `mock: true`, the side-effect did NOT occur — report the dry-run/mock
  outcome, never a real success.
- **escalated** — if bounded retries are exhausted, `# Verify` stays inconclusive after a
  re-check, or there is no safe next action: hand off to <named queue/human> with the full
  trail and end. (See [../../../references/tool-output-patterns.md → Run-level terminal outcomes](../../../references/tool-output-patterns.md).)

# Constraints
- NEVER <prohibited>. ALWAYS <required>.
```

> **`# Verify` vs `# Success Criteria` (verify gate):** `# Verify` is an independent
> **read of the mutation's end-state** with an inconclusive-on-read-error rule
> (mutating/deploy agents only); `# Success Criteria` is the general completion
> checklist. For a mutating agent the `# Verify` gate is the stronger, specific one.

**Instruction rules** (ServiceNow AI Agents Prompting Guide):
- Imperative voice ("Analyze…", not "You should analyze").
- Reference tools by their exact `name`.
- Always say "the user" — never role titles.
- No system prompts ("think step-by-step") — the orchestrator handles that.
- Explicit gates between dependent steps; explicit end / success criteria.
- One step = few actions, much context; use If/Then.

---

## The generated agent's runtime "Step 8 — Error handling" (required for API agents)

Every agent that calls external APIs needs a scoped error contract so benign
branches don't fire the error path:

```markdown
## Step 8. Error handling
**Scope:** fires ONLY when an external-API tool (`<your REST tools>`) returns a
response containing an `__error_code` field. Does NOT fire for:
- `{exists: false, ...}` (a legitimate domain branch)
- action tools returning `{success: true, note: "..."}` (soft-failed by design)
- action tools returning `{success: true, dryRun: true|mock: true, ...}` (dry-run/mock —
  side-effect intentionally skipped; report the dry-run/mock outcome, NOT an error)
- `success: false` without `__error_code` (treat as success with noted state)

On any `__error_code`: present the exact canned apology, write a work note with
`__error_code`/`__error_message`/partial state (skip if no caseSysId), hand off,
and end (this handoff is the `escalated` run outcome).
```

An `__error_code` is one path into escalation, but not the only one: *any* genuinely-stuck
state (bounded retries exhausted, `# Verify` inconclusive after re-check, no safe next
action) also resolves to `escalated`. **Because this Step 8 section is scoped "(required for
API agents)", a mutating agent with no external API skips it** — so the escalate branch must
also be reachable from the `# Outcome` block in the instructions template (which every
mutating agent gets), not only here.

**dryRun/mock are read on the success path, not here.** A `{success: true, dryRun: true}` /
`{mock: true}` return is not an error — the generated instructions must tell the LLM that
such a return means the side-effect did NOT happen, so it reports the dry-run/mock outcome
rather than a real success (this is the success-interpretation path, distinct from Step 8).

The **canonical Step 8 contract lives in `../../../references/tool-output-patterns.md` ("Step 8 error
contract" + "Run-level terminal outcomes")** — including the escalate branch and the
dryRun/mock rows. Keep this copy condensed and point there rather than restating
the branches. Classify each tool into patterns 1–4 before writing instructions (if you
can't, the tool does too much — split it).

> The builder *prevents* phantom success here; the `/sn-aia-trace-analyzer` skill *catches*
> it at runtime if it slips through.

---

## `<agent>-proficiency.md`

Bullet list, one capability per line, specific about tools/data used (drives
routing).
