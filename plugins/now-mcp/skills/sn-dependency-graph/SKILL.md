---
name: sn-dependency-graph
description: Read-only `sn_execute_background_script` templates that compute what runs on a table (business rules, client scripts, UI policies, extends chain) or who references a script include/other target — computed server-side in one call, with results cached locally and timestamped so repeat questions don't re-hit the instance. Use for impact-analysis questions like "what runs on this table", "who calls this script include", "what depends on X" before changing something.
allowed-tools: Read, Write, Bash, mcp__plugin_now-mcp_now-mcp__sn_execute_background_script
---

# ServiceNow Dependency/Reference Templates

Two read-only background-script templates for relationship questions the
dedicated Table/Stats tools can't answer in one call: what runs on a table,
and who references a given script include or other identifier. Each template
computes a compact, server-side-reduced summary (names/flags only — never
script bodies) in a single `sn_execute_background_script` call, the same
technique `sn_diagnose_mutation` and `sn_get_security_info` already use.

Results are cached locally with a timestamp so the same question, asked again
later in an exploration, is a file read instead of another live call.

## When to use

- "What runs on table X" / "what business rules/client scripts/UI policies
  touch this table" / impact analysis before changing a table.
- "Who calls script include X" / "what references X" / "is X still used
  anywhere".

## When NOT to use

- A specific record's live ACL verdict — `sn_diagnose_mutation` and
  `sn_get_security_info` already answer this, and more precisely (role
  groups, effective access, per-field capability). This skill deliberately
  does not duplicate ACL detail.
- Flow-level dataflow (pill-to-pill wiring) — not covered.
- Anything needing a specific record — write the script directly with
  `sn_execute_background_script` instead of force-fitting one of these
  templates.
- Justifying a destructive change (deleting a business rule, changing an ACL)
  off a cached answer alone — re-verify live first. A cache is for
  orientation, not for the last check before a mutation.

## Templates

| Question | File | Covers |
|---|---|---|
| What runs on this table? | `references/table-runs-on.js` | extends chain, active business rules, active client scripts, active UI policies |
| Who references this target? | `references/who-calls.js` | script includes, business rules, client scripts, scripted REST resources, UI actions, scheduled jobs |

Neither template is exhaustive — see each file's header comment for what it
doesn't cover (e.g. `table-runs-on.js` doesn't cover ACLs or flow triggers;
`who-calls.js` doesn't scan flow script steps, inbound email actions, or UI
macros).

## Cache

Path: `~/.claude/sn-graph-cache/<instance>/<query-type>/<target>.json`

- `<instance>` — exactly the `instance` string `sn_execute_background_script`'s
  response echoes back (`"default"` if the call didn't pass one).
- `<query-type>` — `table-runs-on` or `who-calls`.
- `<target>` — the requested name, with any character outside `[A-Za-z0-9_.-]`
  replaced with `_`.

File shape:
```json
{
  "instance": "default",
  "queryType": "table-runs-on",
  "target": "incident",
  "generatedAt": "2026-08-24 09:12:03 UTC",
  "result": { /* the template's applicationResult, verbatim */ }
}
```

`generatedAt` comes from **the instance's own clock**, stamped inside the
Rhino script — it reflects when the data was actually read, not the agent's
local time.

## How to run a template

1. Check for an existing cache file at the path above for the exact target
   being asked about.
   - If it exists: read it and answer from it, **stating its age plainly**
     ("as of `generatedAt`, ~N hours/days ago"). Never imply it's current.
     Only proceed to step 2 if there's no cache, the user explicitly wants
     current/fresh data, or the question implies something may have changed
     recently (e.g. right after a deploy).
2. Read the relevant template file from `references/`.
3. Substitute `{{TARGET}}` with the actual table name or search term.
4. Call `sn_execute_background_script` with the substituted script as
   `script` and `resultMode: 'json'`. No `allowWrites` needed — both
   templates are read-only.
5. Check the response:
   - `outputTruncated: true` → **do not cache.** Report the limitation (name
     what's missing) and suggest narrowing scope (e.g. a more specific
     `who-calls` target, or checking one relationship category at a time)
     rather than caching an incomplete result that would later be read back
     as whole.
   - `applicationResult.success === false` → the target wasn't found/readable;
     report the error, don't cache.
   - Otherwise: `mkdir -p` the cache directory, write the JSON shape above
     (`Write` tool) to the target path, and answer from `applicationResult`.

## Avoidance

- Do not treat a cache file as ground truth for a decision that changes
  something — the live instance is ground truth, the cache is an index for
  orientation, same discipline as any other point-in-time snapshot.
- Do not auto-expire or silently skip a stale-looking cache — always surface
  the timestamp and let the model/user judge, per its age, whether to refresh.
- Do not extend either template to return script/condition body text "just
  this once" — the entire point is the compact, server-side-reduced summary;
  if a caller needs the actual script body, read that one record directly
  with `sn_query_records`.
