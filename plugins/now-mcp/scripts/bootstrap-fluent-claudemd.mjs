#!/usr/bin/env node
/**
 * fluent — CLAUDE.md bootstrapper (idempotent, fast).
 *
 * Purpose: when Claude Code opens a Fluent project (marker: `now.config.json`
 * at project root), guarantee the project's CLAUDE.md contains the standing
 * "Fluent workflow" rules (now-sdk/now-mcp division of labour + "always run
 * `now-sdk explain` before writing Fluent code"). CLAUDE.md is injected into
 * every session's system prompt, so it is far more reliable than trying to
 * trigger a skill.
 *
 * The injected content is DECOUPLED from this script: it lives in an editable
 * markdown file (`scripts/claude-md-template.md` by default, or whatever
 * `$FLUENT_WORKFLOW_TEMPLATE` points at), so it can be maintained without
 * editing code. This script only handles placement and idempotency.
 *
 * Wired only by the Claude adapter in `hooks/claude.json`. That means it runs on
 * EVERY session start, so it MUST be fast and MUST be a no-op when the rule is
 * already current. It is idempotent by design: a versioned fenced anchor block
 * is replaced when the shipped workflow changes, then left untouched thereafter.
 *
 * Detection uses process.cwd() — SessionStart hooks run with cwd = the user's
 * working directory (the project they just opened), which is what we want.
 *
 * Output goes to stderr only; stdout is reserved for MCP protocol traffic
 * elsewhere in this plugin and this hook shares the same shell.
 */

import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Anchor markers make the injected block re-findable across future runs. If
// the user hand-edits the block between them, we detect its presence and skip
// — we never overwrite their edits.
const WORKFLOW_VERSION = 2;
const LEGACY_BEGIN = '<!-- BEGIN fluent-plugin: workflow -->';
const BEGIN = `<!-- BEGIN fluent-plugin: workflow v${WORKFLOW_VERSION} -->`;
const END = '<!-- END fluent-plugin: workflow -->';

// The injected content is NOT hardcoded here — it lives in an editable markdown
// file so anyone (plugin author or end user) can maintain it without touching
// this script. Resolution order:
//   1. $FLUENT_WORKFLOW_TEMPLATE — an absolute/relative path to your own file
//   2. scripts/claude-md-template.md — the default shipped alongside this script
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATE = join(HERE, 'claude-md-template.md');

function log(msg) {
  process.stderr.write(`[fluent bootstrap] ${msg}\n`);
}

/**
 * Load the workflow markdown to inject. Returns null (and logs) if the resolved
 * template is missing/empty — the caller then no-ops rather than injecting junk.
 */
function loadTemplate() {
  const path = process.env.FLUENT_WORKFLOW_TEMPLATE || DEFAULT_TEMPLATE;
  if (!existsSync(path)) {
    log(`WARN: workflow template not found at ${path}; nothing to inject.`);
    return null;
  }
  const body = readFileSync(path, 'utf8').trim();
  if (!body) {
    log(`WARN: workflow template ${path} is empty; nothing to inject.`);
    return null;
  }
  return body;
}

function main() {
  if ((process.env.FLUENT_BOOTSTRAP_CLAUDEMD || '').toLowerCase() === 'off') {
    return 0;
  }

  const cwd = process.cwd();
  const marker = join(cwd, 'now.config.json');
  if (!existsSync(marker)) {
    // Not a Fluent project — nothing to do. Silent no-op (this hook runs on
    // every SessionStart, so noise here would be noise everywhere).
    return 0;
  }

  const claudeMd = join(cwd, 'CLAUDE.md');
  const existing = existsSync(claudeMd) ? readFileSync(claudeMd, 'utf8') : null;

  if (existing !== null) {
    // Already on the current managed version — done.
    if (existing.includes(BEGIN)) return 0;
    // User authored their own Fluent workflow section — respect it. A legacy
    // managed marker is handled below and is safe to upgrade.
    if (!existing.includes(LEGACY_BEGIN) && /^##\s+Fluent workflow\b/mi.test(existing)) return 0;
  }

  // Read the editable template only now (we're in a Fluent project and have no
  // existing block) — keeps the every-session no-op path free of disk reads.
  const body = loadTemplate();
  if (body === null) return 0;
  const BLOCK = `${BEGIN}\n${body}\n${END}\n`;

  try {
    if (existing === null) {
      writeFileSync(claudeMd, BLOCK);
      log('created CLAUDE.md with Fluent workflow rules.');
    } else if (existing.includes(LEGACY_BEGIN)) {
      const start = existing.indexOf(LEGACY_BEGIN);
      const end = existing.indexOf(END, start);
      if (end === -1) {
        log('WARN: legacy managed workflow block has no end marker; leaving it untouched.');
        return 0;
      }
      const upgraded = existing.slice(0, start) + BLOCK + existing.slice(end + END.length).replace(/^\n/, '');
      writeFileSync(claudeMd, upgraded);
      log(`upgraded CLAUDE.md Fluent workflow rules to v${WORKFLOW_VERSION}.`);
    } else {
      const sep = existing.endsWith('\n') ? '\n' : '\n\n';
      appendFileSync(claudeMd, sep + BLOCK);
      log('appended Fluent workflow rules to CLAUDE.md.');
    }
  } catch (e) {
    // Never fail the session over a bootstrap write; log and move on.
    log(`WARN: could not write CLAUDE.md: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
  return 0;
}

process.exit(main());
