import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueryRecordsTool } from '../build/tools/query-records-tool.js';
import { createAggregateRecordsTool } from '../build/tools/aggregate-records-tool.js';

const INCIDENT_FIELDS = [
  'sys_id',
  'number',
  'priority',
  'state',
  'active',
  'short_description',
  'comments',
  'work_notes',
  'caller_id',
  'assignment_group',
  'reassignment_count',
  'sys_updated_on',
];

/**
 * Stub SchemaService. `validateFields` mirrors the real one closely enough to
 * exercise the tools: unknown names come back with a nearest-match suggestion.
 */
function makeSchema({ journal = ['comments', 'work_notes'], unavailable = false } = {}) {
  return {
    async validateFields(_table, names) {
      if (unavailable) return null;
      const unknown = names
        .filter((n) => !INCIDENT_FIELDS.includes(n.split('.')[0]))
        .map((n) => ({
          field: n,
          suggestion: INCIDENT_FIELDS.find((f) => f.startsWith(n.slice(0, 4))),
        }));
      return { unknown };
    },
    async journalFieldsAmong(_table, names) {
      return names.filter((n) => journal.includes(n));
    },
    async checkWebServiceAccess() {
      return null;
    },
  };
}

function makeTableService(records = [{ sys_id: 'a'.repeat(32), number: 'INC1' }]) {
  const state = { calls: 0, lastOptions: null };
  return {
    state,
    async queryRecordsWithMeta(_table, options) {
      state.calls++;
      state.lastOptions = options;
      return { records, totalCount: records.length };
    },
    async aggregateRecords(_table, options) {
      state.calls++;
      state.lastOptions = options;
      return { stats: { count: '27' } };
    },
  };
}

test('a typo in the encoded query is blocked instead of silently widening the read', async () => {
  // Verified on a live instance: priorityy=1 returns all 67 incidents rather
  // than the 27 that priority=1 matches, with HTTP 200 and no error. Nothing
  // downstream can catch it — the zero-result hints only fire on an EMPTY
  // result, and this failure produces too MANY rows.
  const tableService = makeTableService();
  const tool = createQueryRecordsTool(tableService, makeSchema());

  const res = await tool.handler({ tableName: 'incident', query: 'priorityy=1', limit: 100, offset: 0 });

  assert.equal(res.isError, true);
  assert.equal(tableService.state.calls, 0, 'must not reach the instance');
  assert.match(res.content[0].text, /priorityy/);
  assert.match(res.content[0].text, /Did you mean "priority"/);
  assert.match(res.content[0].text, /silently ignored/);
});

test('a typo in the fields list is blocked too', async () => {
  const tableService = makeTableService();
  const tool = createQueryRecordsTool(tableService, makeSchema());

  const res = await tool.handler({
    tableName: 'incident',
    fields: ['number', 'shrot_description'],
    limit: 100,
    offset: 0,
  });

  assert.equal(res.isError, true);
  assert.equal(tableService.state.calls, 0);
});

test('skipFieldValidation runs the query as written', async () => {
  const tableService = makeTableService();
  const tool = createQueryRecordsTool(tableService, makeSchema());

  const res = await tool.handler({
    tableName: 'incident',
    query: 'priorityy=1',
    skipFieldValidation: true,
    limit: 5,
    offset: 0,
  });

  assert.equal(res.isError, undefined);
  assert.equal(tableService.state.calls, 1);
});

test('a valid query passes through untouched', async () => {
  const tableService = makeTableService();
  const tool = createQueryRecordsTool(tableService, makeSchema());

  const res = await tool.handler({
    tableName: 'incident',
    query: 'priority=1^ORDERBYDESCsys_updated_on',
    fields: ['number', 'caller_id.name'],
    limit: 100,
    offset: 0,
  });

  assert.equal(res.isError, undefined);
  assert.equal(tableService.state.calls, 1);
});

test('an unreadable schema fails open rather than blocking the read', async () => {
  const tableService = makeTableService();
  const tool = createQueryRecordsTool(tableService, makeSchema({ unavailable: true }));

  const res = await tool.handler({ tableName: 'incident', query: 'priorityy=1', limit: 5, offset: 0 });

  assert.equal(res.isError, undefined);
  assert.equal(tableService.state.calls, 1);
});

test('aggregate blocks a typo that would return the whole table count', async () => {
  const tableService = makeTableService();
  const tool = createAggregateRecordsTool(tableService, makeSchema());

  const res = await tool.handler({ tableName: 'incident', query: 'priorityy=1', count: true });

  assert.equal(res.isError, true);
  assert.equal(tableService.state.calls, 0);
});

test('aggregate blocks a typo in groupBy', async () => {
  const tableService = makeTableService();
  const tool = createAggregateRecordsTool(tableService, makeSchema());

  const res = await tool.handler({
    tableName: 'incident',
    groupBy: ['assignment_grp'],
    count: true,
  });

  assert.equal(res.isError, true);
  assert.equal(tableService.state.calls, 0);
});

test('aggregate accepts an aggregate-naming having/orderBy pair (calibrated guard, not field validation)', async () => {
  const tableService = makeTableService();
  const tool = createAggregateRecordsTool(tableService, makeSchema());

  const res = await tool.handler({
    tableName: 'incident',
    groupBy: ['assignment_group'],
    count: true,
    having: 'count>5',
    orderBy: 'DESCcount',
  });

  assert.equal(res.isError, undefined);
  assert.equal(tableService.state.calls, 1);
});

test('reading a journal field without displayValue warns that an empty value is not "no comments"', async () => {
  // Verified on a live instance: comments comes back as {"display_value": "<nine
  // entries>", "value": ""}. With the default displayValue:false the caller sees
  // "" and would conclude the record has no comments.
  const tableService = makeTableService();
  const tool = createQueryRecordsTool(tableService, makeSchema());

  const res = await tool.handler({
    tableName: 'incident',
    fields: ['number', 'comments', 'work_notes'],
    limit: 100,
    offset: 0,
  });

  assert.equal(res.isError, undefined);
  const warnings = res.structuredContent.warnings;
  assert.ok(Array.isArray(warnings) && warnings.length === 1, 'a warning is attached');
  assert.match(warnings[0], /comments, work_notes/);
  assert.match(warnings[0], /does NOT mean/);
  assert.match(warnings[0], /displayValue:"all"/);
  // Also surfaced as its own text block: a caller reading only the summary would
  // otherwise act on the empty value.
  assert.ok(res.content.some((c) => /journal field/.test(c.text)));
});

test('no journal warning when displayValue is already set', async () => {
  const tableService = makeTableService();
  const tool = createQueryRecordsTool(tableService, makeSchema());

  const res = await tool.handler({
    tableName: 'incident',
    fields: ['number', 'comments'],
    displayValue: 'all',
    limit: 100,
    offset: 0,
  });

  assert.equal(res.structuredContent.warnings, undefined);
});

test('no journal warning for ordinary fields', async () => {
  const tableService = makeTableService();
  const tool = createQueryRecordsTool(tableService, makeSchema());

  const res = await tool.handler({
    tableName: 'incident',
    fields: ['number', 'state'],
    limit: 100,
    offset: 0,
  });

  assert.equal(res.structuredContent.warnings, undefined);
});
