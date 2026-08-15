import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatToolCall } from '../build/utils/tool-log.js';

test('formatToolCall summarizes a successful call', () => {
  const { msg, data } = formatToolCall({
    tool: 'sn_query_records',
    durationMs: 42,
    ok: true,
  });
  assert.match(msg, /sn_query_records/);
  assert.match(msg, /\bok\b/);
  assert.match(msg, /42ms/);
  assert.deepEqual(data, {
    tool: 'sn_query_records',
    durationMs: 42,
    ok: true,
  });
});

test('formatToolCall includes the instance when present', () => {
  const { msg, data } = formatToolCall({
    tool: 'sn_create_records',
    durationMs: 10,
    ok: true,
    instance: 'prod',
  });
  assert.match(msg, /prod/);
  assert.equal(data.instance, 'prod');
});

test('formatToolCall summarizes an error call with the message', () => {
  const { msg, data } = formatToolCall({
    tool: 'sn_update_records',
    durationMs: 7,
    ok: false,
    error: 'boom',
  });
  assert.match(msg, /sn_update_records/);
  assert.match(msg, /error/);
  assert.match(msg, /boom/);
  assert.equal(data.ok, false);
  assert.equal(data.error, 'boom');
});

test('formatToolCall omits optional fields when absent', () => {
  const { data } = formatToolCall({
    tool: 'sn_list_tables',
    durationMs: 5,
    ok: true,
  });
  assert.equal('instance' in data, false);
  assert.equal('error' in data, false);
});

test('formatToolCall rounds and clamps the duration to a non-negative integer', () => {
  const a = formatToolCall({ tool: 't', durationMs: 12.7, ok: true });
  assert.equal(a.data.durationMs, 13);
  assert.match(a.msg, /13ms/);

  const b = formatToolCall({ tool: 't', durationMs: -3, ok: true });
  assert.equal(b.data.durationMs, 0);
  assert.match(b.msg, /0ms/);
});

test('formatToolCall is deterministic for identical input', () => {
  const entry = { tool: 'sn_delete_record', durationMs: 99, ok: false, error: 'nope' };
  assert.deepEqual(formatToolCall(entry), formatToolCall(entry));
});
