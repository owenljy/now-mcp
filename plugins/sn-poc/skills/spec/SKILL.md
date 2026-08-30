---
name: spec
description: Transform ServiceNow PoC discovery findings and customer answers into a customer-approvable specification and an engineering-ready technical specification. Use when writing or revising a PoC spec.
---

# Spec

Create PoC and technical specifications for this PoC.

## Pre-flight Check

1. Run `ls ./intake-docs/discovery/discovery-brief.md` to verify discovery is complete
2. If the file is missing, tell the user: "No discovery brief found. Run the `discover` skill first to prepare for the customer meeting." and **stop immediately**

## Task

Transform the discovery findings and customer meeting answers into:
1. A complete PoC specification the customer can approve
2. A complete technical specification the engineering team can implement from

Read `../../agents/spec-agent.md` in full and follow its Phase A through Phase B9 workflow exactly. Save all output to `./intake-docs/spec/`.
