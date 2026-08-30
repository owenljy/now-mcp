#!/usr/bin/env node
/**
 * now-mcp plugin launcher — MCP entry point.
 *
 * Agent hosts run this as the plugin's MCP server `command`. Dependency setup
 * (install into ${PLUGIN_DATA}, symlink node_modules) lives in the shared,
 * idempotent scripts/ensure-deps.mjs, which the SessionStart hook runs first so
 * a first-run install doesn't block the MCP handshake. We call ensureDeps() here
 * too as a fallback — if the hook didn't run or finished late, the server still
 * comes up self-healed rather than crashing on missing deps.
 *
 * Then start the server from TypeScript source (src/index.ts) via tsx — no
 * compiled build/ required.
 *
 * HARD RULE: never write to stdout. Every diagnostic uses console.error
 * (stderr); a stray stdout byte corrupts the MCP JSON-RPC stream. (ensureDeps
 * also writes only to stderr.)
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDeps, pnpmInvocation } from './ensure-deps.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = process.env.PLUGIN_ROOT || join(scriptDir, '..');

function fail(msg) {
  console.error(`[now-mcp launcher] ERROR: ${msg}`);
  process.exit(1);
}

// Fallback dependency check (the SessionStart hook normally does this first).
if (!ensureDeps()) {
  fail('dependencies are not ready. See the messages above.');
}

// Start the server from TypeScript source via tsx. stdio is inherited so
// src/index.ts owns the MCP stdio transport directly.
console.error('[now-mcp launcher] starting server (tsx src/index.ts)…');
const pm = pnpmInvocation();
if (!pm) {
  fail('pnpm unavailable at startup. Run `corepack enable` or install pnpm globally.');
}
const server = spawnSync(pm.cmd, [...pm.pre, 'exec', 'tsx', 'src/index.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
});

if (server.error) {
  fail(`failed to start server: ${server.error.message}`);
}
process.exit(server.status ?? 0);
