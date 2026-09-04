import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHUNK_CHARS,
  MAX_CHUNKS,
  MAX_TOTAL_CHARS,
  chunkKey,
  chunkWriterSource,
  reassembleChunks,
  validateMailboxEnvelope,
} from '../build/utils/mailbox-protocol.js';
import { nextPollDelayMs, pollIntervalMs } from '../build/utils/poll-schedule.js';

function rows(parentKey, parts) {
  return parts.map((value, i) => ({ name: chunkKey(parentKey, i), value }));
}

test('a single chunk reassembles to exactly its payload', () => {
  const r = reassembleChunks('mcp.k', 1, rows('mcp.k', ['hello']));
  assert.equal(r.payload, 'hello');
  assert.equal(r.error, undefined);
});

test('multiple chunks reassemble in index order regardless of response order', () => {
  // ServiceNow does not promise ordering on a query, and concatenating in
  // response order would silently scramble output rather than fail loudly.
  const shuffled = [
    { name: 'mcp.k.chunk.2', value: 'C' },
    { name: 'mcp.k.chunk.0', value: 'A' },
    { name: 'mcp.k.chunk.1', value: 'B' },
  ];
  const r = reassembleChunks('mcp.k', 3, shuffled);
  assert.equal(r.payload, 'ABC');
  assert.equal(r.error, undefined);
});

test('index 10 sorts after index 9, not lexically between 1 and 2', () => {
  const parts = Array.from({ length: 12 }, (_, i) => `[${i}]`);
  const r = reassembleChunks('mcp.k', 12, rows('mcp.k', parts));
  assert.equal(r.payload, parts.join(''));
});

test('a missing chunk is reported as incomplete rather than silently shortened', () => {
  // Silently returning 2 of 3 chunks is indistinguishable from a script that
  // logged less — the same class of bug as a silent zero-row read.
  const r = reassembleChunks('mcp.k', 3, [
    { name: 'mcp.k.chunk.0', value: 'A' },
    { name: 'mcp.k.chunk.2', value: 'C' },
  ]);
  assert.match(r.error, /missing chunk\(s\) 1 of 3/);
  assert.match(r.error, /INCOMPLETE/);
});

test('a duplicate chunk index is detected', () => {
  const r = reassembleChunks('mcp.k', 2, [
    { name: 'mcp.k.chunk.0', value: 'A' },
    { name: 'mcp.k.chunk.0', value: 'A-again' },
    { name: 'mcp.k.chunk.1', value: 'B' },
  ]);
  assert.match(r.error, /duplicate chunk\(s\) 0/);
});

test('a malformed chunk name is ignored, and its absence surfaces as missing', () => {
  const r = reassembleChunks('mcp.k', 2, [
    { name: 'mcp.k.chunk.0', value: 'A' },
    { name: 'mcp.k.chunk.notanumber', value: 'junk' },
  ]);
  assert.equal(r.payload, 'A');
  assert.match(r.error, /missing chunk\(s\) 1 of 2/);
});

test("chunks belonging to another execution are not absorbed", () => {
  // Two concurrent executions share the sys_properties table; a prefix collision
  // that pulled in a neighbour's chunk would corrupt both results.
  const r = reassembleChunks('mcp.mine', 1, [
    { name: 'mcp.mine.chunk.0', value: 'MINE' },
    { name: 'mcp.other.chunk.0', value: 'THEIRS' },
  ]);
  assert.equal(r.payload, 'MINE');
  assert.equal(r.error, undefined);
});

test('an empty chunk set for a zero-count envelope is not an error', () => {
  const r = reassembleChunks('mcp.k', 0, []);
  assert.equal(r.payload, '');
  assert.equal(r.error, undefined);
});

test('the transport cap sits well above the tool render cap', () => {
  // The point of chunking: the TOOL decides what the caller sees (8000 chars),
  // not the transport. If this inverts, the transport silently destroys data
  // again before the tool's guardrail can report it.
  assert.equal(MAX_TOTAL_CHARS, CHUNK_CHARS * MAX_CHUNKS);
  assert.ok(MAX_TOTAL_CHARS > 8000, 'transport must not truncate below the render cap');
});

test('the generated writer is ES5 — Rhino has no let/const/arrow/template literals', () => {
  const src = chunkWriterSource("'mcp.k'");
  assert.doesNotMatch(src, /\b(let|const)\s/);
  assert.doesNotMatch(src, /=>/);
  assert.doesNotMatch(src, /`/);
  assert.match(src, /__writeChunks/);
  assert.match(src, new RegExp(String(CHUNK_CHARS)));
  assert.match(src, new RegExp(String(MAX_CHUNKS)));
});

test('mailbox envelopes are validated before their values control reads or loops', () => {
  assert.equal(validateMailboxEnvelope({ status: 'pending' }).valid, true);
  assert.equal(validateMailboxEnvelope({ status: 'running' }).valid, true);
  assert.equal(validateMailboxEnvelope({ status: 'cancelled' }).valid, true);
  assert.equal(
    validateMailboxEnvelope({ status: 'done', success: true, chunkCount: MAX_CHUNKS }).valid,
    true,
  );
  assert.match(
    validateMailboxEnvelope({ status: 'done', success: true, chunkCount: MAX_CHUNKS + 1 }).error,
    /chunkCount/,
  );
  assert.match(
    validateMailboxEnvelope({ status: 'done', success: true, scriptDurationMs: -1 }).error,
    /scriptDurationMs/,
  );
  assert.match(
    validateMailboxEnvelope({ status: 'done', success: true, outputOriginalChars: -1 }).error,
    /outputOriginalChars/,
  );
  assert.match(
    validateMailboxEnvelope({ status: 'done', success: true, outputTruncated: 'yes' }).error,
    /outputTruncated/,
  );
  assert.match(
    validateMailboxEnvelope({ status: 'done', success: true, runtimeIdentity: 'system' }).error,
    /runtimeIdentity/,
  );
  assert.match(
    validateMailboxEnvelope({ status: 'done', output: 'missing success' }).error,
    /boolean success/,
  );
});

// ── adaptive polling ─────────────────────────────────────────────────────────

test('polling starts fast and backs off as the wait grows', () => {
  assert.equal(pollIntervalMs(0), 500);
  assert.equal(pollIntervalMs(2_999), 500);
  assert.equal(pollIntervalMs(3_000), 1_000);
  assert.equal(pollIntervalMs(9_999), 1_000);
  assert.equal(pollIntervalMs(10_000), 2_000);
  assert.equal(pollIntervalMs(60_000), 2_000);
});

test('only the steady-state interval is jittered', () => {
  // Early polls are short enough that spreading them is noise; the long tail is
  // where concurrent executions would otherwise stay in lockstep.
  assert.equal(nextPollDelayMs(0, () => 0.99), 500);
  assert.equal(nextPollDelayMs(5_000, () => 0.99), 1_000);
  assert.ok(nextPollDelayMs(20_000, () => 0.99) > 2_000);
  assert.equal(nextPollDelayMs(20_000, () => 0), 2_000);
});

test('adaptive polling cuts requests by well over 60% at the observed median wait', () => {
  // The acceptance target. Measured scheduler latency had a ~31s median, where
  // the old flat 500ms interval issued ~62 requests.
  const WAIT_MS = 31_000;
  let elapsed = 0;
  let adaptive = 0;
  while (elapsed < WAIT_MS) {
    elapsed += nextPollDelayMs(elapsed, () => 0);
    adaptive++;
  }
  const flat = Math.ceil(WAIT_MS / 500);
  const reduction = 1 - adaptive / flat;
  assert.ok(
    reduction >= 0.6,
    `expected >=60% fewer polls, got ${(reduction * 100).toFixed(1)}% (${adaptive} vs ${flat})`,
  );
});

test('completion detection stays within two seconds of flat polling', () => {
  // The other half of the tradeoff: backing off must not make a job that
  // finishes at an arbitrary moment feel materially slower to detect.
  for (const finishAt of [200, 1_500, 4_000, 12_000, 30_000]) {
    let elapsed = 0;
    while (elapsed < finishAt) elapsed += nextPollDelayMs(elapsed, () => 0);
    assert.ok(
      elapsed - finishAt <= 2_000,
      `detection lag ${elapsed - finishAt}ms at finishAt=${finishAt}`,
    );
  }
});

// ── transport health ─────────────────────────────────────────────────────────

test('transport health is absent until a background script has run', async () => {
  const { transportHealth, resetTransportHealth } = await import(
    '../build/utils/transport-health.js'
  );
  resetTransportHealth();
  // Absence, not zeros: a zeroed summary would read as "instantaneous".
  assert.equal(transportHealth('dev'), undefined);
});

test('transport health medians the window and flags a slow scheduler', async () => {
  const { recordTransportSample, transportHealth, resetTransportHealth } = await import(
    '../build/utils/transport-health.js'
  );
  resetTransportHealth();
  for (const wait of [30_000, 32_000, 31_000]) {
    recordTransportSample('dev', {
      totalDurationMs: wait + 500,
      observedSchedulerWaitMs: wait,
      pollCount: 12,
      outcome: 'completed',
    });
  }

  const health = transportHealth('dev');
  assert.equal(health.samples, 3);
  assert.equal(health.medianSchedulerWaitMs, 31_000);
  assert.equal(health.medianPollCount, 12);
  assert.match(health.note, /scheduler pickup plus polling detection/i);
  assert.match(health.note, /scriptApiPath/);
});

test('a healthy scheduler produces no complaint', async () => {
  const { recordTransportSample, transportHealth, resetTransportHealth } = await import(
    '../build/utils/transport-health.js'
  );
  resetTransportHealth();
  recordTransportSample('fast', {
    totalDurationMs: 900,
    observedSchedulerWaitMs: 400,
    pollCount: 2,
    outcome: 'completed',
  });

  assert.equal(transportHealth('fast').note, undefined);
});

test('the sample window is bounded', async () => {
  const { recordTransportSample, transportHealth, resetTransportHealth } = await import(
    '../build/utils/transport-health.js'
  );
  resetTransportHealth();
  for (let i = 0; i < 50; i++) {
    recordTransportSample('busy', { totalDurationMs: 100, pollCount: 1, outcome: 'completed' });
  }
  assert.ok(transportHealth('busy').samples <= 10);
});

test('scheduler wait is omitted from health when no sample reported one', async () => {
  const { recordTransportSample, transportHealth, resetTransportHealth } = await import(
    '../build/utils/transport-health.js'
  );
  resetTransportHealth();
  recordTransportSample('legacy', { totalDurationMs: 500, pollCount: 1, outcome: 'completed' });
  const health = transportHealth('legacy');
  assert.equal(health.medianSchedulerWaitMs, undefined);
  assert.equal(health.note, undefined);
});
