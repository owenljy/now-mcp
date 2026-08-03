import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  maxBatchSize,
  batchConcurrency,
  batchDelayMs,
  DEFAULT_MAX_BATCH_SIZE,
  DEFAULT_BATCH_CONCURRENCY,
  DEFAULT_BATCH_DELAY_MS,
  MAX_BATCH_SIZE_CEILING,
} from '../build/config/batch-config.js';
import { BatchCreateSchema, BatchUpdateSchema, BatchDeleteSchema } from '../build/schemas/batch-schemas.js';

const SYS_ID = 'a'.repeat(32);

/** Run `fn` with an env var temporarily set (or unset when value===undefined). */
function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

test('maxBatchSize falls back to the default when unset', () => {
  withEnv('SERVICENOW_MAX_BATCH_SIZE', undefined, () => {
    assert.equal(maxBatchSize(), DEFAULT_MAX_BATCH_SIZE);
  });
});

test('maxBatchSize honors a valid env override (below the ceiling)', () => {
  withEnv('SERVICENOW_MAX_BATCH_SIZE', '80', () => {
    assert.equal(maxBatchSize(), 80);
  });
});

test('maxBatchSize clamps an override to the hard ceiling', () => {
  withEnv('SERVICENOW_MAX_BATCH_SIZE', '999999', () => {
    assert.equal(maxBatchSize(), MAX_BATCH_SIZE_CEILING);
  });
});

test('maxBatchSize ignores non-positive / non-integer values (fallback)', () => {
  for (const bad of ['0', '-5', 'abc', '10.5', '']) {
    withEnv('SERVICENOW_MAX_BATCH_SIZE', bad, () => {
      assert.equal(maxBatchSize(), DEFAULT_MAX_BATCH_SIZE, `value ${JSON.stringify(bad)} should fall back`);
    });
  }
});

test('batchConcurrency default and override', () => {
  withEnv('SERVICENOW_BATCH_CONCURRENCY', undefined, () => {
    assert.equal(batchConcurrency(), DEFAULT_BATCH_CONCURRENCY);
  });
  withEnv('SERVICENOW_BATCH_CONCURRENCY', '5', () => {
    assert.equal(batchConcurrency(), 5);
  });
});

test('batchDelayMs default, override, and zero-is-honored', () => {
  withEnv('SERVICENOW_BATCH_DELAY_MS', undefined, () => {
    assert.equal(batchDelayMs(), DEFAULT_BATCH_DELAY_MS);
  });
  withEnv('SERVICENOW_BATCH_DELAY_MS', '250', () => {
    assert.equal(batchDelayMs(), 250);
  });
  // 0 is a valid, meaningful value (disable inter-wave delay) — must not fall back.
  withEnv('SERVICENOW_BATCH_DELAY_MS', '0', () => {
    assert.equal(batchDelayMs(), 0);
  });
  // negative is invalid → fallback
  withEnv('SERVICENOW_BATCH_DELAY_MS', '-1', () => {
    assert.equal(batchDelayMs(), DEFAULT_BATCH_DELAY_MS);
  });
});

const makeRecords = (n) => Array.from({ length: n }, (_, i) => ({ short_description: `r${i}` }));
const makeUpdates = (n) => Array.from({ length: n }, () => ({ sysId: SYS_ID, fields: { priority: '1' } }));
const makeSysIds = (n) => Array.from({ length: n }, () => SYS_ID);

test('BatchCreateSchema enforces the configured cap at parse time', () => {
  withEnv('SERVICENOW_MAX_BATCH_SIZE', undefined, () => {
    // At the default cap: 50 ok, 51 rejected.
    assert.doesNotThrow(() => BatchCreateSchema.parse({ tableName: 'incident', records: makeRecords(50) }));
    assert.throws(
      () => BatchCreateSchema.parse({ tableName: 'incident', records: makeRecords(51) }),
      /more than 50 records/,
    );
  });
});

test('BatchCreateSchema cap follows the env override', () => {
  withEnv('SERVICENOW_MAX_BATCH_SIZE', '80', () => {
    // 51 now passes, 81 rejected with the raised limit in the message.
    assert.doesNotThrow(() => BatchCreateSchema.parse({ tableName: 'incident', records: makeRecords(51) }));
    assert.throws(
      () => BatchCreateSchema.parse({ tableName: 'incident', records: makeRecords(81) }),
      /more than 80 records/,
    );
  });
});

test('BatchUpdateSchema enforces the configured cap at parse time', () => {
  withEnv('SERVICENOW_MAX_BATCH_SIZE', undefined, () => {
    assert.doesNotThrow(() => BatchUpdateSchema.parse({ tableName: 'incident', updates: makeUpdates(50) }));
    assert.throws(
      () => BatchUpdateSchema.parse({ tableName: 'incident', updates: makeUpdates(51) }),
      /more than 50 records/,
    );
  });
});

test('BatchDeleteSchema enforces the configured cap at parse time', () => {
  withEnv('SERVICENOW_MAX_BATCH_SIZE', undefined, () => {
    assert.doesNotThrow(() => BatchDeleteSchema.parse({ tableName: 'incident', sysIds: makeSysIds(50) }));
    assert.throws(
      () => BatchDeleteSchema.parse({ tableName: 'incident', sysIds: makeSysIds(51) }),
      /more than 50 records/,
    );
  });
});

test('BatchDeleteSchema defaults verify to false and continueOnError to true', () => {
  const parsed = BatchDeleteSchema.parse({ tableName: 'incident', sysIds: makeSysIds(1) });
  assert.equal(parsed.verify, false);
  assert.equal(parsed.continueOnError, true);
});
