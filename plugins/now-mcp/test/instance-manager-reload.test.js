import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { InstanceManager } from '../build/client/instance-manager.js';

const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function yaml(password, extra = '') {
  return `instances:
  - name: dev
    url: https://dev123.service-now.com
    auth:
      type: basic
      username: api.user
      password: ${password}
    default: true
    readOnly: true
${extra}`;
}

function manager(configPath) {
  return new InstanceManager(
    [
      {
        name: 'dev',
        url: 'https://dev123.service-now.com',
        auth: { type: 'basic', username: 'api.user', password: 'stale' },
        default: true,
        readOnly: true,
      },
    ],
    { kind: 'yaml', path: configPath },
  );
}

test('resetConnection reloads Basic credentials from YAML and rebuilds the client', () => {
  const dir = mkdtempSync(join(tmpdir(), 'now-mcp-reload-'));
  dirs.push(dir);
  const configPath = join(dir, 'credentials.yaml');
  writeFileSync(configPath, yaml('fresh-secret'));
  const im = manager(configPath);
  const oldClient = im.getClient('dev');
	assert.equal(im.getConfigRevision(), 0);

  const result = im.resetConnection('dev');

  assert.equal(result.configReloaded, true);
  assert.equal(result.configSource, 'yaml');
  assert.equal(result.reloadedInstances, 1);
  assert.notEqual(im.getClient('dev'), oldClient);
  assert.equal(im.getConfig('dev').auth.password, 'fresh-secret');
	assert.equal(im.getConfigRevision(), 1);
});

test('invalid reloaded YAML leaves the existing client and config untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'now-mcp-reload-invalid-'));
  dirs.push(dir);
  const configPath = join(dir, 'credentials.yaml');
  writeFileSync(configPath, 'instances: [not-valid');
  const im = manager(configPath);
  const oldClient = im.getClient('dev');

  assert.throws(() => im.resetConnection('dev'), /Failed to load configuration/);
  assert.equal(im.getClient('dev'), oldClient);
  assert.equal(im.getConfig('dev').auth.password, 'stale');
	assert.equal(im.getConfigRevision(), 0);
});

test('environment-backed reset remains reset-only and reports no reload', () => {
  const im = new InstanceManager(
    [
      {
        name: 'default',
        url: 'https://dev123.service-now.com',
        auth: { type: 'basic', username: 'api.user', password: 'secret' },
        default: true,
        readOnly: true,
      },
    ],
    { kind: 'env' },
  );

  const result = im.resetConnection();

  assert.equal(result.configReloaded, false);
  assert.equal(result.configSource, 'env');
  assert.equal(result.reloadedInstances, 0);
	assert.equal(im.getConfigRevision(), 0);
});
