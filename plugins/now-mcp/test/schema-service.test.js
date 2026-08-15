import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the schema disk cache at a throwaway temp dir BEFORE importing the
// service, so tests never read/write the real ~/.now-mcp cache.
const CACHE_DIR = mkdtempSync(join(tmpdir(), 'sn-schema-cache-'));
process.env.SERVICENOW_SCHEMA_CACHE_DIR = CACHE_DIR;

const { SchemaService } = await import('../build/services/schema-service.js');

after(() => {
  rmSync(CACHE_DIR, { recursive: true, force: true });
});

/**
 * Stub client that counts sys_dictionary fetches and returns canned dictionary
 * + table-object rows.
 */
function makeStubClient() {
  const state = { dictionaryCalls: 0, calls: [] };
  return {
    state,
    async get(endpoint, params) {
      state.calls.push({ endpoint, params });
      if (endpoint === '/api/now/table/sys_dictionary') {
        state.dictionaryCalls++;
        return {
          result: [
            {
              element: 'short_description',
              column_label: 'Short description',
              internal_type: 'string',
              mandatory: 'true',
              read_only: 'false',
              max_length: '160',
              reference: '',
            },
            {
              element: 'caller_id',
              column_label: 'Caller',
              internal_type: 'reference',
              mandatory: 'false',
              read_only: 'false',
              max_length: '32',
              reference: 'sys_user',
            },
          ],
        };
      }
      if (endpoint === '/api/now/table/sys_db_object') {
        return {
          result: [{ name: 'incident', label: 'Incident', 'super_class.name': 'task' }],
        };
      }
      return { result: [] };
    },
  };
}

function makeManager(client, { name = 'dev', url = 'https://dev.service-now.com' } = {}) {
  return {
    getClient: () => client,
    getConfig: () => ({ name, url, readOnly: false }),
    resolveInstance: (instance) => {
      const resolvedName = instance || name;
      return { name: resolvedName, config: { name: resolvedName, url, readOnly: false }, client };
    },
  };
}

test('getTableSchema parses sys_dictionary rows into field metadata', async () => {
  const client = makeStubClient();
  const svc = new SchemaService(makeManager(client));

  const meta = await svc.getTableSchema('incident', false, 'parsetest');

  assert.equal(meta.name, 'incident');
  assert.equal(meta.label, 'Incident');
  assert.equal(meta.extends, 'task');
  assert.equal(meta.fields.length, 2);

  const byName = Object.fromEntries(meta.fields.map((f) => [f.name, f]));
  assert.equal(byName.short_description.label, 'Short description');
  assert.equal(byName.short_description.type, 'string');
  assert.equal(byName.short_description.mandatory, true);
  assert.equal(byName.short_description.readOnly, false);
  assert.equal(byName.short_description.maxLength, 160);
  assert.equal(byName.short_description.reference, undefined);

  assert.equal(byName.caller_id.mandatory, false);
  assert.equal(byName.caller_id.reference, 'sys_user');
});

test('getTableSchema marks a nonexistent table exists:false', async () => {
  // Empty dictionary AND empty sys_db_object = table absent/unreadable.
  const emptyClient = {
    state: { calls: [] },
    async get() {
      return { result: [] };
    },
  };
  const svc = new SchemaService(makeManager(emptyClient));

  const meta = await svc.getTableSchema('nope_not_a_table', false, 'nf');
  assert.equal(meta.exists, false);
  assert.equal(meta.fields.length, 0);
});

test('getTableSchema marks a real table exists:true', async () => {
  const client = makeStubClient();
  const svc = new SchemaService(makeManager(client));
  const meta = await svc.getTableSchema('incident', false, 'existstest');
  assert.equal(meta.exists, true);
});

test('getTableSchema serves the second call from cache (client hit once)', async () => {
  const client = makeStubClient();
  const svc = new SchemaService(makeManager(client));

  await svc.getTableSchema('incident', false, 'cachetest');
  const before = client.state.dictionaryCalls;
  assert.equal(before, 1);

  await svc.getTableSchema('incident', false, 'cachetest');
  assert.equal(client.state.dictionaryCalls, 1, 'second call should be served from cache');
});

test('validateFields flags unknown fields using the parsed schema', async () => {
  const client = makeStubClient();
  const svc = new SchemaService(makeManager(client));

  const result = await svc.validateFields(
    'incident',
    ['short_description', 'made_up_field'],
    'validatetest'
  );
  assert.ok(result);
  assert.equal(result.unknown.length, 1);
  assert.equal(result.unknown[0].field, 'made_up_field');
});

test('omitted instance follows switched default without reusing the previous instance cache', async () => {
  function clientFor(label, field) {
    const state = { dictionaryCalls: 0 };
    return {
      state,
      async get(endpoint) {
        if (endpoint === '/api/now/table/sys_dictionary') {
          state.dictionaryCalls++;
          return { result: [{ element: field, column_label: field, internal_type: 'string', mandatory: 'false', read_only: 'false', max_length: '40', reference: '' }] };
        }
        return { result: [{ name: 'incident', label, 'super_class.name': 'task' }] };
      },
    };
  }

  const clients = { a: clientFor('Instance A', 'field_a'), b: clientFor('Instance B', 'field_b') };
  const configs = {
    a: { name: 'a', url: 'https://a.service-now.com' },
    b: { name: 'b', url: 'https://b.service-now.com' },
  };
  let defaultName = 'a';
  const manager = {
    resolveInstance(instance) {
      const name = instance || defaultName;
      return { name, config: configs[name], client: clients[name] };
    },
  };
  const svc = new SchemaService(manager);

  const fromA = await svc.getTableSchema('incident');
  defaultName = 'b';
  const fromB = await svc.getTableSchema('incident');

  assert.equal(fromA.label, 'Instance A');
  assert.equal(fromA.fields[0].name, 'field_a');
  assert.equal(fromB.label, 'Instance B');
  assert.equal(fromB.fields[0].name, 'field_b');
  assert.equal(clients.a.state.dictionaryCalls, 1);
  assert.equal(clients.b.state.dictionaryCalls, 1, 'new default must query its own client');
});

test('disk cache identity includes URL when the same profile name is repointed', async () => {
  const first = makeStubClient();
  const svc1 = new SchemaService(makeManager(first, { name: 'shared', url: 'https://old.service-now.com' }));
  await svc1.getTableSchema('incident');

  const second = makeStubClient();
  const svc2 = new SchemaService(makeManager(second, { name: 'shared', url: 'https://new.service-now.com' }));
  await svc2.getTableSchema('incident');

  assert.equal(second.state.dictionaryCalls, 1, 'repointed profile must not consume old disk cache');
});

function makeWsAccessClient(wsAccessValue) {
  const state = { calls: 0 };
  return {
    state,
    async get(endpoint, params) {
      state.calls++;
      assert.equal(endpoint, '/api/now/table/sys_db_object');
      assert.equal(params.sysparm_fields, 'name,ws_access');
      if (wsAccessValue === undefined) return { result: [] };
      return { result: [{ name: 'sn_grc_indicator', ws_access: wsAccessValue }] };
    },
  };
}

test('checkWebServiceAccess reports wsAccess:false when ws_access is "false"', async () => {
  const client = makeWsAccessClient('false');
  const svc = new SchemaService(makeManager(client));

  const result = await svc.checkWebServiceAccess('sn_grc_indicator', 'wsdisabled');
  assert.deepEqual(result, { exists: true, wsAccess: false });
});

test('checkWebServiceAccess reports wsAccess:true when ws_access is "true"', async () => {
  const client = makeWsAccessClient('true');
  const svc = new SchemaService(makeManager(client));

  const result = await svc.checkWebServiceAccess('incident', 'wsenabled');
  assert.deepEqual(result, { exists: true, wsAccess: true });
});

test('checkWebServiceAccess reports exists:false for a table with no sys_db_object row', async () => {
  const client = makeWsAccessClient(undefined);
  const svc = new SchemaService(makeManager(client));

  const result = await svc.checkWebServiceAccess('nope_not_a_table', 'wsnotfound');
  assert.deepEqual(result, { exists: false, wsAccess: false });
});

test('checkWebServiceAccess returns null (not a throw) when the probe itself fails', async () => {
  const client = {
    async get() {
      throw new Error('network error');
    },
  };
  const svc = new SchemaService(makeManager(client));

  const result = await svc.checkWebServiceAccess('incident', 'wsfailure');
  assert.equal(result, null);
});

test('checkWebServiceAccess serves the second call from cache (client hit once)', async () => {
  const client = makeWsAccessClient('false');
  const svc = new SchemaService(makeManager(client));

  await svc.checkWebServiceAccess('sn_grc_indicator', 'wscache');
  assert.equal(client.state.calls, 1);

  await svc.checkWebServiceAccess('sn_grc_indicator', 'wscache');
  assert.equal(client.state.calls, 1, 'second call should be served from cache');
});

function makeTableScopeClient(row) {
  const state = { calls: 0 };
  return {
    state,
    async get(endpoint, params) {
      state.calls++;
      assert.equal(endpoint, '/api/now/table/sys_db_object');
      assert.equal(params.sysparm_fields, 'sys_scope,sys_scope.scope');
      assert.equal(params.sysparm_exclude_reference_link, true);
      return { result: row ? [row] : [] };
    },
  };
}

test('resolveTableScope reports scoped:false for a global table (no sys_scope value)', async () => {
  const client = makeTableScopeClient({ sys_scope: '', 'sys_scope.scope': '' });
  const svc = new SchemaService(makeManager(client));

  const result = await svc.resolveTableScope('incident', 'scopeglobal');
  assert.deepEqual(result, { scoped: false });
});

test('resolveTableScope reports scoped:false when sys_scope resolves to the literal "global" app', async () => {
  const client = makeTableScopeClient({ sys_scope: 'f'.repeat(32), 'sys_scope.scope': 'global' });
  const svc = new SchemaService(makeManager(client));

  const result = await svc.resolveTableScope('sys_user', 'scopeglobalapp');
  assert.deepEqual(result, { scoped: false });
});

test('resolveTableScope reports scoped:true with the sys_id and api_name for a scoped table', async () => {
  const sysId = 'e'.repeat(32);
  const client = makeTableScopeClient({ sys_scope: sysId, 'sys_scope.scope': 'x_snc_myapp' });
  const svc = new SchemaService(makeManager(client));

  const result = await svc.resolveTableScope('x_snc_myapp_widget', 'scopedtable');
  assert.deepEqual(result, { scoped: true, scopeSysId: sysId, scopeName: 'x_snc_myapp' });
});

test('resolveTableScope reports scoped:false (not a throw) when the probe itself fails', async () => {
  const client = {
    async get() {
      throw new Error('network error');
    },
  };
  const svc = new SchemaService(makeManager(client));

  const result = await svc.resolveTableScope('incident', 'scopefailure');
  assert.deepEqual(result, { scoped: false });
});

test('resolveTableScope serves the second call from cache (client hit once)', async () => {
  const sysId = 'd'.repeat(32);
  const client = makeTableScopeClient({ sys_scope: sysId, 'sys_scope.scope': 'x_snc_myapp' });
  const svc = new SchemaService(makeManager(client));

  await svc.resolveTableScope('x_snc_myapp_widget', 'scopecache');
  assert.equal(client.state.calls, 1);

  await svc.resolveTableScope('x_snc_myapp_widget', 'scopecache');
  assert.equal(client.state.calls, 1, 'second call should be served from cache');
});

/**
 * Stub returning dictionary rows in the OBJECT form: internal_type and reference
 * are reference columns on sys_dictionary, so without
 * sysparm_exclude_reference_link ServiceNow answers with {value, link}. Verified
 * on a live instance — task.comments came back as
 * {"link":".../sys_glide_object?name=journal_input","value":"journal_input"},
 * which made every field's advertised `type` an object carrying an API URL and
 * silently broke type comparisons.
 */
function makeObjectFormClient() {
  const link = (name) => ({
    value: name,
    link: `https://dev.service-now.com/api/now/table/sys_glide_object?name=${name}`,
  });
  return {
    async get(endpoint) {
      if (endpoint === '/api/now/table/sys_dictionary') {
        return {
          result: [
            {
              element: 'comments',
              column_label: 'Additional comments',
              internal_type: link('journal_input'),
              mandatory: 'false',
              read_only: 'false',
              max_length: '4000',
              reference: '',
            },
            {
              element: 'caller_id',
              column_label: 'Caller',
              internal_type: link('reference'),
              mandatory: 'false',
              read_only: 'false',
              max_length: '32',
              reference: link('sys_user'),
            },
          ],
        };
      }
      if (endpoint === '/api/now/table/sys_db_object') {
        return { result: [{ name: 'incident', label: 'Incident', 'super_class.name': '' }] };
      }
      return { result: [] };
    },
  };
}

test('the dictionary query excludes reference links so field types are plain names', async () => {
  const client = makeStubClient();
  const svc = new SchemaService(makeManager(client, { name: 'reflink1' }));
  await svc.getTableSchema('incident');

  const dictCall = client.state.calls.find((c) => c.endpoint === '/api/now/table/sys_dictionary');
  assert.equal(dictCall.params.sysparm_exclude_reference_link, true);
});

test('a field type arriving as a {value, link} object is normalized to its name', async () => {
  const svc = new SchemaService(makeManager(makeObjectFormClient(), { name: 'reflink2' }));
  const schema = await svc.getTableSchema('incident');

  const comments = schema.fields.find((f) => f.name === 'comments');
  assert.equal(comments.type, 'journal_input', 'type must be a plain string, not an object');
  const caller = schema.fields.find((f) => f.name === 'caller_id');
  assert.equal(caller.type, 'reference');
  assert.equal(caller.reference, 'sys_user');
});

test('journal columns are detected through the inheritance chain', async () => {
  const svc = new SchemaService(makeManager(makeObjectFormClient(), { name: 'reflink3' }));

  // The object form must not defeat detection — this is what made the live
  // journal warning silently never fire.
  assert.deepEqual(
    await svc.journalFieldsAmong('incident', ['caller_id', 'comments']),
    ['comments'],
  );
});

test('extendsFrom walks the parent chain and reports a non-descendant as false', async () => {
  const chain = { incident: 'task', task: '', cmdb_ci_server: 'cmdb_ci', cmdb_ci: '', cmdb_ci_outage: 'task' };
  const client = {
    async get(endpoint, params) {
      if (endpoint === '/api/now/table/sys_dictionary') return { result: [] };
      const name = String(params.sysparm_query).replace('name=', '');
      if (!(name in chain)) return { result: [] };
      return { result: [{ name, label: name, 'super_class.name': chain[name] }] };
    },
  };
  const svc = new SchemaService(makeManager(client, { name: 'ancestry' }));

  assert.equal(await svc.extendsFrom('cmdb_ci_server', 'cmdb_ci'), true);
  assert.equal(await svc.extendsFrom('cmdb_ci', 'cmdb_ci'), true);
  // Carries the cmdb_ci_ prefix but extends task — must not be treated as a CI.
  assert.equal(await svc.extendsFrom('cmdb_ci_outage', 'cmdb_ci'), false);
  assert.equal(await svc.extendsFrom('incident', 'cmdb_ci'), false);
  // Unknown table => unresolvable, so callers can fail open.
  assert.equal(await svc.extendsFrom('no_such_table', 'cmdb_ci'), null);
});
