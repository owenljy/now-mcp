# MCP Capability Resolution

On-demand reference for every skill in this toolkit. Skills should not hardcode
one MCP server's tool names — a user may have a *different* ServiceNow MCP
server connected that exposes equivalent capabilities under different tool and
parameter names. This doc defines the two capabilities the toolkit needs and
the protocol for resolving each against whatever is actually connected.

> **Why this exists:** the alternative — hardcoding `sn_query_records`
> and `sn_execute_background_script` — only works for one specific MCP
> server. Requiring a per-vendor mapping table doesn't scale to "whatever
> happens to be connected." A runtime resolution protocol does.

## Capability catalog

### `read_records`

- **Purpose:** read/filter/list records from a ServiceNow table.
- **Reference param shape** (illustrative — from the `servicenow` MCP's
  `sn_query_records`, not a mandate): table name (string), an encoded
  query string, a `fields` array, a `limit`, and an optional display-value flag
  for reference-field labels.
- **Reference output shape** (now-mcp): rows come back as `{columns:[...],
  rows:[[...]]}` — pair `rows[i]` positionally against `columns`, not as
  `{records:[{...}]}`.
- **Used by:** `sn-aia-agent-audit`, `sn-aia-agent-builder`,
  `sn-aia-trace-analyzer`, `sn-eval-runner-builder`.

### `run_privileged_script`

- **Purpose:** execute an ad-hoc server-side script for operations a table read
  can't do (e.g. running a testable tool-script version, launching and polling
  a test agent conversation).
- **Reference param shape:** a script body (string) to execute server-side,
  returning its result.
- **Used by:** `sn-aia-agent-builder` (Step 5 test-script runner, Step 9
  smoke-test launch-and-poll).

`sn-aia-dataset-builder` needs neither capability — its writes go through
Fluent/`now-sdk`, not MCP.

## Resolution protocol

Follow this once per skill invocation, the first time the skill needs a
capability:

1. **Discover.** List the MCP tools connected this session — names,
   descriptions, input schemas.
2. **Match.** Pattern-match tool name/description against the capability's
   keywords:
   - `read_records`: query / read / get / list / search + records / rows /
     table / data. Exclude tools whose name/description indicates a mutation
     (create/update/delete/insert) or arbitrary execution.
   - `run_privileged_script`: execute / run + script / background / code.
   A tool matching both keyword sets (e.g. a generic "run query" tool) is
   `read_records` unless the task genuinely needs arbitrary script execution
   — prefer the narrower capability.
3. **Disambiguate once, if needed.** Exactly one match → use it. Several
   plausible matches → prefer the closest name match to the known convention
   (`query_records`, `get_records`, `search_records`, etc.); if still
   ambiguous, ask the user once which tool to use for this session.
4. **Adapt params.** Once a tool is chosen, read its actual input schema and
   map the capability's generic fields onto that tool's real param names (e.g.
   `tableName` vs `table`, `query` vs `filter`). This isn't new machinery —
   it's the same schema-driven param mapping Claude does for any tool call;
   the protocol only decides *which* tool to call.
5. **Cache for the run.** Reuse the same tool + mapping for the rest of that
   skill invocation. Don't re-run discovery per call.
6. **No match found → warn, then fall back.** Nothing matched. Do not switch
   to the fallback silently — tell the user first, e.g. *"No ServiceNow MCP
   tool matched `read_records` this session, so I'll give you a background
   script to run manually in Scripts > Background instead."* Then:
   - `read_records`: hand off to the skill's own `references/*.md`
     background-script fallback — paste-and-run in Scripts > Background, same
     UX as today's "MCP not authenticated" path.
   - `run_privileged_script`: give the user the exact script text, ask them to
     paste it into Scripts > Background (Global scope), and wait for the
     pasted output before continuing.

## Error handling

- Zero matching tool: not an error — it's the documented fallback path
  (background script), same UX as "not authenticated" today.
- Ambiguous match with no clear winner: ask the user once; don't guess
  silently.
- A resolved tool that can't express one param (e.g. no display-value
  equivalent): proceed without it and note the limitation in the output,
  rather than blocking the whole capability.
