import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BatchService, resetBatchEndpointCache } from '../build/services/batch-service.js';

const WAVE_SIZE = 25; // mirrors DEFAULT_BATCH_CONCURRENCY in config/batch-config.ts

/**
 * Stub of the Table Batch API. `handle(request)` decides each sub-request's
 * outcome, mirroring the real endpoint's contract: the envelope itself succeeds
 * and every sub-request carries its own status code.
 *
 * `state.calls` counts ENVELOPES (round trips) and `state.subRequests` counts
 * logical operations — the distinction the batch transport exists to create.
 */
function makeBatchClient({ handle } = {}) {
  const state = { calls: 0, subRequests: 0, waves: [] };
  return {
    state,
    async batch(requests) {
      state.calls++;
      state.subRequests += requests.length;
      state.waves.push(requests);
      const responses = new Map();
      for (const request of requests) {
        const outcome = handle
          ? handle(request)
          : { statusCode: 200, body: { result: { sys_id: 'a'.repeat(32) } } };
        responses.set(request.id, {
          id: request.id,
          statusCode: outcome.statusCode,
          body: outcome.body,
          error: outcome.statusCode >= 400 ? (outcome.error ?? `HTTP ${outcome.statusCode}`) : undefined,
        });
      }
      return { responses, unserviced: [] };
    },
  };
}

/**
 * Stub for an instance WITHOUT the batch endpoint: `batch` rejects with a 404,
 * which is the signal to fall back to one request per record. Everything else
 * behaves like the single-record client.
 */
function makeLegacyClient({ failOn, getResult } = {}) {
  const state = { inFlight: 0, maxInFlight: 0, total: 0, batchAttempts: 0 };
  const run = async (body) => {
    state.inFlight++;
    state.total++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    // Yield so concurrent calls actually overlap.
    await new Promise((r) => setTimeout(r, 5));
    state.inFlight--;
    if (failOn && failOn(body)) throw new Error('simulated failure');
    return { result: { sys_id: 'a'.repeat(32) } };
  };
  return {
    state,
    async batch() {
      state.batchAttempts++;
      const error = new Error('Not Found');
      error.statusCode = 404;
      throw error;
    },
    async post(_endpoint, body) {
      return run(body);
    },
    async patch(_endpoint, body) {
      return run(body);
    },
    async put(_endpoint, body) {
      return run(body);
    },
    async get() {
      if (getResult) return getResult();
      return { result: [] };
    },
    async delete(endpoint) {
      state.total++;
      if (failOn && failOn(endpoint)) throw new Error('simulated failure');
      return {};
    },
  };
}

let instanceCounter = 0;

function makeManager(client, config = {}) {
  // Endpoint availability is memoized per instance name, so each manager gets a
  // fresh name — otherwise one test's 404 would silently disable the batch path
  // for every test after it.
  const name = `dev${instanceCounter++}`;
  const resolved = { name, client, config: { url: 'https://x.service-now.com', ...config } };
  return {
    getClient: () => client,
    resolveInstance: () => resolved,
    getConfig: () => ({ name, readOnly: false, ...config }),
    getConfigSource: () => ({ kind: 'env' }),
  };
}

test('batchCreate sends one request per wave instead of one per record', async () => {
  resetBatchEndpointCache();
  const client = makeBatchClient();
  const svc = new BatchService(makeManager(client));

  // 60 records => waves of 25/25/10 => 3 round trips, not 60.
  const records = Array.from({ length: 60 }, (_, i) => ({ short_description: `r${i}` }));
  const result = await svc.batchCreate('incident', records, true);

  assert.equal(result.success, true);
  assert.equal(result.successCount, 60);
  assert.equal(result.failureCount, 0);
  assert.equal(client.state.subRequests, 60);
  assert.equal(client.state.calls, 3, 'three waves => three HTTP requests');
  assert.ok(client.state.waves.every((w) => w.length <= WAVE_SIZE));
});

test('batchCreate continueOnError: one failed sub-request does not abort the rest', async () => {
  resetBatchEndpointCache();
  const client = makeBatchClient({
    handle: (request) =>
      request.body.short_description === 'r2'
        ? { statusCode: 400, body: { error: { message: 'simulated failure' } }, error: 'simulated failure' }
        : { statusCode: 201, body: { result: { sys_id: 'a'.repeat(32) } } },
  });
  const svc = new BatchService(makeManager(client));

  const records = Array.from({ length: 5 }, (_, i) => ({ short_description: `r${i}` }));
  const result = await svc.batchCreate('incident', records, true);

  assert.equal(result.success, false);
  assert.equal(result.successCount, 4);
  assert.equal(result.failureCount, 1);
  assert.equal(result.results[2].success, false);
  assert.match(result.results[2].error, /simulated failure/);
  assert.equal(result.results[0].success, true);
  assert.equal(result.results[4].success, true);
});

test('batchCreate continueOnError=false stops before the next wave', async () => {
  // 60 records = waves of 25/25/10. Fail one record in the FIRST wave. That wave
  // is a single request that cannot be recalled, but waves 2 and 3 must never be
  // sent — so exactly one envelope of 25 sub-requests goes out.
  resetBatchEndpointCache();
  const client = makeBatchClient({
    handle: (request) =>
      request.body.short_description === 'r3'
        ? { statusCode: 400, body: { error: { message: 'simulated failure' } }, error: 'simulated failure' }
        : { statusCode: 201, body: { result: { sys_id: 'a'.repeat(32) } } },
  });
  const svc = new BatchService(makeManager(client));

  const records = Array.from({ length: 60 }, (_, i) => ({ short_description: `r${i}` }));
  const result = await svc.batchCreate('incident', records, false);

  assert.equal(client.state.calls, 1, 'should not send a second wave');
  assert.equal(client.state.subRequests, WAVE_SIZE);
  assert.equal(result.success, false);
  assert.equal(result.failureCount, 1);
  assert.equal(result.successCount, WAVE_SIZE - 1);
  // results array stays dense (no sparse holes) and schema-conformant.
  assert.equal(result.results.length, WAVE_SIZE);
  assert.ok(result.results.every((r) => r !== undefined));
});

test('a sub-request the batch never serviced is reported as a failure, not a success', async () => {
  // The batch API answers 200 for the envelope even when a sub-request is
  // dropped. Treating a missing response as success is exactly how a malformed
  // envelope (e.g. a body that was not base64-encoded) would look like a no-op.
  resetBatchEndpointCache();
  const client = {
    state: {},
    async batch(requests) {
      const responses = new Map();
      // Service only the first request; the rest vanish.
      responses.set(requests[0].id, {
        id: requests[0].id,
        statusCode: 201,
        body: { result: { sys_id: 'a'.repeat(32) } },
      });
      return { responses, unserviced: [] };
    },
  };
  const svc = new BatchService(makeManager(client));

  const result = await svc.batchCreate('incident', [{ x: 1 }, { x: 2 }, { x: 3 }], true);

  assert.equal(result.successCount, 1);
  assert.equal(result.failureCount, 2);
  assert.match(result.results[1].error, /[Nn]ot serviced/);
});

test('batchUpdate reports per-record success/failure and keeps the sys_id on failures', async () => {
  resetBatchEndpointCache();
  const client = makeBatchClient({
    handle: (request) =>
      request.body.state === 'bad'
        ? { statusCode: 403, body: { error: { message: 'no write access' } }, error: 'no write access' }
        : { statusCode: 200, body: { result: { sys_id: 'a'.repeat(32) } } },
  });
  const svc = new BatchService(makeManager(client));

  const updates = [
    { sysId: 'a'.repeat(32), fields: { state: '2' } },
    { sysId: 'b'.repeat(32), fields: { state: 'bad' } },
    { sysId: 'c'.repeat(32), fields: { state: '3' } },
  ];
  const result = await svc.batchUpdate('incident', updates, 'partial', true);

  assert.equal(result.successCount, 2);
  assert.equal(result.failureCount, 1);
  assert.equal(result.results[1].success, false);
  assert.equal(result.results[1].sysId, 'b'.repeat(32));
  assert.equal(result.results[0].success, true);
});

test('batchUpdate uses PUT for a full update and PATCH for a partial one', async () => {
  resetBatchEndpointCache();
  const client = makeBatchClient();
  const svc = new BatchService(makeManager(client));
  const updates = [{ sysId: 'a'.repeat(32), fields: { state: '2' } }];

  await svc.batchUpdate('incident', updates, 'full', true);
  assert.equal(client.state.waves[0][0].method, 'PUT');

  await svc.batchUpdate('incident', updates, 'partial', true);
  assert.equal(client.state.waves[1][0].method, 'PATCH');
});

test('batch operations are blocked on read-only instances', async () => {
  resetBatchEndpointCache();
  const client = makeBatchClient();
  const svc = new BatchService(makeManager(client, { readOnly: true }));

  await assert.rejects(
    () => svc.batchCreate('incident', [{ short_description: 'x' }], true),
    /read-only/i
  );
  await assert.rejects(
    () => svc.batchUpdate('incident', [{ sysId: 'a'.repeat(32), fields: { x: 1 } }], 'partial', true),
    /read-only/i
  );
  await assert.rejects(
    () => svc.batchDelete('incident', ['a'.repeat(32)], true, false),
    /read-only/i
  );
  assert.equal(client.state.calls, 0);
});

test('batchDelete reports per-record success/failure and does not verify by default', async () => {
  resetBatchEndpointCache();
  const sysIds = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)];
  const client = makeBatchClient({
    handle: (request) =>
      request.url.includes(sysIds[1])
        ? { statusCode: 403, body: { error: { message: 'simulated failure' } }, error: 'simulated failure' }
        : { statusCode: 204 },
  });
  const svc = new BatchService(makeManager(client));

  const result = await svc.batchDelete('incident', sysIds, true, false);

  assert.equal(result.successCount, 2);
  assert.equal(result.failureCount, 1);
  assert.equal(result.results[1].success, false);
  assert.equal(result.results[1].sysId, sysIds[1]);
  assert.equal(result.results[0].verified, undefined);
  assert.equal(client.state.calls, 1, 'no verification round trip when verify=false');
});

test('batchDelete verification costs ONE extra request regardless of record count', async () => {
  resetBatchEndpointCache();
  const sysIds = Array.from({ length: 20 }, (_, i) => String(i).padStart(32, '0'));
  const client = makeBatchClient({
    handle: (request) => (request.method === 'DELETE' ? { statusCode: 204 } : { statusCode: 404 }),
  });
  const svc = new BatchService(makeManager(client));

  const result = await svc.batchDelete('incident', sysIds, true, true);

  assert.equal(result.successCount, 20);
  assert.ok(result.results.every((r) => r.verified === true));
  assert.equal(client.state.calls, 2, 'one delete wave + one verification wave');
});

test('a record that survives the delete is reported as a FAILURE, not a verified-false success', async () => {
  // The dangerous outcome is a caller being handed success:true for a record
  // that is still there, so verification demotes the entry rather than only
  // annotating it.
  resetBatchEndpointCache();
  const sysId = 'd'.repeat(32);
  const client = makeBatchClient({
    handle: (request) =>
      request.method === 'DELETE'
        ? { statusCode: 204 }
        : { statusCode: 200, body: { result: { sys_id: sysId } } },
  });
  const svc = new BatchService(makeManager(client));

  const result = await svc.batchDelete('incident', [sysId], true, true);

  assert.equal(result.results[0].success, false);
  assert.equal(result.results[0].verified, false);
  assert.match(result.results[0].error, /still exists/);
  assert.equal(result.success, false);
  assert.equal(result.failureCount, 1);
  assert.equal(result.successCount, 0);
});

test('a failed verification probe does not turn completed deletes into failures', async () => {
  resetBatchEndpointCache();
  const sysId = 'f'.repeat(32);
  let call = 0;
  const client = {
    state: {},
    async batch(requests) {
      call++;
      if (call === 2) throw new Error('network blip during verification');
      const responses = new Map();
      for (const r of requests) responses.set(r.id, { id: r.id, statusCode: 204 });
      return { responses, unserviced: [] };
    },
  };
  const svc = new BatchService(makeManager(client));

  const result = await svc.batchDelete('incident', [sysId], true, true);

  assert.equal(result.results[0].success, true);
  assert.equal(result.successCount, 1);
});

test('falls back to one request per record when the batch endpoint is absent', async () => {
  resetBatchEndpointCache();
  const client = makeLegacyClient();
  const svc = new BatchService(makeManager(client));

  const records = Array.from({ length: 5 }, (_, i) => ({ short_description: `r${i}` }));
  const result = await svc.batchCreate('incident', records, true);

  assert.equal(client.state.batchAttempts, 1, 'probes the batch endpoint once');
  assert.equal(client.state.total, 5, 'then falls back to one POST per record');
  assert.equal(result.successCount, 5);
});

test('the fallback path still reports per-record failures', async () => {
  resetBatchEndpointCache();
  const client = makeLegacyClient({ failOn: (body) => body.short_description === 'r1' });
  const svc = new BatchService(makeManager(client));

  const records = Array.from({ length: 5 }, (_, i) => ({ short_description: `r${i}` }));
  const result = await svc.batchCreate('incident', records, true);

  assert.equal(result.failureCount, 1);
  assert.equal(result.results[1].success, false);
  assert.match(result.results[1].error, /simulated failure/);
});

test('the fallback path bounds concurrency to the wave size', async () => {
  resetBatchEndpointCache();
  const client = makeLegacyClient();
  const svc = new BatchService(makeManager(client));

  const records = Array.from({ length: 60 }, (_, i) => ({ short_description: `r${i}` }));
  await svc.batchCreate('incident', records, true);

  assert.ok(
    client.state.maxInFlight <= WAVE_SIZE,
    `maxInFlight ${client.state.maxInFlight} should not exceed ${WAVE_SIZE}`
  );
});

test('the fallback path verifies deletes with a read-after-delete', async () => {
  resetBatchEndpointCache();
  const sysId = 'e'.repeat(32);
  const client = makeLegacyClient({
    getResult: () => {
      throw new Error('404 Not Found');
    },
  });
  const svc = new BatchService(makeManager(client));

  const result = await svc.batchDelete('incident', [sysId], true, true);

  assert.equal(result.results[0].success, true);
  assert.equal(result.results[0].verified, true);
});
