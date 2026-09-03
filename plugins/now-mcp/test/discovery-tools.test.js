import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFindFieldsTool } from '../build/tools/find-fields-tool.js';
import { createListTablesTool } from '../build/tools/list-tables-tool.js';

function tablesService({ tables, totalMatching = null }) {
  return {
    resolveInstance: () => ({ name: 'dev', url: 'https://dev.service-now.com' }),
    async listTables() {
      return { tables, totalMatching };
    },
  };
}

function fieldsService({ fields, totalMatching = null }) {
  return {
    resolveInstance: () => ({ name: 'dev', url: 'https://dev.service-now.com' }),
    async findFields() {
      return { fields, keywords: ['x'], totalMatching };
    },
  };
}

const columnValue = (res, column, rowIndex = 0) => {
  const { columns, rows } = res.structuredContent;
  return rows[rowIndex][columns.indexOf(column)];
};

test('sn_list_tables returns rows in relevance order, not the instance name order', async () => {
  const tool = createListTablesTool(
    tablesService({
      tables: [
        { name: 'alm_hardware_incident', label: 'Hardware Incident' },
        { name: 'incident_metric', label: 'Incident Metric' },
        { name: 'incident', label: 'Incident' },
      ],
    }),
  );

  const res = await tool.handler({ filter: 'incident', limit: 100, offset: 0 });

  assert.equal(columnValue(res, 'name'), 'incident');
  assert.equal(res.structuredContent.ranked, true);
});

test('sn_list_tables reports totalMatching and hasMore so a slice is not read as the whole set', async () => {
  const tool = createListTablesTool(
    tablesService({
      tables: [{ name: 'incident', label: 'Incident' }],
      totalMatching: 417,
    }),
  );

  const res = await tool.handler({ filter: 'inc', limit: 1, offset: 0 });

  assert.equal(res.structuredContent.pagination.totalMatching, 417);
  assert.equal(res.structuredContent.pagination.hasMore, true);
  assert.match(res.structuredContent.hints.join(' '), /417 tables match/);
  assert.match(res.structuredContent.hints.join(' '), /ranked by relevance WITHIN this page/i);
});

test('a complete result set does not claim there is more', async () => {
  const tool = createListTablesTool(
    tablesService({ tables: [{ name: 'incident', label: 'Incident' }], totalMatching: 1 }),
  );

  const res = await tool.handler({ filter: 'incident', limit: 100, offset: 0 });

  assert.equal(res.structuredContent.pagination.hasMore, false);
  assert.equal(res.structuredContent.hints, undefined);
});

test('hasMore falls back to the page-size heuristic when the header is absent', async () => {
  // Without X-Total-Count the honest answer is "possibly more", not "complete".
  const tool = createListTablesTool(
    tablesService({ tables: [{ name: 'a' }, { name: 'b' }], totalMatching: null }),
  );

  const res = await tool.handler({ filter: 'x', limit: 2, offset: 0 });

  assert.equal(res.structuredContent.pagination.hasMore, true);
  assert.equal(res.structuredContent.pagination.totalMatching, undefined);
});

test('offset is echoed so a caller can compute the next page', async () => {
  const tool = createListTablesTool(
    tablesService({ tables: [{ name: 'incident' }], totalMatching: 500 }),
  );

  const res = await tool.handler({ filter: 'inc', limit: 50, offset: 100 });

  assert.equal(res.structuredContent.pagination.offset, 100);
  assert.equal(res.structuredContent.pagination.limit, 50);
});

test('sn_find_fields ranks on the column name and keeps the row shape unchanged', async () => {
  const tool = createFindFieldsTool(
    fieldsService({
      fields: [
        { table: 'x_junk', element: 'escalation_junk', label: 'Junk', type: 'string', matched: 'escalation' },
        { table: 'task', element: 'escalation', label: 'Escalation', type: 'integer', matched: 'escalation' },
      ],
    }),
  );

  const res = await tool.handler({ concept: ['escalation'], limit: 25, offset: 0 });

  assert.equal(columnValue(res, 'element'), 'escalation');
  assert.equal(columnValue(res, 'table'), 'task');
  // The synthetic key used for ranking must not leak into the wire shape.
  assert.ok(!res.structuredContent.columns.includes('name'));
});

test('sn_find_fields says how much of the match set it is showing', async () => {
  const tool = createFindFieldsTool(
    fieldsService({
      fields: [{ table: 'task', element: 'escalation', label: 'Escalation', type: 'integer' }],
      totalMatching: 380,
    }),
  );

  const res = await tool.handler({ concept: ['escalat'], limit: 1, offset: 0 });

  assert.match(res.structuredContent.hints.join(' '), /380 fields match/);
});

test('a broad field result reports where the matches cluster', async () => {
  // "31 of 40 hits are on sys_user" identifies the table faster than reading 40 rows.
  const fields = [
    ...Array.from({ length: 8 }, (_, i) => ({
      table: 'sys_user',
      element: `pref_${i}`,
      label: `Pref ${i}`,
      type: 'string',
    })),
    ...Array.from({ length: 4 }, (_, i) => ({
      table: 'incident',
      element: `p_${i}`,
      label: `P ${i}`,
      type: 'string',
    })),
  ];
  const tool = createFindFieldsTool(fieldsService({ fields }));

  const res = await tool.handler({ concept: ['pref'], limit: 25, offset: 0 });

  assert.deepEqual(res.structuredContent.tableDistribution, [
    { table: 'sys_user', fields: 8 },
    { table: 'incident', fields: 4 },
  ]);
});

test('a small or single-table result skips the distribution rather than paying for it', async () => {
  const small = createFindFieldsTool(
    fieldsService({ fields: [{ table: 'task', element: 'escalation', label: 'E', type: 'integer' }] }),
  );
  const res = await small.handler({ concept: ['escalat'], limit: 25, offset: 0 });
  assert.equal(res.structuredContent.tableDistribution, undefined);

  const oneTable = createFindFieldsTool(
    fieldsService({
      fields: Array.from({ length: 12 }, (_, i) => ({
        table: 'sys_user',
        element: `f_${i}`,
        label: `F ${i}`,
        type: 'string',
      })),
    }),
  );
  const res2 = await oneTable.handler({ concept: ['f'], limit: 25, offset: 0 });
  assert.equal(res2.structuredContent.tableDistribution, undefined, 'one table is not a distribution');
});

test('a zero-result concept search still explains that the keywords missed', async () => {
  const tool = createFindFieldsTool(fieldsService({ fields: [], totalMatching: 0 }));
  const res = await tool.handler({ concept: ['zzz'], limit: 25, offset: 0 });
  assert.match(res.structuredContent.hints.join(' '), /Try different vocabulary/);
  assert.equal(res.structuredContent.pagination.hasMore, false);
});

// ── sn_connection_status compaction ──────────────────────────────────────────

function statusManager(names) {
  return {
    getConnectionStatuses() {
      return names.map((name, i) => ({
        name,
        url: `https://${name}.service-now.com`,
        authType: 'basic',
        state: 'closed',
        failureScore: 0,
        authFailureScore: 0,
        retryAfterMs: 0,
        isDefault: i === 0,
        backgroundScriptTransport: {
          transport: 'sys_trigger',
          configuredPath: null,
          usesCompanionEndpoint: false,
          fallbackOnFailure: false,
          privilegeModel: 'scheduled_job_context',
          diagnostic: 'A long paragraph about the sys_trigger transport.',
        },
      }));
    },
  };
}

test('a multi-instance status says the shared transport diagnostic once', async () => {
  const { createConnectionStatusTool } = await import('../build/tools/connection-status-tool.js');
  const tool = createConnectionStatusTool(statusManager(['dev', 'test', 'stage']));

  const res = await tool.handler({});
  const body = res.structuredContent;

  assert.equal(body.instances.length, 3);
  assert.equal(
    body.transportDiagnostics.sys_trigger,
    'A long paragraph about the sys_trigger transport.',
  );
  for (const inst of body.instances) {
    assert.equal(inst.backgroundScriptTransport.diagnostic, undefined);
    // Per-instance facts must survive the hoist.
    assert.equal(inst.backgroundScriptTransport.transport, 'sys_trigger');
    assert.equal(inst.state, 'closed');
    assert.ok(inst.name);
  }
});

test('a single-instance status keeps the diagnostic inline — nothing to deduplicate', async () => {
  const { createConnectionStatusTool } = await import('../build/tools/connection-status-tool.js');
  const tool = createConnectionStatusTool(statusManager(['dev']));

  const body = (await tool.handler({})).structuredContent;

  assert.match(body.instances[0].backgroundScriptTransport.diagnostic, /sys_trigger transport/);
  assert.equal(body.transportDiagnostics, undefined);
});

test('a slow scheduler is named in the connection-status summary', async () => {
  const { createConnectionStatusTool } = await import('../build/tools/connection-status-tool.js');
  const { recordTransportSample, resetTransportHealth } = await import(
    '../build/utils/transport-health.js'
  );
  resetTransportHealth();
  recordTransportSample('dev', {
    totalDurationMs: 31_500,
    observedSchedulerWaitMs: 31_000,
    pollCount: 12,
    outcome: 'completed',
  });

  const tool = createConnectionStatusTool(statusManager(['dev']));
  const res = await tool.handler({});

  assert.match(res.content.map((c) => c.text).join(' '), /slow sys_trigger scheduler/);
  assert.match(res.structuredContent.instances[0].transportHealth.note, /scriptApiPath/);
  resetTransportHealth();
});
