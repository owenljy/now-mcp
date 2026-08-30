---
name: discover
description: Challenge a ServiceNow PoC idea, generate customer meeting questions, anticipate end-user FAQ, and produce a customer-ready discovery brief. Use when preparing PoC discovery or a customer meeting.
---

# Discover

Use the PoC idea in the current request and conversation. If none was provided, ask: "What PoC are you planning to discuss with the customer? Give me a rough description — even a sentence is enough to start."

## How this skill works

Read and follow two workflow files in sequence:

1. Read `../../agents/discovery-agent.md` in full and follow it exactly. It challenges the idea, surfaces weak assumptions, and produces `discovery-brief.md`.

2. After the user approves the discovery brief, read `../../agents/faq-agent.md` in full and follow it exactly. It anticipates end-user questions and produces `index.html`.

Do not start the second workflow before the approval gate.
