import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ScriptService } from '../build/services/script-service.js';
import { ServiceNowError } from '../build/types/errors.js';

function manager(client, config = {}) {
  const resolved = { name: 'dev', readOnly: false, ...config };
  return {
    getClient: () => client,
    getConfig: () => resolved,
    getConfigSource: () => ({ kind: 'env' }),
  };
}

function apiError(message = 'Requested URI does not represent any resource') {
  return new ServiceNowError(message, 404, undefined, 'NOT_FOUND');
}

test('Scripted REST 404 identifies the configured endpoint and remediation', async () => {
  const client = { post: async () => { throw apiError(); } };
  const service = new ScriptService(manager(client, { scriptApiPath: '/api/x_acme/scripts/run' }));

  await assert.rejects(
    service.executeBackgroundScript("gs.info('hello')"),
    (error) => {
		assert.equal(error.code, 'BACKGROUND_SCRIPT_ENDPOINT_UNAVAILABLE');
      assert.equal(error.statusCode, 404);
		assert.match(error.message, /Scripted REST execution transport failed/);
      assert.match(error.message, /POST \/api\/x_acme\/scripts\/run/);
		assert.match(error.message, /missing, inactive/);
		assert.match(error.message, /allowWrites does not affect it/);
		assert.match(error.message, /remove scriptApiPath/);
      return true;
    },
  );
});

test('ServiceNow requested-URI message is classified as endpoint unavailable even with HTTP 400', async () => {
  const error = new ServiceNowError('Requested URI does not represent any resource', 400, undefined, 'BAD_REQUEST');
  const client = { post: async () => { throw error; } };
  const service = new ScriptService(manager(client, { scriptApiPath: '/api/x_custom/script_runner/execute' }));

  await assert.rejects(service.executeBackgroundScript('1 + 1'), (caught) => {
    assert.equal(caught.code, 'BACKGROUND_SCRIPT_ENDPOINT_UNAVAILABLE');
    assert.equal(caught.statusCode, 400);
    assert.match(caught.message, /endpoint\/configuration failure occurred before the submitted script ran/);
    return true;
  });
});

test('transport status exposes strict scripted-rest routing and privilege model', () => {
  const service = new ScriptService(manager({}, { scriptApiPath: '/api/x_acme/scripts/run' }));
  assert.deepEqual(service.getExecutionTransportStatus(), {
    transport: 'scripted_rest',
    configuredPath: '/api/x_acme/scripts/run',
    usesCompanionEndpoint: true,
    fallbackOnFailure: false,
    privilegeModel: 'configured_endpoint_context',
    diagnostic: service.getExecutionTransportStatus().diagnostic,
  });
  assert.match(service.getExecutionTransportStatus().diagnostic, /does not elevate roles/);
});

test('transport status exposes sys_trigger when scriptApiPath is absent', () => {
  const service = new ScriptService(manager({}));
  const status = service.getExecutionTransportStatus();
  assert.equal(status.transport, 'sys_trigger');
  assert.equal(status.configuredPath, null);
  assert.equal(status.usesCompanionEndpoint, false);
  assert.match(status.diagnostic, /not an MCP role-escalation mechanism/);
});

test('Scripted REST response contract is validated', async () => {
  const client = { post: async () => ({ result: { output: 'missing success' } }) };
  const service = new ScriptService(manager(client, { scriptApiPath: '/api/x_acme/scripts/run' }));

  await assert.rejects(service.executeBackgroundScript('1 + 1'), (error) => {
    assert.equal(error.code, 'BACKGROUND_SCRIPT_INVALID_RESPONSE');
    assert.match(error.message, /expected \{ result: \{ success: boolean/);
    return true;
  });
});

test('mailbox creation failure identifies sys_properties and its access prerequisite', async () => {
  const client = { post: async () => { throw apiError(); } };
  const service = new ScriptService(manager(client));

  await assert.rejects(service.executeBackgroundScript('1 + 1'), (error) => {
    assert.equal(error.statusCode, 404);
    assert.match(error.message, /mailbox creation failed/);
    assert.match(error.message, /POST \/api\/now\/table\/sys_properties/);
    assert.match(error.message, /Configure a working scriptApiPath/);
    return true;
  });
});

test('trigger creation failure identifies sys_trigger and cleans up the mailbox', async () => {
  const deleted = [];
  const client = {
    async post(endpoint) {
      if (endpoint.endsWith('sys_properties')) return { result: { sys_id: 'prop-id' } };
      throw apiError();
    },
    async delete(endpoint) { deleted.push(endpoint); },
  };
  const service = new ScriptService(manager(client));

  await assert.rejects(service.executeBackgroundScript('1 + 1'), (error) => {
    assert.match(error.message, /trigger creation failed/);
    assert.match(error.message, /POST \/api\/now\/table\/sys_trigger/);
    return true;
  });
  assert.deepEqual(deleted, ['/api/now/table/sys_properties/prop-id']);
});

test('polling failure identifies the mailbox URL and cleans it up', async () => {
  const deleted = [];
  const client = {
    async post(endpoint) {
      if (endpoint.endsWith('sys_properties')) return { result: { sys_id: 'prop-id' } };
      return { result: { sys_id: 'trigger-id' } };
    },
    async get() { throw apiError(); },
    async delete(endpoint) { deleted.push(endpoint); },
  };
  const service = new ScriptService(manager(client));

  await assert.rejects(service.executeBackgroundScript('1 + 1', 2000), (error) => {
    assert.match(error.message, /mailbox polling failed/);
    assert.match(error.message, /GET \/api\/now\/table\/sys_properties\/prop-id/);
    return true;
  });
  assert.deepEqual(deleted, ['/api/now/table/sys_properties/prop-id']);
});

test('successful Scripted REST execution returns the validated result', async () => {
  const client = {
    post: async () => ({ result: { success: true, output: 'hello' } }),
  };
  const service = new ScriptService(manager(client, { scriptApiPath: '/api/x_acme/scripts/run' }));

  const result = await service.executeBackgroundScript("gs.info('hello')");
  assert.equal(result.success, true);
  assert.equal(result.output, 'hello');
	assert.equal(result.executionPath, 'scripted-rest');
	assert.equal(result.outcome, 'completed');
  assert.equal(typeof result.executionTime, 'number');
});

test('Scripted REST forwards runtime identity when the companion endpoint supplies it', async () => {
  const runtimeIdentity = {
    userName: 'integration.user',
    userId: 'user-id',
    roles: 'rest_api_explorer',
    isInteractive: false,
  };
  const client = {
    post: async () => ({ result: { success: true, output: 'ok', runtimeIdentity } }),
  };
  const service = new ScriptService(manager(client, { scriptApiPath: '/api/x_acme/scripts/run' }));

  const result = await service.executeBackgroundScript('1 + 1');
  assert.deepEqual(result.runtimeIdentity, runtimeIdentity);
});

test('sys_trigger wrapper captures bounded scheduler runtime identity', async () => {
  let triggerPayload;
  let polls = 0;
  const client = {
    async post(endpoint, payload) {
      if (endpoint.endsWith('sys_properties')) return { result: { sys_id: 'prop-id' } };
      triggerPayload = payload;
      return { result: { sys_id: 'trigger-id' } };
    },
    async get() {
      polls += 1;
      return {
        result: {
          value: JSON.stringify({
            status: 'done',
            success: true,
            output: 'ok',
            runtimeIdentity: {
              userName: 'system',
              userId: 'system-id',
              roles: 'admin,maint',
              isInteractive: false,
            },
          }),
        },
      };
    },
    async delete() {},
  };
  const service = new ScriptService(manager(client));

  const result = await service.executeBackgroundScript("gs.info('ok')", 2000);
  assert.equal(polls, 1);
  assert.match(triggerPayload.script, /getUserName\(\).*substring\(0, 160\)/);
  assert.match(triggerPayload.script, /getRoles\(\).*substring\(0, 800\)/);
  // The wrapper no longer caps output inline at 2700 chars — it writes chunks.
  // (The literal 2700 survives only in a comment explaining the old behaviour.)
  assert.doesNotMatch(triggerPayload.script, /substring\(0, 2700\)/);
  assert.match(triggerPayload.script, /__writeChunks/);
  assert.deepEqual(result.runtimeIdentity, {
    userName: 'system',
    userId: 'system-id',
    roles: 'admin,maint',
    isInteractive: false,
  });
  // This envelope carries no chunkCount — the legacy single-mailbox shape a
  // trigger created by a previous build still writes. It must keep working
  // across an upgrade, since such a trigger can be in flight when we deploy.
  assert.equal(result.output, 'ok');
});
// ── chunked mailbox transport ────────────────────────────────────────────────

/**
 * A sys_trigger client backed by an in-memory sys_properties table, so the
 * chunk write/read/cleanup cycle can be exercised end to end. `chunks` is what
 * the (simulated) trigger wrote; `deleted` records every cleanup delete so a
 * test can assert nothing is left behind.
 */
function makeTriggerClient({ envelope, chunks = {}, failChunkRead = false }) {
  const state = { polls: 0, deleted: [], chunkQueries: 0 };
  const props = { ...chunks };
  return {
    state,
    props,
    async post(endpoint, payload) {
      if (endpoint.endsWith('sys_properties')) return { result: { sys_id: 'prop-id' } };
      state.triggerScript = payload.script;
      return { result: { sys_id: 'trigger-id' } };
    },
    async get(endpoint, params) {
      // Chunk read / cleanup enumeration (a query, not a by-sys_id fetch).
      if (params && params.sysparm_query) {
        state.chunkQueries++;
        if (failChunkRead) throw new Error('chunk read failed');
        const prefix = params.sysparm_query.replace('nameSTARTSWITH', '');
        const result = Object.entries(props)
          .filter(([name]) => name.startsWith(prefix))
          .map(([name, value]) => ({ name, value, sys_id: `id-${name}` }));
        return { result };
      }
      state.polls++;
      return { result: { value: JSON.stringify(envelope) } };
    },
    async delete(endpoint) {
      const sysId = endpoint.split('/').pop();
      state.deleted.push(sysId);
      for (const name of Object.keys(props)) {
        if (`id-${name}` === sysId) delete props[name];
      }
    },
  };
}

/** A ScriptService whose polling never actually waits. */
function fastService(client) {
  return new ScriptService(manager(client), { sleep: async () => {}, random: () => 0 });
}

test('a multi-chunk payload is reconstructed exactly, well past the old 2.7KB limit', async () => {
  // The regression: 18% of background-script calls in the source transcript hit
  // the 2700-char inline cap and lost data before the tool could apply its own.
  const big = 'x'.repeat(3500) + 'y'.repeat(3500) + 'z'.repeat(1000);
  const client = makeTriggerClient({
    envelope: { status: 'done', success: true, chunkCount: 3, scriptDurationMs: 40 },
    chunks: {
      'k.chunk.0': 'x'.repeat(3500),
      'k.chunk.1': 'y'.repeat(3500),
      'k.chunk.2': 'z'.repeat(1000),
    },
  });
  // Align the in-memory chunk names with the generated key for this execution.
  const service = fastService(client);
  const origPost = client.post.bind(client);
  client.post = async (endpoint, payload) => {
    if (endpoint.endsWith('sys_properties')) {
      const key = payload.name;
      for (const suffix of ['0', '1', '2']) {
        client.props[`${key}.chunk.${suffix}`] = client.props[`k.chunk.${suffix}`];
        delete client.props[`k.chunk.${suffix}`];
      }
    }
    return origPost(endpoint, payload);
  };

  const result = await service.executeBackgroundScript('run()', 5000);

  assert.equal(result.success, true);
  assert.equal(result.output, big);
  assert.equal(result.output.length, 8000);
});

test('a missing chunk fails the call instead of returning short output', async () => {
  const client = makeTriggerClient({
    envelope: { status: 'done', success: true, chunkCount: 3 },
    chunks: {},
  });
  const service = fastService(client);
  const origPost = client.post.bind(client);
  client.post = async (endpoint, payload) => {
    if (endpoint.endsWith('sys_properties')) {
      client.props[`${payload.name}.chunk.0`] = 'A';
      client.props[`${payload.name}.chunk.2`] = 'C';
    }
    return origPost(endpoint, payload);
  };

  const result = await service.executeBackgroundScript('run()', 5000);

  assert.equal(result.success, false);
  assert.match(result.error, /could not be fully reassembled/);
  assert.match(result.error, /missing chunk\(s\) 1 of 3/);
});

test('a chunk write failure on the instance is reported as such, not as a script bug', async () => {
  const client = makeTriggerClient({
    envelope: { status: 'done', success: true, chunkCount: 1, chunkWriteFailed: true },
  });
  const result = await fastService(client).executeBackgroundScript('run()', 5000);

  assert.equal(result.success, false);
  assert.match(result.error, /chunk_write_failed/);
  assert.match(result.error, /The script itself ran and reported success/);
});

test('a chunked error body survives — a long stack trace is no longer cut', async () => {
  const stack = 'Error: boom\n' + '    at frame\n'.repeat(400);
  const client = makeTriggerClient({
    envelope: { status: 'done', success: false, chunkCount: 2 },
  });
  const service = fastService(client);
  const origPost = client.post.bind(client);
  client.post = async (endpoint, payload) => {
    if (endpoint.endsWith('sys_properties')) {
      client.props[`${payload.name}.chunk.0`] = stack.slice(0, 3500);
      client.props[`${payload.name}.chunk.1`] = stack.slice(3500);
    }
    return origPost(endpoint, payload);
  };

  const result = await service.executeBackgroundScript('boom()', 5000);

  assert.equal(result.success, false);
  assert.equal(result.error, stack);
  assert.ok(stack.length > 2700, 'fixture must exceed the old inline cap to be meaningful');
});

test('every chunk and the parent are deleted on the success path', async () => {
  const client = makeTriggerClient({
    envelope: { status: 'done', success: true, chunkCount: 2 },
  });
  const service = fastService(client);
  const origPost = client.post.bind(client);
  client.post = async (endpoint, payload) => {
    if (endpoint.endsWith('sys_properties')) {
      client.props[`${payload.name}.chunk.0`] = 'A';
      client.props[`${payload.name}.chunk.1`] = 'B';
    }
    return origPost(endpoint, payload);
  };

  await service.executeBackgroundScript('run()', 5000);

  assert.deepEqual(Object.keys(client.props), [], 'no chunk properties may survive');
  assert.ok(client.state.deleted.includes('prop-id'), 'the parent must be deleted too');
});

test('chunks written by a late trigger are cleaned up after a timeout', async () => {
  // The trigger can run after we stop waiting. Leaving its chunks behind would
  // accumulate orphaned sys_properties rows on every timed-out execution.
  const client = makeTriggerClient({ envelope: { status: 'pending' } });
  const service = fastService(client);
  const origPost = client.post.bind(client);
  client.post = async (endpoint, payload) => {
    if (endpoint.endsWith('sys_properties')) {
      client.props[`${payload.name}.chunk.0`] = 'late';
    }
    return origPost(endpoint, payload);
  };

  const result = await service.executeBackgroundScript('slow()', 30);

  assert.equal(result.outcome, 'timed_out');
  assert.deepEqual(Object.keys(client.props), []);
});

test('a failed chunk read degrades to an explicit incomplete result, not a lost run', async () => {
  const client = makeTriggerClient({
    envelope: { status: 'done', success: true, chunkCount: 2 },
    failChunkRead: true,
  });

  const result = await fastService(client).executeBackgroundScript('run()', 5000);

  assert.equal(result.success, false);
  assert.match(result.error, /could not be fully reassembled/);
});

// ── timings ──────────────────────────────────────────────────────────────────

test('timings separate scheduler wait from script runtime and count polls', async () => {
  const client = makeTriggerClient({
    envelope: { status: 'done', success: true, chunkCount: 0, scriptDurationMs: 42 },
  });

  const result = await fastService(client).executeBackgroundScript('run()', 5000);

  assert.equal(result.timings.scriptDurationMs, 42);
  assert.equal(typeof result.timings.totalDurationMs, 'number');
  assert.equal(typeof result.timings.cleanupDurationMs, 'number');
  assert.ok(result.timings.pollCount >= 1);
  assert.ok(result.timings.observedSchedulerWaitMs >= 0, 'must never be negative');
});

test('scheduler wait is omitted when the script did not report its own duration', async () => {
  // Derived as total − script − cleanup; without the script term the
  // subtraction is meaningless, so it is withheld rather than guessed.
  const client = makeTriggerClient({
    envelope: { status: 'done', success: true, chunkCount: 0 },
  });

  const result = await fastService(client).executeBackgroundScript('run()', 5000);

  assert.equal(result.timings.observedSchedulerWaitMs, undefined);
  assert.equal(result.timings.scriptDurationMs, undefined);
});

test('a timed-out execution still reports timings', async () => {
  const client = makeTriggerClient({ envelope: { status: 'pending' } });
  const result = await fastService(client).executeBackgroundScript('slow()', 30);
  assert.equal(result.outcome, 'timed_out');
  assert.ok(result.timings.pollCount >= 1);
});
