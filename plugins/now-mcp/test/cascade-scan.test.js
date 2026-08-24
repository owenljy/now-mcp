import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDeleteRecordsTool } from '../build/tools/delete-records-tool.js';
import { WriteRecordsOutputSchema } from '../build/schemas/output-schemas.js';
import { deleteEffect, isConsequential, scanCascadeImpact } from '../build/utils/cascade-scan.js';

const SYS_ID = '2156240b97f24b903e08f9ece053af1e';
const SYS_ID_2 = '0000048fdb97a450cf42004dd396195a';

const dict = (name, element, reference_cascade_rule = '') => ({
  name,
  element,
  reference_cascade_rule,
});

/**
 * `counts` maps "table.field" to referencing rows; absent means zero, and the
 * string 'throw' makes that probe fail so the unreadable path is exercised.
 */
function fakeTableService({ dictRows = [], counts = {}, onDictQuery } = {}) {
  const probes = [];
  return {
    probes,
    async queryRecords(table, options) {
      assert.equal(table, 'sys_dictionary');
      onDictQuery?.(options);
      return dictRows;
    },
    async aggregateRecords(table, options) {
      const field = options.query.split('IN')[0];
      probes.push(`${table}.${field}`);
      const n = counts[`${table}.${field}`];
      if (n === 'throw') throw new Error(`no read access to ${table}`);
      return { stats: { count: String(n ?? 0) } };
    },
  };
}

const fakeSchemaService = (chain) => ({
  async tableChain() {
    return chain;
  },
});

test('deleteEffect maps the rules that act, and drops the inert ones', () => {
  assert.equal(deleteEffect('restrict'), 'blocks_delete');
  assert.equal(deleteEffect('restrain'), 'blocks_delete');
  assert.equal(deleteEffect('delete'), 'deletes_referencing_rows');
  assert.equal(deleteEffect('cascade'), 'deletes_referencing_rows');
  assert.equal(deleteEffect('delete_no_workflow'), 'deletes_referencing_rows');
  assert.equal(deleteEffect('clear'), 'clears_field');
  // Inert: the reference is left dangling. Not a destructive consequence, and
  // excluding these is what keeps the scan affordable.
  assert.equal(deleteEffect('none'), undefined);
  assert.equal(deleteEffect(''), undefined);
  assert.equal(deleteEffect(undefined), undefined);
});

test('inert columns are never probed', async () => {
  const svc = fakeTableService({
    dictRows: [dict('noise_a', 'ref'), dict('noise_b', 'ref', 'none'), dict('real', 'ref', 'delete')],
    counts: { 'real.ref': 2 },
  });
  const impact = await scanCascadeImpact(svc, fakeSchemaService(['x']), {
    tableName: 'x',
    sysIds: [SYS_ID],
  });
  assert.deepEqual(svc.probes, ['real.ref']);
  assert.equal(impact.candidates, 1);
  assert.equal(impact.cascadeRowCount, 2);
});

test('ancestor tables are in scope, since a parent column holds the child sys_id', () => {
  let query;
  const svc = fakeTableService({
    dictRows: [dict('task_sla', 'task', 'delete')],
    counts: { 'task_sla.task': 4 },
    onDictQuery: (o) => {
      query = o.query;
    },
  });
  return scanCascadeImpact(svc, fakeSchemaService(['incident', 'task']), {
    tableName: 'incident',
    sysIds: [SYS_ID],
  }).then((impact) => {
    assert.match(query, /referenceINincident,task/);
    assert.deepEqual(impact.chain, ['incident', 'task']);
    assert.equal(impact.cascadeRowCount, 4);
  });
});

test('one count per column covers every sys_id, so cost does not scale with the batch', async () => {
  const svc = fakeTableService({
    dictRows: [dict('child', 'parent', 'delete')],
    counts: { 'child.parent': 7 },
  });
  let seen;
  const inner = svc.aggregateRecords;
  svc.aggregateRecords = (t, o) => {
    seen = o.query;
    return inner(t, o);
  };
  await scanCascadeImpact(svc, fakeSchemaService(['p']), {
    tableName: 'p',
    sysIds: [SYS_ID, SYS_ID_2],
  });
  assert.equal(seen, `parentIN${SYS_ID},${SYS_ID_2}`);
  assert.equal(svc.probes.length, 1);
});

test('a restrict rule with rows behind it is consequential; with none, it is not', async () => {
  const withRows = await scanCascadeImpact(
    fakeTableService({ dictRows: [dict('c', 'p', 'restrict')], counts: { 'c.p': 1 } }),
    fakeSchemaService(['p']),
    { tableName: 'p', sysIds: [SYS_ID] },
  );
  assert.deepEqual(withRows.blockedBy, ['c.p']);
  assert.equal(isConsequential(withRows), true);

  const without = await scanCascadeImpact(
    fakeTableService({ dictRows: [dict('c', 'p', 'restrict')] }),
    fakeSchemaService(['p']),
    { tableName: 'p', sysIds: [SYS_ID] },
  );
  assert.deepEqual(without.blockedBy, []);
  assert.equal(isConsequential(without), false);
});

test('a clear-only impact is reported but is NOT grounds to refuse the delete', async () => {
  const impact = await scanCascadeImpact(
    fakeTableService({ dictRows: [dict('c', 'p', 'clear')], counts: { 'c.p': 3 } }),
    fakeSchemaService(['p']),
    { tableName: 'p', sysIds: [SYS_ID] },
  );
  assert.equal(impact.clearedRowCount, 3);
  // The row survives with a nulled reference — nothing is destroyed.
  assert.equal(isConsequential(impact), false);
});

test('a failed dictionary read fails OPEN rather than becoming an unclearable gate', async () => {
  const broken = {
    async queryRecords() {
      throw new Error('no access to sys_dictionary');
    },
    async aggregateRecords() {
      throw new Error('unreachable');
    },
  };
  const impact = await scanCascadeImpact(broken, fakeSchemaService(['p']), {
    tableName: 'p',
    sysIds: [SYS_ID],
  });
  assert.equal(impact.scanned, false);
  assert.match(impact.skipReason, /sys_dictionary/);
  assert.equal(isConsequential(impact), false);
});

test('one unreadable table degrades that entry, not the scan', async () => {
  const impact = await scanCascadeImpact(
    fakeTableService({
      dictRows: [dict('locked', 'p', 'delete'), dict('open', 'p', 'delete')],
      counts: { 'locked.p': 'throw', 'open.p': 2 },
    }),
    fakeSchemaService(['p']),
    { tableName: 'p', sysIds: [SYS_ID] },
  );
  assert.equal(impact.scanned, true);
  assert.deepEqual(impact.unreadable, ['locked.p']);
  assert.equal(impact.cascadeRowCount, 2);
});

// --- delete-tool integration ------------------------------------------------

const fakeBatchService = () => {
  const calls = [];
  return {
    calls,
    async batchDelete(table, sysIds) {
      calls.push({ table, sysIds });
      return {
        success: true,
        successCount: sysIds.length,
        failureCount: 0,
        results: sysIds.map((sysId) => ({ sysId, success: true })),
      };
    },
  };
};

test('a cascading delete is refused with the breakdown, and nothing is deleted', async () => {
  const batch = fakeBatchService();
  const tool = createDeleteRecordsTool(
    batch,
    fakeTableService({
      dictRows: [dict('task_sla', 'task', 'delete')],
      counts: { 'task_sla.task': 4 },
    }),
    fakeSchemaService(['incident', 'task']),
  );
  const res = await tool.handler({ tableName: 'incident', sysIds: [SYS_ID] });
  const out = res.structuredContent;

  assert.equal(res.isError, true);
  assert.deepEqual(batch.calls, [], 'nothing was deleted');
  assert.equal(out.deleted, false);
  assert.equal(out.reason, 'cascade_impact');
  assert.equal(out.cascadeImpact.cascadeRowCount, 4);
  assert.deepEqual(out.cascadeImpact.columns, [
    'table',
    'field',
    'count',
    'cascadeRule',
    'onDelete',
  ]);
  assert.match(out.hints.join(' '), /acknowledgeCascade:true/);
  // Zeros here mean "nothing attempted", which `deleted:false` disambiguates
  // from "attempted and all failed".
  assert.deepEqual(out.summary, { total: 1, successCount: 0, failureCount: 0 });
});

test('the refusal payload validates against the declared output schema', async () => {
  const tool = createDeleteRecordsTool(
    fakeBatchService(),
    fakeTableService({ dictRows: [dict('c', 'p', 'delete')], counts: { 'c.p': 1 } }),
    fakeSchemaService(['p']),
  );
  const out = (await tool.handler({ tableName: 'p', sysIds: [SYS_ID] })).structuredContent;
  // A structuredContent that does not parse would be rejected by the MCP SDK
  // at call time rather than here.
  assert.doesNotThrow(() => WriteRecordsOutputSchema.parse(out));
});

test('acknowledgeCascade deletes AND skips the scan entirely', async () => {
  const batch = fakeBatchService();
  const svc = fakeTableService({
    dictRows: [dict('task_sla', 'task', 'delete')],
    counts: { 'task_sla.task': 4 },
  });
  const tool = createDeleteRecordsTool(batch, svc, fakeSchemaService(['incident', 'task']));
  const res = await tool.handler({
    tableName: 'incident',
    sysIds: [SYS_ID],
    acknowledgeCascade: true,
  });

  assert.equal(res.isError, undefined);
  assert.deepEqual(batch.calls, [{ table: 'incident', sysIds: [SYS_ID] }]);
  assert.deepEqual(svc.probes, [], 'acknowledging is also the escape hatch from the requests');
});

test('a delete with no cascade impact proceeds untouched', async () => {
  const batch = fakeBatchService();
  const tool = createDeleteRecordsTool(
    batch,
    fakeTableService({ dictRows: [dict('c', 'p', 'delete')] }),
    fakeSchemaService(['p']),
  );
  const res = await tool.handler({ tableName: 'p', sysIds: [SYS_ID] });
  assert.equal(res.isError, undefined);
  assert.deepEqual(batch.calls, [{ table: 'p', sysIds: [SYS_ID] }]);
});

test('an unscannable instance still lets the delete through', async () => {
  const batch = fakeBatchService();
  const tool = createDeleteRecordsTool(
    batch,
    {
      async queryRecords() {
        throw new Error('no access to sys_dictionary');
      },
      async aggregateRecords() {
        throw new Error('unreachable');
      },
    },
    fakeSchemaService(['p']),
  );
  const res = await tool.handler({ tableName: 'p', sysIds: [SYS_ID] });
  assert.equal(res.isError, undefined);
  assert.deepEqual(batch.calls, [{ table: 'p', sysIds: [SYS_ID] }]);
});
