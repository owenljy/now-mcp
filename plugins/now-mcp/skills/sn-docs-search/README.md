# sn-docs-search

Retrieve official **ServiceNow product documentation** from the public GitHub mirror
[`ServiceNow/ServiceNowDocs`](https://github.com/ServiceNow/ServiceNowDocs) — an
LLM-optimized markdown copy of `docs.servicenow.com` that ServiceNow publishes for
exactly this purpose. Returns citation-grade answers (canonical URLs + the release the
claim came from), across the rolling window of supported releases.

## Requirements

| Tool | Needed for | Required? |
|------|-----------|-----------|
| `curl` | Fetching doc bodies, TOCs, and the static index from `raw.githubusercontent.com` (no auth) | **Yes** — the baseline; the skill stops without it |
| `gh` (GitHub CLI) **authed to `github.com`** | Fuzzy keyword search across the ~46k-file corpus (`gh search code`) | Optional — unlocks "full mode" |
| `pandoc` | Saving results as `.docx` | Optional — falls back to `.md` |

### Optional: unlock full keyword search

The skill works out of the box on `curl` alone (it routes via the static topic index and
publication TOCs). To additionally enable **fuzzy keyword search** across the whole corpus,
install and authenticate the GitHub CLI:

```bash
brew install gh            # or see https://cli.github.com
gh auth login              # choose GitHub.com when prompted
```

Without this, the skill runs in **curl-only mode** and says so in one line at the start of
its answer; you lose only cross-corpus keyword discovery, not the ability to fetch and cite
docs. (The repo is public, so no auth is needed for content fetches — only for search.)

## How to use

- Type `/sn-docs-search` and describe what you need, **including the task you're solving**
  (not just the topic) — e.g. *"what does ServiceNow natively offer for MCP, so I can decide
  how it fits external MCP tooling?"*. The skill extracts with your task in mind.
- Or ask a ServiceNow-docs question in chat and the agent may invoke it automatically.

### What you get back

This skill runs in an **isolated forked context**, so all the doc-fetching noise stays out
of your main conversation — you receive a single synthesized message containing:

1. The assumed scope (goal / release / output) up front, so you can correct it and re-invoke.
2. The answer, every factual claim carrying an inline citation to its canonical doc URL.
3. A coverage footer: which release branch(es) were fetched, and any gaps or re-invoke hooks.

Because it's forked, it can't prompt you mid-run — it infers scope and reports its
assumptions instead. If it under-extracts, re-invoke with a narrower ask.

## Releases

Defaults to the **latest** release (the repo's default branch). Name any supported release
(`australia`, `zurich`, `yokohama`, `xanadu`, … — these roll over time) or ask for a
cross-release comparison. The skill discovers the current branch set live rather than
trusting a hardcoded list.

## Scope / limitations

- Source of truth is **`github.com/ServiceNow/ServiceNowDocs` only**. It does **not** cover
  `developer.servicenow.com` (dev portal / API explorer), `nowlearning.servicenow.com`
  (training), or `community.servicenow.com` (forums).
- ServiceNow keeps only the rolling ~3–4 most recent release branches; older releases
  (e.g. Washington DC) are not retrievable.
- Heavy GitHub-API operations (full-tree diffs, code search) draw on a shared, rate-limited
  quota; content fetches over `curl` raw URLs do not.
