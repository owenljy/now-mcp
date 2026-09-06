import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetworkError, ServiceNowError } from '../build/types/errors.js';
import { shouldFallbackToNowSdkQuery, TableService } from '../build/services/table-service.js';
import { runWithOperationContext } from '../build/utils/operation-context.js';

test('MCP operation cancellation reaches the asynchronous SDK fallback',async()=>{
  const controller=new AbortController();const reason=new Error('MCP cancelled');let entered;
  const ready=new Promise(r=>{entered=r;});
  const config={name:'dev',url:'https://dev.service-now.com'};
  const manager={resolveInstance:()=>({name:'dev',config,client:{getWithHeaders:async()=>{throw new ServiceNowError('REST disabled',403);}}})};
  const service=new TableService(manager,{getTableAccessProfile:async()=>({exists:true,wsAccess:false})},async(url,table,options)=>{
    assert.equal(options.signal,controller.signal);entered();
    return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
  });
  const pending=runWithOperationContext({operationId:'test',instance:'dev',tool:'sn_query_records',signal:controller.signal},()=>service.queryRecordsWithMeta('incident',{allowNowSdkFallback:true}));
  const rejected=assert.rejects(pending,e=>e===reason);await ready;controller.abort(reason);await rejected;
});

test('async fallback receives the explicit profile and preserves the original status with safe failure details',async()=>{
  const error=new ServiceNowError('REST disabled',403,undefined,'ACCESS_DENIED');
  const config={name:'dev',url:'https://dev.service-now.com',nowSdkProfile:'chosen'};
  const manager={resolveInstance:()=>({name:'dev',config,client:{getWithHeaders:async()=>{throw error;}}})};
  const service=new TableService(manager,{getTableAccessProfile:async()=>({exists:true,wsAccess:false})},async(url,table,options)=>{
    assert.equal(options.authProfile,'chosen');await new Promise(r=>setImmediate(r));
    return {ok:false,reason:'selected now-sdk profile authentication failed'};
  });
  await assert.rejects(service.queryRecordsWithMeta('incident',{allowNowSdkFallback:true}),caught=>{
    assert.equal(caught,error);assert.equal(caught.toJSON().error.statusCode,403);
    assert.match(caught.toJSON().error.fallbackFailure.reason,/authentication failed/);return true;
  });
});

/**
 * A stub ServiceNow client that records every call (endpoint + params/body)
 * and returns canned responses. No network.
 */
function makeStubClient(responses = {}) {
  const calls = [];
  const respond = (method, endpoint) => {
    const key = `${method} ${endpoint}`;
    if (key in responses) return responses[key];
    if (method in responses) return responses[method];
    return { result: [] };
  };
  return {
    calls,
    async get(endpoint, params) {
      calls.push({ method: 'get', endpoint, params });
      return respond('get', endpoint);
    },
    async getWithHeaders(endpoint, params) {
      calls.push({ method: 'get', endpoint, params });
      const data = respond('get', endpoint);
      // Mirror the shape ServiceNowClient.getWithHeaders returns. Tests can
      // supply an 'x-total-count' via the `headers` response key.
      return { data, headers: responses.headers || {} };
    },
    async post(endpoint, body) {
      calls.push({ method: 'post', endpoint, body });
      return respond('post', endpoint);
    },
    async put(endpoint, body) {
      calls.push({ method: 'put', endpoint, body });
      return respond('put', endpoint);
    },
    async patch(endpoint, body) {
      calls.push({ method: 'patch', endpoint, body });
      return respond('patch', endpoint);
    },
    async delete(endpoint) {
      calls.push({ method: 'delete', endpoint });
      return respond('delete', endpoint);
    },
  };
}

/**
 * Fake InstanceManager: hands out a stub client and a config. readOnly:false
 * by default so write-access validation passes.
 */
function makeManager(client, config = {}) {
	const resolvedConfig = { name: 'dev', url: 'https://dev.service-now.com', readOnly: false, ...config };
  return {
    getClient: () => client,
		resolveInstance: () => ({ name: resolvedConfig.name, config: resolvedConfig, client }),
		getConfig: () => resolvedConfig,
    getConfigSource: () => ({ kind: 'env' }),
  };
}

test('queryRecords sanitizes query, sets pagination, fields, and display value', async () => {
  const client = makeStubClient({ get: { result: [{ sys_id: 'a'.repeat(32) }] } });
  const svc = new TableService(makeManager(client));

  const out = await svc.queryRecords('incident', {
    query: 'priority=1^state=2',
    limit: 25,
    offset: 50,
    fields: ['number', 'short_description'],
    displayValue: 'all',
  });

  assert.equal(out.length, 1);
  const call = client.calls[0];
  assert.equal(call.method, 'get');
  assert.equal(call.endpoint, '/api/now/table/incident');
  assert.equal(call.params.sysparm_query, 'priority=1^state=2');
  assert.equal(call.params.sysparm_limit, 25);
  assert.equal(call.params.sysparm_offset, 50);
  assert.equal(call.params.sysparm_fields, 'number,short_description');
  assert.equal(call.params.sysparm_display_value, 'all');
});

test('queryRecordsWithMeta returns X-Total-Count and passes excludeReferenceLink', async () => {
  const client = makeStubClient({
    get: { result: [{ sys_id: 'a'.repeat(32) }] },
    headers: { 'x-total-count': '4200' },
  });
  const svc = new TableService(makeManager(client));

  const out = await svc.queryRecordsWithMeta('incident', {
    query: 'active=true',
    limit: 1,
    excludeReferenceLink: true,
  });

  // out.records stays Record<string,unknown>[] — never columnarized at the
  // service layer. The columnar {columns,rows} projection lives only at the
  // tool boundary (query-records-tool.ts); get-runtime-events-tool.ts's
  // row.sys_id dedupe (pre-columnarization) depends on services handing back
  // plain row objects, so this shape is load-bearing, not incidental.
  assert.equal(out.records.length, 1);
  assert.equal(out.totalCount, 4200);
  assert.equal(client.calls[0].params.sysparm_exclude_reference_link, true);
});

test('queryRecordsWithMeta reports null totalCount when header is absent', async () => {
  const client = makeStubClient({ get: { result: [] } });
  const svc = new TableService(makeManager(client));
  const out = await svc.queryRecordsWithMeta('incident', {});
  assert.equal(out.totalCount, null);
});

test('now-sdk query fallback is limited to independent-path failures', () => {
	assert.equal(shouldFallbackToNowSdkQuery(new NetworkError('socket reset')), true);
	assert.equal(shouldFallbackToNowSdkQuery(new ServiceNowError('Unauthorized', 401)), true);
	assert.equal(shouldFallbackToNowSdkQuery(new ServiceNowError('Server error', 503)), true);
	assert.equal(shouldFallbackToNowSdkQuery(new ServiceNowError('Forbidden', 403)), false);
	assert.equal(shouldFallbackToNowSdkQuery(new ServiceNowError('Rate limited', 429)), false);
	assert.equal(shouldFallbackToNowSdkQuery(new ServiceNowError('Bad query', 400)), false);
});

test('queryRecords uses now-sdk for a 403 only when metadata confirms REST is disabled', async () => {
	const client = makeStubClient();
	client.getWithHeaders = async () => {
		throw new ServiceNowError('Forbidden', 403);
	};
	const profileCalls = [];
	const schemaService = {
		async getTableAccessProfile(table, instance) {
			profileCalls.push({ table, instance });
			return { exists: true, readAccess: true, wsAccess: false };
		},
	};
	const fallbackCalls = [];
	const nowSdkQuery = (url, table, options) => {
		fallbackCalls.push({ url, table, options });
		return {
			ok: true,
			records: [{ sys_id: 'a'.repeat(32), number: 'INC0001' }],
			hasMore: false,
			nextOffset: null,
			profile: 'dev-admin',
		};
	};
	const svc = new TableService(makeManager(client), schemaService, nowSdkQuery);

	const out = await svc.queryRecordsWithMeta(
		'incident',
		{ query: 'active=true', allowNowSdkFallback: true },
		'dev',
	);

	assert.deepEqual(profileCalls, [{ table: 'incident', instance: 'dev' }]);
	assert.equal(fallbackCalls.length, 1);
	assert.equal(fallbackCalls[0].url, 'https://dev.service-now.com');
	assert.equal(out.source, 'now-sdk-query');
	assert.equal(out.fallbackProfile, 'dev-admin');
	assert.equal(out.records[0].number, 'INC0001');
});

test('queryRecords never turns an ordinary or unverified 403 into an implicit fallback', async () => {
	for (const { allowNowSdkFallback, accessProfile } of [
		{ allowNowSdkFallback: false, accessProfile: { exists: true, wsAccess: false } },
		{ allowNowSdkFallback: true, accessProfile: { exists: true, wsAccess: true } },
		{ allowNowSdkFallback: true, accessProfile: { exists: true } },
	]) {
		const client = makeStubClient();
		client.getWithHeaders = async () => {
			throw new ServiceNowError('Forbidden', 403);
		};
		let fallbackCalls = 0;
		const schemaService = {
			async getTableAccessProfile() {
				return accessProfile;
			},
		};
		const svc = new TableService(makeManager(client), schemaService, () => {
			fallbackCalls += 1;
			return { ok: false, reason: 'must not run' };
		});

		await assert.rejects(
			() => svc.queryRecordsWithMeta('incident', { allowNowSdkFallback }),
			/Forbidden/,
		);
		assert.equal(fallbackCalls, 0);
	}
});

test('a failed 403 access-profile probe preserves the original denial', async () => {
	const original = new ServiceNowError('Original forbidden', 403);
	const client = makeStubClient();
	client.getWithHeaders = async () => {
		throw original;
	};
	const schemaService = {
		async getTableAccessProfile() {
			throw new Error('metadata unavailable');
		},
	};
	let fallbackCalls = 0;
	const svc = new TableService(makeManager(client), schemaService, () => {
		fallbackCalls += 1;
		return { ok: false, reason: 'must not run' };
	});

	await assert.rejects(
		() => svc.queryRecordsWithMeta('incident', { allowNowSdkFallback: true }),
		(error) => error === original,
	);
	assert.equal(fallbackCalls, 0);
});

test('queryRecords blocks XSS-style queries via sanitizeQuery', async () => {
  const client = makeStubClient();
  const svc = new TableService(makeManager(client));
  await assert.rejects(
    () => svc.queryRecords('incident', { query: '<script>alert(1)</script>' }),
    /dangerous/i
  );
  assert.equal(client.calls.length, 0);
});

test('aggregateRecords builds Stats params and hits the stats endpoint', async () => {
  const client = makeStubClient({ get: { result: { stats: { count: '7' } } } });
  const svc = new TableService(makeManager(client));

  await svc.aggregateRecords('incident', {
    query: 'active=true',
    count: true,
    groupBy: ['category', 'priority'],
    avgFields: ['business_duration'],
    sumFields: ['reassignment_count'],
    minFields: ['sys_created_on'],
    maxFields: ['sys_updated_on'],
    having: 'count>5',
    orderBy: 'count',
    displayValue: true,
  });

  const call = client.calls[0];
  assert.equal(call.method, 'get');
  assert.equal(call.endpoint, '/api/now/stats/incident');
  assert.equal(call.params.sysparm_query, 'active=true');
  assert.equal(call.params.sysparm_count, true);
  assert.equal(call.params.sysparm_group_by, 'category,priority');
  assert.equal(call.params.sysparm_avg_fields, 'business_duration');
  assert.equal(call.params.sysparm_sum_fields, 'reassignment_count');
  assert.equal(call.params.sysparm_min_fields, 'sys_created_on');
  assert.equal(call.params.sysparm_max_fields, 'sys_updated_on');
  assert.equal(call.params.sysparm_having, 'count>5');
  assert.equal(call.params.sysparm_orderby, 'count');
  assert.equal(call.params.sysparm_display_value, true);
});

test('getRecord requests exclude-reference-link to trim {value,display_value,link} noise', async () => {
  const rec = { sys_id: 'd'.repeat(32), number: 'INC0009' };
  const client = makeStubClient({ get: { result: rec } });
  const svc = new TableService(makeManager(client));

  const out = await svc.getRecord('incident', 'd'.repeat(32), ['number']);
  assert.deepEqual(out, rec);
  const call = client.calls[0];
  assert.equal(call.method, 'get');
  assert.equal(call.params.sysparm_exclude_reference_link, true);
  assert.equal(call.params.sysparm_fields, 'number');
});

test('createRecord POSTs to the table endpoint and returns the result', async () => {
  const created = { sys_id: 'b'.repeat(32), number: 'INC0001' };
  const client = makeStubClient({ post: { result: created } });
  const svc = new TableService(makeManager(client));

  const rec = await svc.createRecord('incident', { short_description: 'x' });
  assert.deepEqual(rec, created);
  const call = client.calls[0];
  assert.equal(call.method, 'post');
  // Endpoint carries the exclude-reference-link flag to trim the echoed row.
  assert.equal(call.endpoint, '/api/now/table/incident?sysparm_exclude_reference_link=true');
  assert.deepEqual(call.body, { short_description: 'x' });
});

test('createRecord adds sysparm_transaction_scope when the table belongs to a scoped app', async () => {
  const created = { sys_id: 'b'.repeat(32) };
  const client = makeStubClient({ post: { result: created } });
  const sysId = 'a1'.repeat(16);
  const schemaService = {
    async resolveTableScope() {
      return { scoped: true, scopeSysId: sysId, scopeName: 'x_snc_myapp' };
    },
  };
  const svc = new TableService(makeManager(client), schemaService);

  await svc.createRecord('x_snc_myapp_widget', { name: 'x' });
  assert.equal(
    client.calls[0].endpoint,
    `/api/now/table/x_snc_myapp_widget?sysparm_exclude_reference_link=true&sysparm_transaction_scope=${sysId}`,
  );
});

test('createRecord omits sysparm_transaction_scope for a global table even with a SchemaService wired', async () => {
  const created = { sys_id: 'b'.repeat(32) };
  const client = makeStubClient({ post: { result: created } });
  const schemaService = { async resolveTableScope() { return { scoped: false }; } };
  const svc = new TableService(makeManager(client), schemaService);

  await svc.createRecord('incident', { short_description: 'x' });
  assert.equal(client.calls[0].endpoint, '/api/now/table/incident?sysparm_exclude_reference_link=true');
});

test('createRecord still writes, without sysparm_transaction_scope, when scope resolution fails', async () => {
  const created = { sys_id: 'b'.repeat(32) };
  const client = makeStubClient({ post: { result: created } });
  const schemaService = {
    async resolveTableScope() {
      throw new Error('no read access to sys_db_object');
    },
  };
  const svc = new TableService(makeManager(client), schemaService);

  const rec = await svc.createRecord('incident', { short_description: 'x' });
  assert.deepEqual(rec, created);
  assert.equal(client.calls[0].endpoint, '/api/now/table/incident?sysparm_exclude_reference_link=true');
});

test('updateRecord adds sysparm_transaction_scope when the table belongs to a scoped app', async () => {
  const updated = { sys_id: 'c'.repeat(32) };
  const client = makeStubClient({ patch: { result: updated } });
  const sysId = 'b2'.repeat(16);
  const schemaService = {
    async resolveTableScope() {
      return { scoped: true, scopeSysId: sysId, scopeName: 'x_snc_myapp' };
    },
  };
  const svc = new TableService(makeManager(client), schemaService);

  await svc.updateRecord('x_snc_myapp_widget', 'c'.repeat(32), { name: 'y' });
  assert.equal(
    client.calls[0].endpoint,
    `/api/now/table/x_snc_myapp_widget/${'c'.repeat(32)}?sysparm_exclude_reference_link=true&sysparm_transaction_scope=${sysId}`,
  );
});

test('updateRecord uses PATCH for partial and PUT for full updates', async () => {
  const updated = { sys_id: 'c'.repeat(32) };
  const client = makeStubClient({ patch: { result: updated }, put: { result: updated } });
  const svc = new TableService(makeManager(client));

  await svc.updateRecord('incident', 'c'.repeat(32), { state: '2' }, false);
  assert.equal(client.calls[0].method, 'patch');
  assert.equal(
    client.calls[0].endpoint,
    `/api/now/table/incident/${'c'.repeat(32)}?sysparm_exclude_reference_link=true`,
  );

  await svc.updateRecord('incident', 'c'.repeat(32), { state: '3' }, true);
  assert.equal(client.calls[1].method, 'put');
});

test('deleteRecord issues a DELETE to the by-id endpoint', async () => {
  const client = makeStubClient({ delete: {} });
  const svc = new TableService(makeManager(client));

  const res = await svc.deleteRecord('incident', 'd'.repeat(32));
  assert.equal(res.success, true);
  assert.equal(client.calls[0].method, 'delete');
  assert.equal(client.calls[0].endpoint, `/api/now/table/incident/${'d'.repeat(32)}`);
});

test('write methods are blocked when the instance is read-only', async () => {
  const client = makeStubClient();
  const svc = new TableService(makeManager(client, { readOnly: true }));

  await assert.rejects(() => svc.createRecord('incident', { x: 1 }), /read-only/i);
  await assert.rejects(
    () => svc.updateRecord('incident', 'e'.repeat(32), { x: 1 }),
    /read-only/i
  );
  await assert.rejects(() => svc.deleteRecord('incident', 'e'.repeat(32)), /read-only/i);
  // No API calls should have been made.
  assert.equal(client.calls.length, 0);
});

test('createRecord rejects empty data before any API call', async () => {
  const client = makeStubClient();
  const svc = new TableService(makeManager(client));
  await assert.rejects(() => svc.createRecord('incident', {}), /empty/i);
  assert.equal(client.calls.length, 0);
});
