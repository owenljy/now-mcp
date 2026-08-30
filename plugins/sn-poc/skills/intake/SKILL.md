---
name: intake
description: Run the full ServiceNow PoC intake pipeline from raw idea through discovery, specification, and planning. Use as the main entry point or to resume an existing intake from its current phase.
---

# PoC Intake

Read `../../agents/pipeline-agent.md` in full and follow it exactly. It is the single source of truth for phase detection, approval gates, referenced workflows, and completion criteria.

Use the PoC idea in the current request and conversation. If none was provided, check `./intake-docs/` for existing progress first. If nothing exists yet, ask: "What PoC are you working on? Give me a rough idea — even a sentence is enough to start."

## How this works

This skill runs the full intake flow in sequence:

1. **Discovery** — challenge the idea, generate customer meeting questions, produce a customer-ready brief
2. **Spec** — turn customer meeting answers into a PoC spec (customer-approvable) and technical spec (engineering-ready)  
3. **Planning** — decompose the tech spec into self-contained implementation stories

Each phase gates on the previous one. You will be prompted before crossing each boundary — nothing runs ahead of you.

**Resuming mid-flow:** the pipeline detects what already exists in `./intake-docs/` and picks up from the right phase automatically.

**Re-entering a specific phase:** invoke the `discover`, `spec`, or `planning` skill directly.
