import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBatchPayload,
  parseBatchResponse,
  isBatchEndpointUnavailable,
  isMutatingMethod,
} from '../build/utils/native-batch.js';

const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64');

test('sub-request bodies are base64-encoded', () => {
  // Verified against a live instance: a raw JSON string body is not serviced at
  // all — the response comes back with no serviced_requests, so the write is a
  // silent no-op. The encoding is not cosmetic.
  const payload = buildBatchPayload('b1', [
    { id: 'c0', method: 'POST', url: '/api/now/table/incident', body: { short_description: 'x' } },
  ]);

  const sub = payload.rest_requests[0];
  assert.equal(typeof sub.body, 'string');
  assert.deepEqual(JSON.parse(Buffer.from(sub.body, 'base64').toString('utf-8')), {
    short_description: 'x',
  });
});

test('a bodyless sub-request carries no body and no Content-Type', () => {
  const payload = buildBatchPayload('b1', [
    { id: 'd0', method: 'DELETE', url: '/api/now/table/incident/abc' },
  ]);

  const sub = payload.rest_requests[0];
  assert.ok(!('body' in sub));
  assert.deepEqual(
    sub.headers.map((h) => h.name),
    ['Accept'],
  );
});

test('parses per-sub-request status codes out of one 200 envelope', () => {
  const requests = [
    { id: 'r1', method: 'GET', url: '/api/now/table/incident' },
    { id: 'r2', method: 'GET', url: '/api/now/table/nope' },
  ];
  const raw = {
    serviced_requests: [
      { id: 'r1', status_code: 200, body: b64({ result: [{ number: 'INC1' }] }), body_encoding: 'base64' },
      {
        id: 'r2',
        status_code: 400,
        body: b64({ error: { message: 'Invalid table nope', detail: null } }),
        body_encoding: 'base64',
      },
    ],
    unserviced_requests: [],
  };

  const { responses, unserviced } = parseBatchResponse(raw, requests);

  assert.equal(responses.get('r1').statusCode, 200);
  assert.deepEqual(responses.get('r1').body.result, [{ number: 'INC1' }]);
  assert.equal(responses.get('r1').error, undefined);
  assert.equal(responses.get('r2').statusCode, 400);
  assert.match(responses.get('r2').error, /Invalid table nope/);
  assert.deepEqual(unserviced, []);
});

test('a 204 with no body parses without error', () => {
  const requests = [{ id: 'd0', method: 'DELETE', url: '/api/now/table/incident/abc' }];
  const { responses } = parseBatchResponse(
    { serviced_requests: [{ id: 'd0', status_code: 204 }], unserviced_requests: [] },
    requests,
  );

  assert.equal(responses.get('d0').statusCode, 204);
  assert.equal(responses.get('d0').body, undefined);
  assert.equal(responses.get('d0').error, undefined);
});

test('a requested id missing from the envelope is reported as unserviced', () => {
  // Not merely tidiness: a dropped sub-request that read as "no response, no
  // error" would be indistinguishable from success, which is how the base64
  // mistake presented.
  const requests = [
    { id: 'r1', method: 'GET', url: '/a' },
    { id: 'r2', method: 'GET', url: '/b' },
  ];
  const { unserviced } = parseBatchResponse(
    { serviced_requests: [{ id: 'r1', status_code: 200 }] },
    requests,
  );

  assert.deepEqual(unserviced, ['r2']);
});

test('unserviced ids are accepted as strings or as objects', () => {
  const requests = [{ id: 'r1', method: 'GET', url: '/a' }];
  assert.deepEqual(
    parseBatchResponse({ serviced_requests: [], unserviced_requests: ['r1'] }, requests).unserviced,
    ['r1'],
  );
  assert.deepEqual(
    parseBatchResponse({ serviced_requests: [], unserviced_requests: [{ id: 'r1' }] }, requests)
      .unserviced,
    ['r1'],
  );
});

test('a non-JSON sub-response body is surfaced verbatim rather than dropped', () => {
  const requests = [{ id: 'r1', method: 'GET', url: '/a' }];
  const raw = {
    serviced_requests: [
      {
        id: 'r1',
        status_code: 502,
        body: Buffer.from('<html>gateway</html>', 'utf-8').toString('base64'),
        body_encoding: 'base64',
      },
    ],
  };

  assert.equal(parseBatchResponse(raw, requests).responses.get('r1').body, '<html>gateway</html>');
});

test('only 404/405 mean the endpoint is absent', () => {
  assert.equal(isBatchEndpointUnavailable({ statusCode: 404 }), true);
  assert.equal(isBatchEndpointUnavailable({ statusCode: 405 }), true);
  assert.equal(isBatchEndpointUnavailable({ statusCode: 403 }), false);
  assert.equal(isBatchEndpointUnavailable({ statusCode: 500 }), false);
  assert.equal(isBatchEndpointUnavailable(new Error('boom')), false);
});

test('mutating methods are identified for audit', () => {
  for (const m of ['POST', 'PATCH', 'PUT', 'DELETE']) assert.equal(isMutatingMethod(m), true);
  assert.equal(isMutatingMethod('GET'), false);
});
