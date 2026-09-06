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
              display: 'true',
            },
            {
              element: 'caller_id',
              column_label: 'Caller',
              internal_type: 'reference',
              mandatory: 'false',
              read_only: 'false',
              max_length: '32',
              reference: 'sys_user',
              display: 'false',
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

function makeManager(
  client,
  { name = 'dev', url = 'https://dev.service-now.com', auth, revision = 0 } = {},
) {
  return {
    getClient: () => client,
    getConfig: () => ({ name, url, readOnly: false, auth }),
    resolveInstance: (instance) => {
      const resolvedName = instance || name;
      return {
        name: resolvedName,
        config: { name: resolvedName, url, readOnly: false, auth },
        client,
      };
    },
    getConfigRevision: () => revision,
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

test('the display column is parsed off sys_dictionary and requested in the projection', async () => {
  const client = makeStubClient();
  const svc = new SchemaService(makeManager(client));

  const meta = await svc.getTableSchema('incident', false, 'displaytest');

  const byName = Object.fromEntries(meta.fields.map((f) => [f.name, f]));
  assert.equal(byName.short_description.display, true);
  // Absent, not false — a per-field `false` on every non-display column would
  // be pure payload.
  assert.equal(byName.caller_id.display, undefined);

  const dict = client.state.calls.find((c) => c.endpoint === '/api/now/table/sys_dictionary');
  assert.match(dict.params.sysparm_fields, /(^|,)display(,|$)/);
});

test('includeExtended actually returns inherited fields, not just the local dictionary', async () => {
  // The regression: includeExtended used to only drop the `collection` filter
  // on a `name=<table>` query. sys_dictionary is keyed by the table a column is
  // DEFINED on, so that query can never return `number` for incident — the flag
  // silently did nothing.
  const state = { dictionaryQueries: [] };
  const client = {
    async get(endpoint, params) {
      if (endpoint === '/api/now/table/sys_dictionary') {
        state.dictionaryQueries.push(params.sysparm_query);
        const row = (element, display = 'false') => ({
          element,
          column_label: element,
          internal_type: 'string',
          mandatory: 'false',
          read_only: 'false',
          max_length: '40',
          reference: '',
          display,
        });
        return params.sysparm_query.startsWith('name=incident')
          ? { result: [row('short_description')] }
          : { result: [row('number', 'true'), row('short_description')] };
      }
      if (endpoint === '/api/now/table/sys_db_object') {
        return params.sysparm_query === 'name=incident'
          ? { result: [{ name: 'incident', label: 'Incident', 'super_class.name': 'task' }] }
          : { result: [{ name: 'task', label: 'Task', 'super_class.name': '' }] };
      }
      return { result: [] };
    },
  };
  const svc = new SchemaService(makeManager(client));

  const local = await svc.getTableSchema('incident', false, 'inherit');
  assert.deepEqual(local.fields.map((f) => f.name), ['short_description']);

  const extended = await svc.getTableSchema('incident', true, 'inherit');
  assert.deepEqual(extended.fields.map((f) => f.name), ['short_description', 'number']);
  // Identity stays the child's — only the field list widens.
  assert.equal(extended.name, 'incident');
  assert.equal(extended.extends, 'task');
  // A child's override of an inherited column wins; the parent's duplicate
  // short_description is not appended twice.
  assert.equal(extended.fields.filter((f) => f.name === 'short_description').length, 1);

  // Every dictionary read excludes the collection row, which carries an empty
  // element and would otherwise surface as a nameless field.
  assert.ok(state.dictionaryQueries.every((q) => q.includes('internal_type!=collection')));
});

test('includeExtended on a root table costs no extra dictionary read', async () => {
  // No parent to walk, so the chain walk must short-circuit rather than
  // re-collecting the same table.
  const state = { dictionaryCalls: 0 };
  const client = {
    async get(endpoint) {
      if (endpoint === '/api/now/table/sys_dictionary') {
        state.dictionaryCalls++;
        return { result: [] };
      }
      return { result: [{ name: 'task', label: 'Task', 'super_class.name': '' }] };
    },
  };
  const svc = new SchemaService(makeManager(client));
  await svc.getTableSchema('task', true, 'rootext');
  assert.equal(state.dictionaryCalls, 1);
});

test('resolveDisplayField finds a flag defined on a PARENT table', async () => {
  // The real shape: incident's display column is `number`, flagged on task.
  // Reading only incident's own dictionary (includeExtended:false) finds
  // nothing, which is why the resolver walks the chain.
  const client = {
    async get(endpoint, params) {
      if (endpoint === '/api/now/table/sys_dictionary') {
        return params.sysparm_query.startsWith('name=incident')
          ? {
              result: [
                {
                  element: 'short_description',
                  column_label: 'Short description',
                  internal_type: 'string',
                  mandatory: 'false',
                  read_only: 'false',
                  max_length: '160',
                  reference: '',
                  display: 'false',
                },
              ],
            }
          : {
              result: [
                {
                  element: 'number',
                  column_label: 'Number',
                  internal_type: 'string',
                  mandatory: 'false',
                  read_only: 'false',
                  max_length: '40',
                  reference: '',
                  display: 'true',
                },
              ],
            };
      }
      if (endpoint === '/api/now/table/sys_db_object') {
        return params.sysparm_query === 'name=incident'
          ? { result: [{ name: 'incident', label: 'Incident', 'super_class.name': 'task' }] }
          : { result: [{ name: 'task', label: 'Task', 'super_class.name': '' }] };
      }
      return { result: [] };
    },
  };
  const svc = new SchemaService(makeManager(client));

  assert.deepEqual(await svc.resolveDisplayField('incident', 'chainwalk'), {
    field: 'number',
    source: 'dictionary',
  });
});

test('resolveDisplayField falls back to a name column and labels it as inferred', async () => {
  const client = {
    async get(endpoint) {
      if (endpoint === '/api/now/table/sys_dictionary') {
        return {
          result: [
            {
              element: 'name',
              column_label: 'Name',
              internal_type: 'string',
              mandatory: 'false',
              read_only: 'false',
              max_length: '80',
              reference: '',
              display: 'false',
            },
          ],
        };
      }
      if (endpoint === '/api/now/table/sys_db_object') {
        return { result: [{ name: 'x', label: 'X', 'super_class.name': '' }] };
      }
      return { result: [] };
    },
  };
  const svc = new SchemaService(makeManager(client));
  assert.deepEqual(await svc.resolveDisplayField('x', 'namefallback'), {
    field: 'name',
    source: 'name_convention',
  });
});

test('resolveDisplayField returns undefined rather than nominating an arbitrary column', async () => {
  const client = {
    async get(endpoint) {
      if (endpoint === '/api/now/table/sys_dictionary') {
        return {
          result: [
            {
              element: 'label',
              column_label: 'Label',
              internal_type: 'string',
              mandatory: 'false',
              read_only: 'false',
              max_length: '255',
              reference: '',
              display: 'false',
            },
          ],
        };
      }
      if (endpoint === '/api/now/table/sys_db_object') {
        return { result: [{ name: 'y', label: 'Y', 'super_class.name': '' }] };
      }
      return { result: [] };
    },
  };
  const svc = new SchemaService(makeManager(client));
  assert.equal(await svc.resolveDisplayField('y', 'nodisplay'), undefined);
});

test('fieldMetaAmong returns type + length for known fields and omits the rest', async () => {
  const client = makeStubClient();
  const svc = new SchemaService(makeManager(client));

  const meta = await svc.fieldMetaAmong(
    'incident',
    ['short_description', 'caller_id', 'caller_id.department.name', 'nope'],
    'metatest',
  );

  assert.deepEqual(meta.short_description, { type: 'string', maxLength: 160 });
  assert.deepEqual(meta.caller_id, { type: 'reference', maxLength: 32 });
  // A dot-walked name resolves on another table; an unknown name resolves
  // nowhere. Both are absent rather than present-with-a-guess.
  assert.ok(!('caller_id.department.name' in meta));
  assert.ok(!('nope' in meta));
});

test('fieldMetaAmong returns {} instead of throwing when the schema will not load', async () => {
  const broken = {
    async get() {
      throw new Error('no dictionary access');
    },
  };
  const svc = new SchemaService(makeManager(broken));
  assert.deepEqual(await svc.fieldMetaAmong('incident', ['priority'], 'brokentest'), {});
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

test('disk cache identity includes the auth principal but never needs the secret', async () => {
  const first = makeStubClient();
  const shared = { name: 'principal-cache', url: 'https://same.service-now.com' };
  const svc1 = new SchemaService(
    makeManager(first, {
      ...shared,
      auth: { type: 'basic', username: 'first.user', password: 'secret-one' },
    }),
  );
  await svc1.getTableSchema('incident');

  const second = makeStubClient();
  const svc2 = new SchemaService(
    makeManager(second, {
      ...shared,
      auth: { type: 'basic', username: 'second.user', password: 'secret-two' },
    }),
  );
  await svc2.getTableSchema('incident');

  assert.equal(second.state.dictionaryCalls, 1, 'a different principal must not consume old schema data');
  assert.doesNotMatch(svc2.getCacheStats().keys.join(' '), /secret-one|secret-two/);
});

test('a config revision invalidates in-memory and disk schema cache entries', async () => {
  const client = makeStubClient();
  let revision = 0;
  const config = {
    name: 'revision-cache',
    url: 'https://revision.service-now.com',
    auth: { type: 'basic', username: 'api.user', password: 'secret' },
  };
  const manager = {
    resolveInstance() {
      return { name: config.name, config, client };
    },
    getConfigRevision() {
      return revision;
    },
  };
  const svc = new SchemaService(manager);

  await svc.getTableSchema('incident');
  revision += 1;
  await svc.getTableSchema('incident');

  assert.equal(client.state.dictionaryCalls, 2);
});

function makeWsAccessClient(wsAccessValue, extraRow = {}) {
  const state = { calls: 0 };
  return {
    state,
    async get(endpoint, params) {
      state.calls++;
      assert.equal(endpoint, '/api/now/table/sys_db_object');
      // One request resolves the whole access profile: both gating flags plus
      // the owning scope. Fetching them separately is what allowed a 403 hint
      // to recommend a transport without knowing whether it would silently
      // return zero rows.
      assert.equal(params.sysparm_fields, 'name,ws_access,read_access,sys_scope,sys_scope.scope');
      if (wsAccessValue === undefined) return { result: [] };
      return {
        result: [{ name: 'sn_grc_indicator', ws_access: wsAccessValue, ...extraRow }],
      };
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

test('checkWebServiceAccess collapses an unknown ws_access to false for its boolean contract', async () => {
  // The wrapper's callers only ask "is REST blocked?" and cannot express
  // unknown. Callers that must tell unknown from off use getTableAccessProfile.
  const client = makeWsAccessClient('', { read_access: 'true' });
  const svc = new SchemaService(makeManager(client));

  assert.deepEqual(await svc.checkWebServiceAccess('incident', 'wsunknown'), {
    exists: true,
    wsAccess: false,
  });
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

// ── getTableAccessProfile ────────────────────────────────────────────────────

test('getTableAccessProfile resolves both gating flags and the owning scope in one read', async () => {
  const client = makeWsAccessClient('false', {
    read_access: 'false',
    sys_scope: 'a1b2c3',
    'sys_scope.scope': 'sn_ai_observe',
  });
  const svc = new SchemaService(makeManager(client));

  const profile = await svc.getTableAccessProfile('sn_grc_indicator', 'profile_full');
  assert.deepEqual(profile, {
    exists: true,
    wsAccess: false,
    readAccess: false,
    owningScope: { sysId: 'a1b2c3', name: 'sn_ai_observe' },
  });
  assert.equal(client.state.calls, 1, 'the whole profile must cost one request, not three');
});

test('getTableAccessProfile reports an unreadable flag as undefined, never as false', async () => {
  // The distinction is load-bearing: "read_access is off" justifies calling a
  // zero-row script result inconclusive, whereas "we could not read the flag"
  // justifies nothing. Collapsing the two would invent evidence.
  const client = makeWsAccessClient('true', { read_access: '' });
  const svc = new SchemaService(makeManager(client));

  const profile = await svc.getTableAccessProfile('incident', 'profile_unknown');
  assert.equal(profile.wsAccess, true);
  assert.equal(profile.readAccess, undefined, 'an empty flag is unknown, not false');
});

test('getTableAccessProfile normalizes the boolean shapes ServiceNow actually returns', async () => {
  for (const [raw, expected] of [
    ['true', true],
    ['false', false],
    [true, true],
    [false, false],
    ['1', true],
    ['0', false],
    ['', undefined],
    [null, undefined],
  ]) {
    const client = makeWsAccessClient('true', { read_access: raw });
    const svc = new SchemaService(makeManager(client));
    const profile = await svc.getTableAccessProfile('incident', `norm_${String(raw)}`);
    assert.equal(profile.readAccess, expected, `read_access ${JSON.stringify(raw)}`);
  }
});

test('getTableAccessProfile reports exists:false for a table with no sys_db_object row', async () => {
  const client = makeWsAccessClient(undefined);
  const svc = new SchemaService(makeManager(client));

  const profile = await svc.getTableAccessProfile('nope_not_a_table', 'profile_missing');
  assert.deepEqual(profile, { exists: false });
});

test('getTableAccessProfile returns null (not a throw) when the probe itself fails', async () => {
  const svc = new SchemaService(
    makeManager({
      async get() {
        throw new Error('network error');
      },
    }),
  );

  assert.equal(await svc.getTableAccessProfile('incident', 'profile_failure'), null);
});

test('getTableAccessProfile omits owningScope when the scope cannot be resolved', async () => {
  const client = makeWsAccessClient('true', { read_access: 'true', sys_scope: '', 'sys_scope.scope': '' });
  const svc = new SchemaService(makeManager(client));

  const profile = await svc.getTableAccessProfile('incident', 'profile_noscope');
  assert.equal(profile.owningScope, undefined);
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

function makeListTablesClient(rows, totalCount) {
  const state = { calls: 0, params: null };
  return {
    state,
    // listTables reads X-Total-Count off the same response, so the stub must
    // supply headers as well as the body.
    async getWithHeaders(endpoint, params) {
      state.calls++;
      state.params = params;
      assert.equal(endpoint, '/api/now/table/sys_db_object');
      return {
        data: { result: rows },
        headers: totalCount === undefined ? {} : { 'x-total-count': String(totalCount) },
      };
    },
  };
}

test('listTables requests sys_scope.scope and reports it for a scoped/custom table', async () => {
  const client = makeListTablesClient([
    { name: 'x_acme_widget', label: 'Widget', 'super_class.name': '', 'sys_scope.scope': 'x_acme_myapp' },
  ]);
  const svc = new SchemaService(makeManager(client));

  const { tables } = await svc.listTables('x_acme_widget', 100, 'listscoped');
  assert.equal(client.state.params.sysparm_fields, 'name,label,super_class.name,sys_scope.scope');
  assert.equal(tables.length, 1);
  assert.equal(tables[0].name, 'x_acme_widget');
  assert.equal(tables[0].scope, 'x_acme_myapp');
});

test('listTables omits scope for a global/OOB table (including the literal "global" app)', async () => {
  const client = makeListTablesClient([
    { name: 'incident', label: 'Incident', 'super_class.name': 'task', 'sys_scope.scope': 'global' },
  ]);
  const svc = new SchemaService(makeManager(client));

  const { tables } = await svc.listTables('incident', 100, 'listglobal');
  assert.equal(tables[0].extends, 'task');
  assert.equal(tables[0].scope, undefined);
});

test('listTables reports the total match count and fetches a stable candidate window', async () => {
  const client = makeListTablesClient(
    [{ name: 'incident', label: 'Incident', 'super_class.name': 'task', 'sys_scope.scope': 'global' }],
    417,
  );
  const svc = new SchemaService(makeManager(client));

	const { totalMatching } = await svc.listTables('inc', 50, 'listtotal', undefined, 100);
	assert.equal(totalMatching, 417);
	assert.equal(client.state.params.sysparm_offset, 0);
	assert.equal(client.state.params.sysparm_limit, 10_000);
	assert.match(client.state.params.sysparm_query, /\^ORDERBYname\^ORDERBYsys_id$/);
	assert.equal(client.state.params.sysparm_order_by, undefined);
});

test('findFields uses deterministic remote ordering and owning-table scopes', async () => {
  const calls=[];
  const client={async getWithHeaders(endpoint,params){
    calls.push({endpoint,params});
    const result=endpoint.endsWith('sys_dictionary')
      ? [{name:'task',element:'escalation',column_label:'Escalation',internal_type:'integer'},
         {name:'x_acme_history',element:'escalation',column_label:'Escalation',internal_type:'integer'}]
      : [{name:'task',label:'Task','sys_scope.scope':'global'},{name:'x_acme_history',label:'History','sys_scope.scope':'x_acme'}];
    return {data:{result},headers:{'x-total-count':'2'}};
  }};
  const svc=new SchemaService(makeManager(client,{name:'field-owner-order'}));
  const result=await svc.findFields(['escalat']);
  assert.match(calls[0].params.sysparm_query,/\^ORDERBYname\^ORDERBYelement\^ORDERBYsys_id$/);
  assert.deepEqual(result.fields.map(f=>f.scope),['global','x_acme']);
  await svc.findFields(['escalat']);assert.equal(calls.length,2,'both field candidates and owner metadata are cached');
});

test('listTables reports totalMatching as null when the instance omits the header', async () => {
  // Null, not 0: "the instance did not tell us" must not read as "no matches".
  const client = makeListTablesClient([{ name: 'incident', label: 'Incident' }]);
  const svc = new SchemaService(makeManager(client));

  const { totalMatching } = await svc.listTables('inc', 50, 'listnototal');
  assert.equal(totalMatching, null);
});

test('listTables reuses the stable candidate set across ranked pages', async () => {
  const client = makeListTablesClient([{ name: 'incident', label: 'Incident' }], 200);
  const svc = new SchemaService(makeManager(client));

  await svc.listTables('inc', 50, 'listpaged', undefined, 0);
  assert.equal(client.state.calls, 1);
  await svc.listTables('inc', 50, 'listpaged', undefined, 0);
  assert.equal(client.state.calls, 1, 'same page should be cached');
	await svc.listTables('inc', 50, 'listpaged', undefined, 50);
	assert.equal(client.state.calls, 1, 'ranking pages must share one stable candidate set');
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
