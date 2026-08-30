#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginNames = ['now-mcp', 'aia-toolkit', 'sn-poc'];
const portableManifestFields = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
]);
const skillFields = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
]);

function fail(message) {
  throw new Error(message);
}

function check(condition, message) {
  if (!condition) fail(message);
}

function json(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${path}: invalid JSON (${error.message})`);
  }
}

function validateRelativeComponent(pluginRoot, value, label) {
  check(typeof value === 'string' && value.startsWith('./'), `${label}: path must start with ./`);
  check(!value.split('/').includes('..'), `${label}: path must stay inside the plugin`);
  check(existsSync(join(pluginRoot, value)), `${label}: missing ${value}`);
}

function parseFrontmatter(path) {
  const source = readFileSync(path, 'utf8');
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  check(match, `${path}: missing YAML frontmatter`);

  const values = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    if (/^\s/.test(line) || line.trim() === '') continue;
    const separator = line.indexOf(':');
    check(separator > 0, `${path}: invalid frontmatter line: ${line}`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    check(skillFields.has(key), `${path}: non-portable frontmatter field "${key}"`);
    values.set(key, value);
  }
  return values;
}

function validateSkills(pluginRoot) {
  const skillsRoot = join(pluginRoot, 'skills');
  check(existsSync(skillsRoot), `${pluginRoot}: missing skills/`);
  const skillDirs = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, 'SKILL.md')));
  check(skillDirs.length > 0, `${pluginRoot}: no skills found`);

  for (const entry of skillDirs) {
    const path = join(skillsRoot, entry.name, 'SKILL.md');
    const fields = parseFrontmatter(path);
    const name = fields.get('name');
    const description = fields.get('description');
    check(name === entry.name, `${path}: name must match parent directory`);
    check(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name), `${path}: invalid skill name`);
    check(description && description.length <= 1024, `${path}: description must be 1-1024 chars`);
    const allowedTools = fields.get('allowed-tools');
    check(!allowedTools || !allowedTools.includes(','), `${path}: allowed-tools must be space-separated`);
  }
}

function validatePortable(pluginRoot, expectedName) {
  const manifest = json(join(pluginRoot, 'plugin.json'));
  check(
    manifest.$schema === 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    `${expectedName}: wrong Agent Plugins schema`,
  );
  check(manifest.name === expectedName, `${expectedName}: portable manifest name mismatch`);
  for (const key of Object.keys(manifest)) {
    check(portableManifestFields.has(key), `${expectedName}: unknown portable field "${key}"`);
  }

  if (expectedName === 'now-mcp') {
    const mcp = json(join(pluginRoot, 'mcp.json'));
    check(
      mcp.$schema === 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      'now-mcp: wrong portable MCP schema',
    );
    check(Object.keys(mcp).every((key) => key === '$schema' || key === 'mcpServers'), 'now-mcp: invalid portable MCP top-level field');
    const server = mcp.mcpServers?.['now-mcp'];
    check(server?.type === 'stdio', 'now-mcp: portable MCP must declare stdio');
    check(server.command === 'node', 'now-mcp: portable MCP command must be node');
    check(server.args?.includes('${PLUGIN_ROOT}/scripts/launch.mjs'), 'now-mcp: portable launcher must use PLUGIN_ROOT');
  }
}

function validateNative(pluginRoot, expectedName, host) {
  const manifestPath = join(pluginRoot, `.${host}-plugin`, 'plugin.json');
  const manifest = json(manifestPath);
  const portableManifest = json(join(pluginRoot, 'plugin.json'));
  check(manifest.name === expectedName, `${manifestPath}: name mismatch`);
  check(manifest.version === portableManifest.version, `${manifestPath}: version must match plugin.json`);
  check(/^\d+\.\d+\.\d+$/.test(manifest.version), `${manifestPath}: version must be strict semver`);
  check(typeof manifest.description === 'string' && manifest.description.length > 0, `${manifestPath}: description required`);

  for (const field of ['skills', 'mcpServers', 'hooks']) {
    if (manifest[field] !== undefined) validateRelativeComponent(pluginRoot, manifest[field], `${manifestPath}:${field}`);
  }

  if (host === 'codex') {
    for (const field of ['displayName', 'shortDescription', 'longDescription', 'developerName', 'category', 'capabilities', 'defaultPrompt']) {
      check(manifest.interface?.[field] !== undefined, `${manifestPath}: interface.${field} required`);
    }
  }

  if (host === 'cursor' && manifest.mcpServers) {
    const mcpSource = readFileSync(join(pluginRoot, manifest.mcpServers), 'utf8');
    const declared = new Set(Object.keys(manifest.variables?.properties ?? {}));
    const placeholders = [...mcpSource.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map((match) => match[1]);
    for (const placeholder of placeholders) {
      if (placeholder === 'PLUGIN_ROOT' || placeholder === 'PLUGIN_DATA') continue;
      check(declared.has(placeholder), `${manifestPath}: undeclared Cursor variable ${placeholder}`);
    }
  }
}

for (const name of pluginNames) {
  const pluginRoot = join(repoRoot, 'plugins', name);
  validatePortable(pluginRoot, name);
  validateSkills(pluginRoot);
  validateNative(pluginRoot, name, 'claude');
  validateNative(pluginRoot, name, 'codex');
  validateNative(pluginRoot, name, 'cursor');
}

const cursorMarketplace = json(join(repoRoot, '.cursor-plugin', 'marketplace.json'));
check(cursorMarketplace.name === 'foundry-suite', 'Cursor marketplace name mismatch');
for (const entry of cursorMarketplace.plugins ?? []) {
  check(pluginNames.includes(entry.name), `Cursor marketplace: unknown plugin ${entry.name}`);
  check(existsSync(join(repoRoot, entry.source)), `Cursor marketplace: missing source ${entry.source}`);
}
check(cursorMarketplace.plugins?.length === pluginNames.length, 'Cursor marketplace must list every plugin');

const claudeMarketplace = json(join(repoRoot, '.claude-plugin', 'marketplace.json'));
check(claudeMarketplace.name === 'foundry-suite', 'Claude marketplace name mismatch');
check(claudeMarketplace.plugins?.length === pluginNames.length, 'Claude marketplace must list every plugin');

const codexMarketplace = json(join(repoRoot, '.agents', 'plugins', 'marketplace.json'));
check(codexMarketplace.name === 'foundry-suite', 'Codex marketplace name mismatch');
check(codexMarketplace.interface?.displayName, 'Codex marketplace display name required');
check(codexMarketplace.plugins?.length === pluginNames.length, 'Codex marketplace must list every plugin');
for (const entry of codexMarketplace.plugins ?? []) {
  check(pluginNames.includes(entry.name), `Codex marketplace: unknown plugin ${entry.name}`);
  check(entry.source?.source === 'local', `Codex marketplace: ${entry.name} must use a local source`);
  check(entry.source?.path === `./plugins/${entry.name}`, `Codex marketplace: invalid source for ${entry.name}`);
  check(entry.policy?.installation === 'AVAILABLE', `Codex marketplace: invalid installation policy for ${entry.name}`);
  check(entry.policy?.authentication === 'ON_INSTALL', `Codex marketplace: invalid authentication policy for ${entry.name}`);
  check(typeof entry.category === 'string' && entry.category.length > 0, `Codex marketplace: category required for ${entry.name}`);
}

const codexMcp = readFileSync(join(repoRoot, 'plugins/now-mcp/.mcp.json'), 'utf8');
check(!codexMcp.includes('CLAUDE_PLUGIN_ROOT'), 'Codex MCP adapter must not use Claude variables');
check(!codexMcp.includes('user_config.'), 'Codex MCP adapter must not use Claude user_config');
check(!existsSync(join(repoRoot, 'plugins/now-mcp/hooks/hooks.json')), 'Claude hook must not remain in a host-default path');

console.log(`Validated ${pluginNames.length} portable, Claude, Codex, and Cursor plugin packages.`);
