# foundry-suite

Portable ServiceNow tooling for Claude Code, Codex, Cursor, and other Agent
Plugins-compatible hosts. It complements the official Fluent SDK (`now-sdk`):
Fluent authors application metadata; `now-mcp` operates the running instance;
skills orchestrate both.

## Plugins

| Plugin | Purpose |
|---|---|
| [`now-mcp`](plugins/now-mcp/README.md) | MCP tools for runtime data, schema, scripts, attachments, security, and diagnostics. |
| [`aia-toolkit`](plugins/aia-toolkit/README.md) | Build, audit, evaluate, and trace ServiceNow AI Agents. |
| [`sn-poc`](plugins/sn-poc/README.md) | Take a PoC from discovery through specifications and implementation-ready stories. |

Install `now-mcp` for live-instance operations. Add either skills plugin when
you need that workflow. `now-sdk` remains a separate prerequisite for authoring
Fluent metadata.

## Install

### Claude Code

```text
/plugin marketplace add https://github.com/owenljy/foundry-suite
/plugin install now-mcp@foundry-suite
/plugin install aia-toolkit@foundry-suite
/plugin install sn-poc@foundry-suite
/reload-plugins
```

`now-mcp` exposes Claude's setup form for a ServiceNow URL, username, password,
and read-only mode. OAuth and multi-instance setups use the YAML file described
in its [configuration guide](plugins/now-mcp/README.md#configuration).

### Codex

```bash
codex plugin marketplace add owenljy/foundry-suite
codex plugin add now-mcp@foundry-suite
codex plugin add aia-toolkit@foundry-suite
codex plugin add sn-poc@foundry-suite
```

Before starting Codex, export `SERVICENOW_URL`, `SERVICENOW_USERNAME`, and
`SERVICENOW_PASSWORD`, or set `SERVICENOW_CONFIG_PATH` to a YAML config. Writes
remain disabled unless `SERVICENOW_READ_ONLY=false`.

### Cursor

For local development, clone this repo and link the plugins into Cursor:

```bash
mkdir -p ~/.cursor/plugins/local
ln -s "$PWD/plugins/now-mcp" ~/.cursor/plugins/local/now-mcp
ln -s "$PWD/plugins/aia-toolkit" ~/.cursor/plugins/local/aia-toolkit
ln -s "$PWD/plugins/sn-poc" ~/.cursor/plugins/local/sn-poc
```

Reload Cursor, open **Customize → Plugins**, and configure `now-mcp` there.
Teams can import this repository through **Dashboard → Plugins → Add
Marketplace → Import from Repo**; the repo includes
`.cursor-plugin/marketplace.json`.

## Portable layout

Each plugin contains:

- `plugin.json` and, for `now-mcp`, `mcp.json`: Agent Plugins 1.0 portable core.
- `.claude-plugin/plugin.json`: Claude adapter.
- `.codex-plugin/plugin.json`: Codex adapter.
- `.cursor-plugin/plugin.json`: Cursor adapter.

The repository also publishes host-native marketplace catalogs under
`.claude-plugin/`, `.agents/plugins/`, and `.cursor-plugin/`.

Claude-only setup variables and the `CLAUDE.md` bootstrap hook live only in the
Claude adapter. Portable and Codex installs inherit `SERVICENOW_*` environment
variables; Cursor uses plugin variables.

## Development

```bash
cd plugins/now-mcp
corepack enable
pnpm install
pnpm build
pnpm test
cd ../..
node scripts/validate-plugins.mjs
```

Node.js 22+ is required. See the individual plugin READMEs for workflow and
configuration details.
