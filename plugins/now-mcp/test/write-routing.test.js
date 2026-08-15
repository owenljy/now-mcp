import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupWriteRoute, checkWriteRouting, resolveWriteRoute } from '../build/utils/write-routing.js';

/**
 * Stand-in for SchemaService's inheritance walk. `ci` lists the tables that
 * genuinely extend cmdb_ci; anything else does not, which is how a real instance
 * distinguishes cmdb_ci_server from cmdb_ci_outage.
 */
function makeAncestry(ci, { unresolvable = false } = {}) {
  return {
    async extendsFrom(table, ancestor) {
      if (unresolvable) return null;
      return ancestor === 'cmdb_ci' && ci.includes(table);
    },
    // The tools receive one SchemaService and use it for field validation too;
    // null means "schema unavailable, skip", isolating these tests to routing.
    async validateFields() {
      return null;
    },
  };
}

const CI_CLASSES = ['cmdb_ci_server', 'cmdb_ci_linux_server'];
const ancestry = makeAncestry(CI_CLASSES);
import { createCreateRecordsTool } from '../build/tools/create-records-tool.js';

test('every CI class routes through the identification engine', async () => {
  for (const table of ['cmdb_ci', 'cmdb_ci_server', 'cmdb_ci_linux_server', 'cmdb_rel_ci']) {
    const route = await resolveWriteRoute(table, ancestry);
    assert.ok(route, `${table} should be routed`);
    assert.match(route.engine, /Identification and Reconciliation/);
    assert.match(route.useInstead, /identifyreconcile/);
  }
});

test('catalog request tables route through the order API', async () => {
  for (const table of ['sc_request', 'sc_req_item', 'sc_task']) {
    const route = await resolveWriteRoute(table, ancestry);
    assert.ok(route, `${table} should be routed`);
    assert.match(route.useInstead, /servicecatalog/);
  }
});

test('ordinary data tables are not routed', async () => {
  for (const table of ['incident', 'sys_user', 'change_request', 'problem', 'task']) {
    assert.equal(await resolveWriteRoute(table, ancestry), null);
  }
});

test('a cmdb_ci_-prefixed table that is not a CI class is NOT routed', async () => {
  // Verified on a live instance: cmdb_ci_outage, cmdb_ci_model_entry,
  // cmdb_ci_end_of_life_ledger and the cmdb_ci_m2m_* join tables all carry the
  // prefix without extending cmdb_ci. Inserting an outage is ordinary work, so a
  // name-prefix rule would have blocked correct writes.
  for (const table of ['cmdb_ci_outage', 'cmdb_ci_model_entry', 'cmdb_ci_m2m_custom_application_ci']) {
    assert.ok(lookupWriteRoute(table), `${table} is a name-level candidate`);
    assert.equal(await resolveWriteRoute(table, ancestry), null, `${table} must not be routed`);
  }
  assert.equal(await resolveWriteRoute('sc_cat_item', ancestry), null);
});

test('routing fails open when the hierarchy cannot be resolved', async () => {
  // No dictionary access is unrelated to the caller's insert; turning it into a
  // hard block would make a degraded permission look like a rejected write.
  assert.equal(await resolveWriteRoute('cmdb_ci_server', makeAncestry([], { unresolvable: true })), null);
  assert.equal(await resolveWriteRoute('cmdb_ci_server', undefined), null);
  // The exact-name cases need no lookup, so they still route.
  assert.ok(await resolveWriteRoute('cmdb_ci', undefined));
  assert.ok(await resolveWriteRoute('cmdb_rel_ci', undefined));
  assert.ok(await resolveWriteRoute('sc_req_item', undefined));
});

test('acknowledging the risk lets the insert through', async () => {
  assert.ok(await checkWriteRouting('cmdb_ci_server', false, ancestry));
  assert.equal(await checkWriteRouting('cmdb_ci_server', true, ancestry), null);
});

test('the block message names the consequence and the replacement call', async () => {
  const message = await checkWriteRouting('cmdb_ci_server', false, ancestry);
  assert.match(message, /duplicate/i);
  assert.match(message, /identifyreconcile/);
  assert.match(message, /acknowledgeRoutingRisk/);
  // The whole point is that ServiceNow would NOT have complained.
  assert.match(message, /201/);
});

test('sn_create_records blocks a CI insert before any HTTP call', async () => {
  let called = false;
  const tableService = {
    async createRecord() {
      called = true;
      return { sys_id: 'a'.repeat(32) };
    },
  };
  const res = await createCreateRecordsTool(tableService, undefined, ancestry).handler({
    tableName: 'cmdb_ci_server',
    records: [{ name: 'web01' }],
  });

  assert.equal(res.isError, true);
  assert.equal(called, false, 'must not reach the instance');
  assert.match(res.content[0].text, /identifyreconcile/);
});

test('sn_create_records proceeds once the risk is acknowledged', async () => {
  let called = false;
  const tableService = {
    async createRecord() {
      called = true;
      return { sys_id: 'a'.repeat(32), name: 'web01' };
    },
  };
  const res = await createCreateRecordsTool(tableService, undefined, ancestry).handler({
    tableName: 'cmdb_ci_server',
    records: [{ name: 'web01' }],
    acknowledgeRoutingRisk: true,
  });

  assert.equal(res.isError, undefined);
  assert.equal(called, true);
});

test('a multi-record insert is blocked on a routed table too', async () => {
  let called = false;
  const batchService = {
    async batchCreate() {
      called = true;
      return { success: true, successCount: 1, failureCount: 0, results: [] };
    },
  };
  const res = await createCreateRecordsTool(undefined, batchService, ancestry).handler({
    tableName: 'sc_req_item',
    records: [{ cat_item: 'x' }, { cat_item: 'y' }],
  });

  assert.equal(res.isError, true);
  assert.equal(called, false);
  assert.match(res.content[0].text, /servicecatalog/);
});

test('updates and deletes are unaffected — only inserts are routed', async () => {
  // Correcting an existing CI or closing an existing request item is ordinary
  // data maintenance; blocking it would break legitimate work.
  const { createUpdateRecordsTool } = await import('../build/tools/update-records-tool.js');
  let called = false;
  const tableService = {
    async updateRecord() {
      called = true;
      return { sys_id: 'a'.repeat(32), name: 'web01' };
    },
    async getRecord() {
      return { sys_id: 'a'.repeat(32), name: 'web01' };
    },
  };
  const res = await createUpdateRecordsTool(tableService, undefined, ancestry).handler({
    tableName: 'cmdb_ci_server',
    updates: [{ sysId: 'a'.repeat(32), fields: { name: 'web01' } }],
    verify: false,
  });

  assert.equal(called, true);
  assert.equal(res.isError, undefined);
});
