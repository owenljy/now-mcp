---
name: sn-docs-search
description: Retrieve live ServiceNow product/admin and release documentation from ServiceNow/ServiceNowDocs. Use for documented platform behavior, administration/configuration, release-specific behavior, cross-release differences, or explicit requests to search official product docs. Do NOT use for Fluent SDK authoring or `*.now.ts` API questions (imports, types, constructors, signatures, fields, or code examples); in a Fluent app, run `now-sdk explain` for those instead. Also do not trigger when the answer is already in the conversation.
allowed-tools: Bash(gh:*) Bash(curl:*) Bash(jq:*) Bash(pandoc:*) Read Write
---

# ServiceNow Docs Search

Retrieve official ServiceNow product documentation from **`github.com/ServiceNow/ServiceNowDocs`** — a public, LLM-optimized markdown mirror of `docs.servicenow.com` that ServiceNow publishes for exactly this purpose. The repo is the source of truth for this skill. **Do not** drive the SPA at `docs.servicenow.com`; it returns empty shells to non-browser fetchers and has been formally deprecated as an LLM target by ServiceNow themselves (see `llms.txt` in the repo).


## When to use

- The user wants official ServiceNow product documentation — admin / configuration / module behavior / feature reference
- Release-specific behavior, *"what changed in Yokohama"*, *"is this still true in Australia"*, cross-release diffs
- A recently shipped or rarely-discussed feature whose details aren't in the conversation already
- The user explicitly says *"check the docs"*, *"search ServiceNow docs"*, or names a release

## When NOT to use

- The question is answerable from documentation already in the conversation, a prior tool result, or pasted material — search the conversation first
- The question concerns **Fluent SDK authoring** or a `*.now.ts` API: imports, exported names, types, constructors, object fields, signatures, or code examples. In a Fluent app, `now-sdk explain <topic> --format=raw` is the authoritative source and takes precedence over this skill. Use this docs skill only if the remaining question is about product/admin/release behavior outside the SDK API reference.
- The question is about non-ServiceNow content — use the user's normal research tools
- The target is `developer.servicenow.com` (dev portal / API explorer) or `nowlearning.servicenow.com` (training). Those are not in this repo. Tell the user the host is out of scope and let them decide

## Step 0 — Preflight (detect capabilities, then pick a mode)

```bash
command -v curl >/dev/null && echo "curl ok"                              # required
gh --version >/dev/null 2>&1 && gh auth status --hostname github.com >/dev/null 2>&1 && echo "gh+github.com ok"  # enables keyword search
```

`ServiceNow/ServiceNowDocs` is a **public** repo, so content is reachable two ways with very different requirements:

- **`curl` on `raw.githubusercontent.com`** — needs **no `gh`, no auth at all**. This is the baseline and covers fetching files and publication TOCs.
- **`gh search code` / `gh api`** — needs `gh` installed **and `github.com` auth**. This only adds *fuzzy keyword search across the corpus* (Mode B). Check `github.com` specifically: `gh auth status` alone can pass when only an unrelated host is logged in, but this repo lives on `github.com`.

Pick a mode from what's available — **do not stop just because `gh` is missing**:

| Available | Mode | What works | What's lost |
|---|---|---|---|
| `gh` + `github.com` auth | **Full** | everything | — |
| `curl` only (no `gh`, or `gh` not authed to `github.com`) | **curl-only** | static index → publication `index.md` → direct file fetch; cross-release diffs | fuzzy keyword search (Mode B). Recover most of it by fetching `llms.txt` or a publication `index.md` and grepping locally (see Step 2 note) |
| no `curl` and no `gh` | **stop** | — | tell the user to install `curl` (or `gh`) and stop |

When you run in curl-only mode, say so in one sentence at the start of your answer (e.g. *"Keyword search is unavailable here, so I routed via the static topic index"*). To unlock full mode, the user can `brew install gh` (or see https://cli.github.com) then `gh auth login` and pick `github.com`.

## Step 0b — Discover the current releases (do not hardcode)

Release branches roll: ServiceNow drops the oldest when a new release GAs, so any literal release name in this skill **will** eventually go stale. Resolve the set live instead of trusting a hardcoded list:

```bash
# Full mode: the latest release IS the repo's default branch; list all branches for the rest
gh api repos/ServiceNow/ServiceNowDocs --jq '.default_branch'           # = latest release (australia at time of writing)
gh api repos/ServiceNow/ServiceNowDocs/branches --jq '.[].name'         # all branches; keep only release codenames

# curl-only: HEAD on raw.githubusercontent.com resolves to the default branch (no API quota, no auth)
curl -sIL "https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/HEAD/llms.txt" >/dev/null && echo "HEAD ok"
```

The branch list mixes **release codenames** (city names: `australia`, `zurich`, `yokohama`, `xanadu`, …) with **non-release branches** (`main`, `mobile`, `nofamily`, `other`, `store`) — keep only the codenames. "Latest" is the **default branch**, *not* the alphabetically-last name: the release alphabet wraps (…Yokohama → Zurich → **Australia**), so sorting lies. When unsure, treat the default branch as latest and proceed. Use `HEAD` as the branch token in raw URLs when you just mean "latest" and don't want to hardcode a name.

## Step 1 — Infer scope

Infer the three dimensions below from the request before searching. State the assumed scope in one sentence at the top of the result; if the request is too ambiguous to search safely, ask one focused question.

1. **Goal** — *definition / reference*, *compare across releases*, *find a workaround*, or *survey what's available*. Infer from the wording; default to *reference*.
2. **Release(s)** — defaults to the **latest** (the default branch from Step 0b — `australia` at time of writing); honor any release the user names, or a *"compare X vs Y"*. Prefer `HEAD` over a literal name when you just mean "latest."
3. **Output** — default to an in-session reply (your returned result). Save to `.md`/`.docx` only when the invocation explicitly asks for a file and names a path.

Because the caller invokes you to solve a specific task, extract with **that task in mind** — favor the paragraphs that bear on it over a generic definition dump.

## Step 2 — Find candidate files (three modes, pick the cheapest that fits)

### Mode A — Static topic index (instant, no API call)

For **well-known platform topics** (admin, scripting, common modules), `references/publications.md` maps the topic to the right publication slug with zero round-trips — check it first for those. For a **recent or niche feature** (a just-shipped capability, an unfamiliar product name), the static map often won't list it; don't force a slug — go straight to Mode B keyword search. The index is a router, not an exhaustive catalog.

**Cache across invocations.** This skill runs forked and stateless, so each invocation otherwise re-fetches the same slow-changing files. Cache the branch list, a publication `index.md`, or `llms.txt` under the session scratchpad and reuse if recent (<24h):

```bash
CACHE="$SCRATCHPAD/sn-docs"; mkdir -p "$CACHE"            # $SCRATCHPAD = the session scratchpad dir
toc="$CACHE/<slug>-index.md"
if [ ! -f "$toc" ] || [ $(( $(date +%s) - $(stat -f %m "$toc") )) -gt 86400 ]; then
  curl -sL "https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/HEAD/markdown/<SLUG>/index.md" -o "$toc"
fi

### Mode B — GitHub code search (fuzzy keyword, one round-trip across 46k files)

> Requires **full mode** (`gh` + `github.com` auth). In curl-only mode, skip to the **curl-only keyword fallback** below.

```bash
gh search code <KEYWORDS> --repo=ServiceNow/ServiceNowDocs --limit=10 \
  --json path,repository
```

Use when:
- The user's terms don't map cleanly to a single publication
- You need to find every page mentioning a specific concept (e.g. "Build Agent", "Action Fabric")
- The static index returned multiple candidates and you need to disambiguate

**Never let literal double-quote characters reach the query** for `gh search code` — a query string that actually contains `"` returns **zero** results. The trap is *single-quoting* a phrase so the quotes survive: `gh search code '"Action Fabric"'` → `[]`. (Plain shell double-quotes are stripped by the shell, so `gh search code "Action Fabric"` passes `Action Fabric` and *does* work — but don't rely on that distinction; just pass space-separated terms, which already act as AND.) **If any search returns 0 hits, retry once unquoted / with fewer terms before concluding the topic is absent.** For a **true exact-phrase** match, use the REST form instead, which honors the quotes (and returns `.total_count`):

```bash
gh api -X GET search/code -f q='"<phrase>" repo:ServiceNow/ServiceNowDocs' --jq '.items[].path'
```

**Important**: `gh search code` searches the **default branch only** (the latest release; see Step 0b). For other releases, fetch the same path with a different `?ref=` (see Step 3).

**curl-only keyword fallback** (no `gh`): there's no unauthenticated code-search API, so recover keyword discovery with `curl` + local `grep`. Narrow to a likely publication via the static index first, then grep its TOC — fetching all of `llms.txt` is the broad fallback:

```bash
# Grep one publication's TOC for a concept (fast, targeted)
curl -sL "https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/australia/markdown/<SLUG>/index.md" \
  | grep -i 'build agent'
# Broad: grep the whole upstream entry-point list
curl -sL "https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/australia/llms.txt" | grep -i 'build agent'
```

### Mode C — Per-publication `index.md` (drill-down)

When the publication is clear but the file isn't:

```bash
gh api 'repos/ServiceNow/ServiceNowDocs/contents/markdown/<SLUG>/index.md?ref=<BRANCH>' \
  --jq '.content' | base64 -d
```

The `index.md` is a tree of `[Title](raw URL) -- one-line description` entries — perfect for narrowing without reading file bodies.

## Step 3 — Fetch the content

Files are typically nested as `markdown/<publication>/<sub-publication>/<file>.md` — one level deeper than a flat layout. Resolve the real path from the publication `index.md` or from a search/REST result rather than hand-constructing a flat `markdown/<slug>/<file>.md` path, which often 404s.

**Prefer raw URLs in parallel** when fetching multiple files (faster than `gh api`, no rate-limit nag for public content):

```bash
curl -sL "https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/<BRANCH>/markdown/<PATH>"
```

**Use `gh api` when**:
- You want the file metadata too (size, sha)
- You'll fetch many files and want JSON output for batch processing
- Raw URL fails for any reason (rare, only on missing files)

```bash
gh api 'repos/ServiceNow/ServiceNowDocs/contents/markdown/<PATH>?ref=<BRANCH>' \
  --jq '.content' | base64 -d
```

**Triage before bulk-fetching bodies.** When you have many candidate files, fetch **frontmatter only** first (Snippet G) and rank by `title` / `description` / `last_updated`, then pull full bodies for just the top few. Curling every candidate in full is slower and dilutes the eventual synthesis.

**Parallelize** for cross-release diffs and multi-file surveys (run `curl` calls in `&` and `wait`).

## Step 4 — Extract & cite

The content is plain markdown — no shadow DOM, no chrome, no extraction tricks needed. Just read the frontmatter and the body.

**Citation discipline** (every factual claim carries an in-text citation):

```markdown
ACLs evaluate in order: security admin → admin → role-based → table-level
([Australia / Platform Security][1]).

[1]: https://www.servicenow.com/docs/r/platform-security/acl-rules.html
```

The footnote URL should be the **human-readable canonical URL**, not the raw GitHub URL. Build it as:

- If frontmatter has `canonical_url`: use it directly — it's reliably present now, in the form `https://www.servicenow.com/docs/r/<publication>/<file>.html`
- Otherwise: `https://github.com/ServiceNow/ServiceNowDocs/blob/<branch>/markdown/<path>` (works as a verifiable archive link)

The footnote **label** must name the release explicitly, e.g. `[Australia / Build Agent][1]` — so the reader can tell which release the claim came from at a glance.

When two releases disagree, cite both inline: *"Yokohama said X [1]; Australia says Y [2]."*

## Step 5 — Deliver

Match the output format from Step 1. For `.md`, include a YAML frontmatter block with `query`, `releases_covered`, `retrieved_at` (ISO timestamp). For `.docx`, render the markdown via `pandoc -f markdown -t docx -o <out.docx> <tmp.md>`. If `pandoc` is unavailable, write `.md` and tell the user. Do not handcraft `.docx`.

**Forked return contract.** This skill runs forked, so the message you return *is* the entire deliverable — the caller sees nothing else. Always structure the in-session return as:

1. A one-line **assumed scope** up front (goal / release(s) / output) — since you couldn't ask, this is how the caller catches a wrong assumption and re-invokes.
2. The synthesized answer, every factual claim carrying an inline citation (Step 4).
3. A short **coverage footer**: which release branch(es) you actually fetched from, and any gap or re-invoke hook (e.g. *"fetched australia only; re-invoke for a Zurich diff"* or *"docs don't use the literal term X"*).

## Snippets

```bash
# A. Code search (fuzzy keyword, indexes the DEFAULT branch only — see Step 0b)
# No literal quote chars in the query — spaces act as AND. If 0 hits, retry unquoted / fewer terms.
gh search code <KEYWORDS> --repo=ServiceNow/ServiceNowDocs --limit=10 \
  --json path,repository

# A2. Exact-phrase search via REST (honors the quotes; gives .total_count)
gh api -X GET search/code -f q='"<phrase>" repo:ServiceNow/ServiceNowDocs' --jq '.items[].path'

# B. Fetch a single file from a specific release (raw URL, no auth needed)
curl -sL "https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/<BRANCH>/markdown/<PATH>"

# C. Fetch via gh (gets metadata + content; needs base64 decode)
gh api 'repos/ServiceNow/ServiceNowDocs/contents/markdown/<PATH>?ref=<BRANCH>' \
  --jq '.content' | base64 -d

# D. Pull a publication's TOC
curl -sL "https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/<BRANCH>/markdown/<SLUG>/index.md"

# E. Parallel multi-file fetch (much faster than serial)
for path in <PATH1> <PATH2> <PATH3>; do
  curl -sL "https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/australia/markdown/$path" &
done; wait

# F. Cross-release diff on the same file path
diff <(curl -sL "https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/yokohama/markdown/<PATH>") \
     <(curl -sL "https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/australia/markdown/<PATH>")

# G. Extract just the frontmatter from a fetched file
curl -sL "<RAW_URL>" | awk '/^---$/{c++; next} c==1' | head -20

# H. Live llms.txt index (the upstream entry-point list)
curl -sL "https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/australia/llms.txt"
```

Anything beyond these — auth flows, write access, batched mutations — is out of scope. For `gh` syntax not covered here, run `gh <subcommand> --help`.

## Avoidance

- Do not fetch `docs.servicenow.com` or drive it with a browser. The page returns empty shells to LLMs and ServiceNow has formally deprecated that path (per their own `llms.txt`). The GitHub repo is the authoritative LLM source.
- Do not skip Step 0. But missing `gh` is **not** a stop condition — fall back to curl-only mode and tell the user keyword search is unavailable. Stop only if `curl` is also missing.
- Do not attempt an interactive interview or `AskUserQuestion` — this skill runs forked and cannot prompt the user. Infer the Step 1 scope, state your assumptions at the top of your result, and proceed.
- Do not paste raw file contents into the final answer. Extract the relevant paragraphs.
- Do not cite the `raw.githubusercontent.com` URL as the source — that's the fetch URL, not the canonical doc URL. Cite the `canonical_url` from frontmatter when present; otherwise the `github.com/.../blob/...` form.
- Do not omit the release from the footnote label. The reader must be able to tell whether the claim is about Australia, Zurich, Yokohama, or Xanadu without clicking the link.
- Do not produce uncited factual claims. Every paragraph that asserts a fact needs a footnote ID.
- Do not assume the corpus has every release. ServiceNow keeps only the rolling 3–4 most recent branches. If the user names a release that's been dropped (e.g. Washington DC), tell them and offer the closest available branch.
- Do not hardcode the release list or assume `australia` is still latest. Discover it (Step 0b: default branch = latest); the codenames in this skill are examples that drift each GA. Prefer the `HEAD` raw-URL token when you just mean "latest."
- Do not search for content on `australia` and then claim it's true for `yokohama` without re-fetching from the `yokohama` branch. Releases drift.
- Do not assume `gh search code` covers every branch — it only indexes the default branch (the latest release; see Step 0b). For cross-release search, fetch the file from each branch and grep locally.
- Do not fall through to `WebFetch` on `docs.servicenow.com` — it cannot render the page and the GitHub mirror exists precisely to remove that need.
- Do not burn the GitHub API quota — it's ~5000/hr for core and only ~30/min for code search, and it's **shared** across all `gh` tools and subagents in this environment. Prefer `curl` raw URLs for fetching (separate, effectively unlimited, no auth), and treat `gh search code` and any recursive `git/trees` call (very expensive on the ~46k-file tree) as quota-precious.

## Escape hatch

- If `gh search code` + the static index + the publication TOC all fail to surface the topic, the page may not exist in this release (newly removed, newly renamed, or never was). Tell the user, name the branches you searched, and offer to widen to other branches or to `community.servicenow.com` (which is **not** in this repo and requires a different path).
- For deep `gh` flags or rate-limit issues, run `gh <subcommand> --help` or `gh api --help`. Do not duplicate that material here.
- If the user asks for community/forum content, that's out of scope for this repo. Tell them so and stop — don't half-attempt it via raw web fetch.
