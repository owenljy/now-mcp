# Planning Templates

> Reference file for the planning-agent. These templates define the exact structure of all planning output files. Follow them precisely for consistency across PoCs.

---

## stories/STORY-XXX.md

```markdown
# STORY-XXX: <title>

**Status:** draft | ready_for_review
**Complexity:** S | M | L
**Depends on:** <STORY IDs or "None">

## User Story

As a <persona>,
I want <capability>,
So that <value>.

## Acceptance Criteria

- [ ] <specific, testable criterion>
- [ ] <specific, testable criterion>
- [ ] <specific, testable criterion>

## PoC Spec Traceability

> Which acceptance criteria from the PoC specification this story satisfies.

| PoC Spec Story | Acceptance Criterion |
|-------------------|---------------------|
| <story title from PoC spec> | <specific AC text> |

## Technical Context

- **Tables:** <affected tables>
- **Components:** <affected scripts, widgets, integrations — use exact names from tech spec>
- **Patterns:** <existing patterns to follow, with file references>
- **Tech Spec Sections:** <which sections of the tech spec this story implements — e.g., "Data Model > visitor_rsvp table", "Business Logic > VisitorService", "Notifications > visitor.checked_in event">

## Implementation Steps

> Ordered list of steps to implement this story. Each step is a single-concern unit of work (1-4 hours). Execute in order.

### Step 1: <title>

**Tech Spec Reference:** <exact section — e.g., "Data Model > sn_wsd_visitor_rsvp table">
**Estimated:** <hours>h

<What needs to be accomplished and why.>

**Requirements:**

- <specific requirement>
- <specific requirement>

**Interface Contract:**

*Creates:*

| Type | Name | Detail |
|------|------|--------|
| <Script Include / Method / Field / Business Rule / ACL / Event / Property / etc.> | `<exact_name>` | <signature, type, or definition — e.g., "validateVisitor(visitor_id: String): Boolean"> |

*Consumes:*

| Component | What | From |
|-----------|------|------|
| `<exact_component_name>` | `<method or field used>` | <Step N of this story or STORY-XXX> |

> If this step creates nothing new (e.g., an ACL step), the Creates section lists the ACL record with its exact name. If it consumes nothing, state "None."

**Files to Modify:**

| File | Change |
|------|--------|
| <path> | <description of change> |

**Implementation Notes:**

<Patterns to follow from existing code, gotchas, reference files. Do NOT include tool-specific syntax.>

**Test Criteria:**

- [ ] <test 1>
- [ ] <test 2>

### Step 2: <title>

...(same structure as Step 1)...

## Revision History

- <date>: Initial creation
```

---

## reviews/review-vN.md

```markdown
# Plan Review v<N>

**Date:** <timestamp>
**Stories:** <count>
**Implementation Steps:** <total count across all stories>

## Critical Issues (Must Fix Before Implementation)

<Issues that would cause failure, security vulnerabilities, or significant rework>

- **Issue 1:** <specific problem> → <specific fix>
- **Issue 2:** <specific problem> → <specific fix>

## High Priority Issues (Should Fix)

<Missing coverage that creates meaningful risk>

- **Gap 1:** <what's missing> → <how to address>

## Medium Priority Issues

<Should fix if straightforward>

## Low Priority Issues

<Nice to have improvements>

## Open Questions

<Ambiguities requiring human decision-making>

- **Question 1:** <the ambiguity> — Options: [A, B, C]

## Validated Strengths

<What the plan got right — be specific and genuine>

## Assumption Register

| Assumption | Risk if Wrong | Validation Method |
|------------|---------------|-------------------|
| ... | ... | ... |
```

---

## dependency-graph.md

```markdown
# Story Dependency Graph

**Generated:** <timestamp>

## Execution Waves

### Wave 1 (No dependencies)

- STORY-XXX: <title>
- STORY-XXX: <title>

### Wave 2 (After Wave 1)

- STORY-XXX: <title> ← depends on STORY-XXX
- STORY-XXX: <title> ← depends on STORY-XXX

### Wave 3 (After Wave 2)

...

## Critical Path

<Longest dependency chain>

STORY-XXX → STORY-XXX → STORY-XXX

## Parallel Opportunities

<Stories that can run simultaneously within the same wave>
```

---

## plan-summary.md

```markdown
# Plan Summary

**Generated:** <timestamp>
**Status:** ready_for_review | has_open_questions | needs_human_review

## Overview

- **Stories:** <count>
- **Implementation Steps:** <total count across all stories>
- **Estimated Total:** <hours>
- **Review Iterations:** <count>

## Critical Path

<Story sequence on the longest dependency chain>

## Open Questions

<Questions needing human input>

## Unresolved Risks

<Risks that couldn't be mitigated>

## Recommended Next Steps

1. <action>
2. <action>

## Files Created

- stories/STORY-XXX.md (×N)
- reviews/review-vN.md (×N)
- dependency-graph.md
- plan-summary.md
- web/index.html

## Change Log

### After Review v1

- <file>: <what changed and why>

### After Review v2

- <file>: <what changed and why>
```

---

## web/index.html

The planning output MUST include an HTML page for easy stakeholder review.

### Requirements

| Requirement | Details |
|-------------|---------|
| Self-contained | Single HTML file with inline CSS and JS |
| No dependencies | Must work offline — no CDN links, no external resources |
| Browser compatible | Works in any modern browser |
| Responsive | Readable on desktop and tablet |

### Required Sections

1. **Header** — title, summary
2. **Overview** — Stats (stories, implementation steps, phases, duration), problem statement
3. **Stories** — Expandable cards with acceptance criteria and implementation steps
4. **Phases** — Implementation timeline with story groupings
5. **Dependencies** — Visual dependency graph (execution waves)
6. **Risks** — Risk table with mitigations
7. **Questions** — Open questions requiring decisions
8. **Review Feedback** (if applicable) — Critical issues, gaps, resolutions

### UI Features

- Sticky navigation for quick section access
- Expandable/collapsible story cards with nested implementation steps
- Visual status indicators (badges, colors)
- Clear typography and spacing
- `[UPDATED]` / `[NEW]` tags for items modified during review

---

## Writing Guidelines

Stories are **specifications for developers**, not implementation guides.

### Content MUST contain

- **What** needs to be accomplished (requirements)
- **Why** it matters (business context)
- **Which files** are affected (paths)
- **What patterns** to follow (reference existing code)
- **Exact names** from the tech spec — component names, method signatures, field definitions, property names. Never paraphrase.
- **Interface contracts** — what each implementation step creates (with exact names/signatures) and what it consumes from earlier steps or other stories
- **Test criteria** (how to verify success)
- **Dependencies** (what must come before/after — at story level)
- **Traceability** — which PoC spec ACs this satisfies, which tech spec section it implements

### Content must NEVER contain

- MCP tool names (e.g., `mcp__servicenow-mcp__create_table_acl`)
- Tool-specific syntax or code snippets for tools
- References to agent hosts, agents, or AI assistants
- Specific tool invocation patterns

The developer executing the story decides which tools to use.

### Example — WRONG (tool-specific)

```markdown
## Implementation
Use `mcp__servicenow-mcp__create_table_acl` with:
- table: "sn_wsd_visitor_visitor_registration"
- type: "field"
- field: "rsvp_status"
```

### Example — CORRECT (specification with interface contract)

```markdown
### Step 4: Create RSVP status field ACL

**Tech Spec Reference:** Security > ACLs > visitor_registration
**Estimated:** 1h

Create a field-level ACL on the `sn_wsd_visitor_visitor_registration` table to restrict write access to the `rsvp_status` field.

**Interface Contract:**

*Creates:*
| Type | Name | Detail |
|------|------|--------|
| ACL | `sn_wsd_visitor_visitor_registration.rsvp_status.write` | Field-level write ACL, condition: visitor can only update own record (match by email), requires role `sn_wsd_visitor.visitor` or admin |

*Consumes:*
| Component | What | From |
|-----------|------|------|
| `sn_wsd_visitor.visitor` | Role required by this ACL | Step 3 |
```
