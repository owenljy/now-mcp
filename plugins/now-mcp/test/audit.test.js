import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordWrite } from '../build/utils/audit.js';
import { runWithOperationContext } from '../build/utils/operation-context.js';

function withAuditEnv(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sn-audit-'));
  const file = join(dir, 'audit.log');
  const prevFile = process.env.SERVICENOW_AUDIT_LOG;
  const prevMax = process.env.SERVICENOW_AUDIT_LOG_MAX_BYTES;
  process.env.SERVICENOW_AUDIT_LOG = file;
  try {
    fn(file);
  } finally {
    if (prevFile === undefined) delete process.env.SERVICENOW_AUDIT_LOG;
    else process.env.SERVICENOW_AUDIT_LOG = prevFile;
    if (prevMax === undefined) delete process.env.SERVICENOW_AUDIT_LOG_MAX_BYTES;
    else process.env.SERVICENOW_AUDIT_LOG_MAX_BYTES = prevMax;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('appends one JSON line per write with the expected shape', () => {
  withAuditEnv((file) => {
    recordWrite('post', '/api/now/table/incident', 'https://dev123.service-now.com');
    recordWrite('delete', '/api/now/table/incident/abc', 'https://dev123.service-now.com');

    const lines = readFileSync(file, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);

    const first = JSON.parse(lines[0]);
    assert.equal(first.method, 'POST'); // upper-cased
    assert.equal(first.endpoint, '/api/now/table/incident');
    assert.equal(first.host, 'dev123.service-now.com'); // host extracted from URL
    assert.ok(first.timestamp);
  });
});

test('rotates to <file>.1 once the size cap is exceeded', () => {
  withAuditEnv((file) => {
    process.env.SERVICENOW_AUDIT_LOG_MAX_BYTES = '200';

    // Pre-fill past the cap so the next write triggers rotation.
    writeFileSync(file, 'x'.repeat(250), 'utf-8');
    recordWrite('POST', '/api/now/table/incident', 'https://dev123.service-now.com');

    assert.ok(existsSync(`${file}.1`), 'expected a rotated backup file');
    assert.equal(statSync(`${file}.1`).size, 250, 'backup holds the pre-rotation content');

    // The live file is fresh and holds only the new entry.
    const lines = readFileSync(file, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).method, 'POST');
  });
});

test('keeps only one backup generation (second rotation overwrites .1)', () => {
  withAuditEnv((file) => {
    process.env.SERVICENOW_AUDIT_LOG_MAX_BYTES = '50';

    writeFileSync(file, 'a'.repeat(60), 'utf-8');
    recordWrite('POST', '/first', 'https://dev123.service-now.com'); // rotation #1
    writeFileSync(file, 'b'.repeat(60), 'utf-8'); // grow again
    recordWrite('POST', '/second', 'https://dev123.service-now.com'); // rotation #2

    // Only .1 exists (no .2); it holds the most recent pre-rotation content.
    assert.ok(existsSync(`${file}.1`));
    assert.ok(!existsSync(`${file}.2`), 'only a single backup generation is kept');
    assert.equal(readFileSync(`${file}.1`, 'utf-8'), 'b'.repeat(60));
  });
});

test('does not rotate when the cap is disabled (0 / invalid)', () => {
  withAuditEnv((file) => {
    process.env.SERVICENOW_AUDIT_LOG_MAX_BYTES = '0'; // disables rotation

    writeFileSync(file, 'x'.repeat(1000), 'utf-8');
    recordWrite('POST', '/api/now/table/incident', 'https://dev123.service-now.com');

    assert.ok(!existsSync(`${file}.1`), 'no rotation when cap is disabled');
  });
});

test('carries tool operation correlation into attempt and outcome entries', async () => {
  await new Promise((resolve, reject) => {
    withAuditEnv((file) => {
      runWithOperationContext(
        { operationId: 'op-123', instance: 'dev-b', tool: 'sn_update_records' },
        async () => {
          recordWrite('PATCH', '/api/now/table/incident/abc', 'https://dev-b.service-now.com');
          recordWrite(
            'PATCH',
            '/api/now/table/incident/abc',
            'https://dev-b.service-now.com',
            'outcome',
            'succeeded',
          );
          const lines = readFileSync(file, 'utf-8').trim().split('\n').map(JSON.parse);
          assert.deepEqual(lines.map((line) => line.event), ['attempt', 'outcome']);
          assert.equal(lines[1].outcome, 'succeeded');
          assert.equal(lines[0].operationId, 'op-123');
          assert.equal(lines[0].instance, 'dev-b');
          assert.equal(lines[0].tool, 'sn_update_records');
        },
      ).then(resolve, reject);
    });
  });
});
