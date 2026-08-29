import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveDefaultAlignment } from '../build/utils/now-sdk-cli.js';
import { InstanceManager } from '../build/client/instance-manager.js';
import { validateWriteAccess } from '../build/utils/validators.js';

const CONFIGURED = [
  { name: '152992', url: 'https://demoalectriallwfaa152992.service-now.com/' },
  { name: 'dsta-demo', url: 'https://demoalectriallwfzj147775.service-now.com/' },
];

const dstaProfile = {
  alias: 'dsta',
  host: 'https://demoalectriallwfzj147775.service-now.com/',
  isDefault: true,
};

test('misaligned: now-sdk default differs from MCP default → recommend the switch', () => {
  const r = deriveDefaultAlignment(dstaProfile, CONFIGURED, '152992', true);
  assert.equal(r.defaultAligned, false);
  assert.equal(r.recommendedDefaultInstance, 'dsta-demo');
  assert.equal(r.nowSdkDefaultProfile, 'dsta');
  assert.equal(r.mcpDefaultInstance, '152992');
});

test('aligned: MCP default already matches now-sdk → no recommendation', () => {
  const r = deriveDefaultAlignment(dstaProfile, CONFIGURED, 'dsta-demo', true);
  assert.equal(r.defaultAligned, true);
  assert.equal(r.recommendedDefaultInstance, null);
});

test('now-sdk unavailable → indeterminate, never nags', () => {
  const r = deriveDefaultAlignment(null, CONFIGURED, '152992', false);
  assert.equal(r.nowSdkAvailable, false);
  assert.equal(r.defaultAligned, true);
  assert.equal(r.recommendedDefaultInstance, null);
});

test('now-sdk default host matches no configured instance → indeterminate', () => {
  const stranger = { alias: 'other', host: 'https://dev999999.service-now.com/', isDefault: true };
  const r = deriveDefaultAlignment(stranger, CONFIGURED, '152992', true);
  assert.equal(r.defaultAligned, true);
  assert.equal(r.recommendedDefaultInstance, null);
  assert.equal(r.nowSdkDefaultHost, 'https://dev999999.service-now.com/');
});

test('host comparison ignores protocol and trailing slash', () => {
  const noSlash = { alias: 'dsta', host: 'http://demoalectriallwfzj147775.service-now.com', isDefault: true };
  const r = deriveDefaultAlignment(noSlash, CONFIGURED, '152992', true);
  assert.equal(r.recommendedDefaultInstance, 'dsta-demo');
});

function manager() {
  return new InstanceManager([
    {
      name: 'dev-a',
      url: 'https://dev-a.service-now.com',
      auth: { type: 'basic', username: 'user', password: 'pass' },
      default: true,
      readOnly: false,
    },
    {
      name: 'dev-b',
      url: 'https://dev-b.service-now.com',
      auth: { type: 'basic', username: 'user', password: 'pass' },
      default: false,
      readOnly: false,
    },
  ]);
}

test('unqualified writes are blocked while automatic default alignment is pending', () => {
  const im = manager();
  im.beginDefaultAlignment();

  assert.throws(
    () => validateWriteAccess(im),
    (error) => error.code === 'DEFAULT_ALIGNMENT_PENDING' && error.statusCode === 503,
  );
  assert.doesNotThrow(() => validateWriteAccess(im, 'dev-a'));
});

test('automatic alignment atomically selects the resolved runtime default', () => {
  const im = manager();
  im.beginDefaultAlignment();

  assert.equal(im.completeDefaultAlignment('dev-b'), true);
  assert.equal(im.getDefaultInstance(), 'dev-b');
  assert.equal(im.isDefaultAlignmentPending(), false);
  assert.doesNotThrow(() => validateWriteAccess(im));
});

test('a manual switch wins over a late automatic follow result', () => {
  const im = manager();
  im.beginDefaultAlignment();
  im.setDefaultInstance('dev-b');

  assert.equal(im.completeDefaultAlignment('dev-a'), false);
  assert.equal(im.getDefaultInstance(), 'dev-b');
});
