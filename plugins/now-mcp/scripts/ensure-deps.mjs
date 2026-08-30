#!/usr/bin/env node
/**
 * now-mcp — dependency bootstrap (idempotent, shared).
 *
 * Ensures the plugin's runtime dependencies are installed and resolvable,
 * WITHOUT requiring `build/` or `node_modules/` to be committed. Safe to run
 * repeatedly: when everything is already in place it is a fast no-op.
 *
 * Called from two places:
 *   - a host adapter hook (when supported) — runs before the MCP server starts
 *     first-run installation doesn't block/timeout the MCP handshake.
 *   - scripts/launch.mjs — calls this as a fallback right before starting the
 *     server, in case the hook didn't run or finished after the server started.
 *
 * Strategy (Agent Plugins ${PLUGIN_ROOT}/${PLUGIN_DATA}):
 *   - Install into ${PLUGIN_DATA} (PERSISTENT across plugin updates).
 *     ${PLUGIN_ROOT} is ephemeral (new dir per version/commit), so
 *     installing there re-installs on every update.
 *   - Symlink ROOT/node_modules -> DATA/node_modules. Node's ESM resolver walks
 *     the directory tree and ignores NODE_PATH, so a symlink (not NODE_PATH,
 *     which is CommonJS-only) is how ESM finds the deps.
 *   - Skip install unless package.json / pnpm-lock.yaml differ from the copies
 *     cached in DATA, so update-with-no-dep-change is instant.
 *   - When PLUGIN_DATA is unset (dev checkout), install in place in ROOT.
 *
 * Output goes to stderr. As a plain command hook its stdout is harmless, but the
 * launcher imports run() where stdout MUST stay clean for the MCP stream, so we
 * never write to stdout here.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  lstatSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFESTS = ['package.json', 'pnpm-lock.yaml'];

function log(msg) {
  console.error(`[now-mcp deps] ${msg}`);
}

/** Run a command with stdout+stderr both routed to stderr (never stdout). */
function runToStderr(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    stdio: ['ignore', process.stderr, process.stderr],
    env: process.env,
    shell: process.platform === 'win32', // resolve corepack/pnpm .cmd on Windows
  });
}

/** True if `command` exists and runs (probe for corepack / pnpm). */
function canRun(command, args) {
  const r = spawnSync(command, args, {
    stdio: 'ignore',
    env: process.env,
    shell: process.platform === 'win32',
  });
  return r.status === 0;
}

/** Choose the package-manager invocation: corepack pnpm, then global pnpm. */
export function pnpmInvocation() {
  if (canRun('corepack', ['--version'])) return { cmd: 'corepack', pre: ['pnpm'] };
  if (canRun('pnpm', ['--version'])) return { cmd: 'pnpm', pre: [] };
  return null;
}

/** Install deps in `installDir` (which must contain package.json + lockfile). */
function install(installDir) {
  const pm = pnpmInvocation();
  if (!pm) {
    throw new Error(
      'could not find pnpm. This project uses pnpm (pnpm-lock.yaml). ' +
        'Run `corepack enable` (ships with Node 22+), then reconnect the MCP server, ' +
        'or install pnpm globally: `npm i -g pnpm`.',
    );
  }
  // --ignore-scripts: skip lifecycle scripts (this project's `prepare: tsc`
  // would run in the data dir, which has no tsconfig/src, and fail). We run
  // from source via tsx, so no build step is needed here anyway.
  const r = runToStderr(
    pm.cmd,
    [...pm.pre, 'install', '--frozen-lockfile', '--prod=false', '--ignore-scripts'],
    installDir,
  );
  return r.status === 0;
}

/** True when DATA's cached manifest copies match ROOT's (deps unchanged). */
function manifestsMatch(root, dataDir) {
  return MANIFESTS.every((f) => {
    const b = join(dataDir, f);
    if (!existsSync(b)) return false;
    try {
      return readFileSync(join(root, f), 'utf8') === readFileSync(b, 'utf8');
    } catch {
      return false;
    }
  });
}

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Ensure `linkPath` is a symlink pointing at `target`; recreate if not. */
function ensureSymlink(linkPath, target) {
  if (isSymlink(linkPath)) {
    let current;
    try {
      current = readlinkSync(linkPath);
    } catch {
      current = null;
    }
    if (current === target) return; // already correct
    rmSync(linkPath, { recursive: true, force: true });
  } else if (existsSync(linkPath)) {
    rmSync(linkPath, { recursive: true, force: true });
  }
  symlinkSync(target, linkPath, 'dir');
}

/**
 * Ensure dependencies are installed and resolvable. Idempotent.
 * @returns {boolean} true if everything is ready, false on failure.
 */
export function ensureDeps() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const root = process.env.PLUGIN_ROOT || join(scriptDir, '..');
  const dataDir = process.env.PLUGIN_DATA || null;

  if (dataDir) {
    // Persistent-deps mode (real plugin runtime).
    mkdirSync(dataDir, { recursive: true });

    if (!existsSync(join(dataDir, 'node_modules')) || !manifestsMatch(root, dataDir)) {
      log('installing dependencies into plugin data dir (first run or deps changed)…');
      for (const f of MANIFESTS) copyFileSync(join(root, f), join(dataDir, f));
      if (!install(dataDir)) {
        // Drop the copied manifests so the next run retries a clean install.
        for (const f of MANIFESTS) {
          try {
            rmSync(join(dataDir, f), { force: true });
          } catch {
            /* ignore */
          }
        }
        log('ERROR: dependency installation failed. See the pnpm output above.');
        return false;
      }
      log('dependencies installed.');
    }

    // ESM resolves deps by walking up from cwd; point ROOT/node_modules at DATA.
    try {
      ensureSymlink(join(root, 'node_modules'), join(dataDir, 'node_modules'));
    } catch (e) {
      log(`ERROR: could not link node_modules into the plugin dir: ${e.message}`);
      return false;
    }
  } else {
    // Dev fallback: install in-place under ROOT.
    if (!existsSync(join(root, 'node_modules'))) {
      log('node_modules missing — installing in place (dev mode)…');
      if (!install(root)) {
        log('ERROR: dependency installation failed. See the pnpm output above.');
        return false;
      }
      log('dependencies installed.');
    }
  }

  return true;
}

// Run directly (e.g. from the SessionStart hook): exit non-zero on failure.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(ensureDeps() ? 0 : 1);
}
