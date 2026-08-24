import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueryRecordsTool } from '../build/tools/query-records-tool.js';
import { AccessDeniedError } from '../build/types/errors.js';

/** A TableService whose queryRecordsWithMeta always throws the given error. */
function makeThrowingTableService(error) {
  return {
    async queryRecordsWithMeta() {
      throw error;
    },
  };
}

/** A SchemaService stub that records calls and returns a canned checkWebServiceAccess result. */
function makeStubSchemaService(result) {
  const calls = [];
  return {
    calls,
    async checkWebServiceAccess(tableName, instance) {
      calls.push({ tableName, instance });
      return result;
    },
  };
}

/**
 * A SchemaService stub for the zero-result path: field validation is skipped by
 * the caller, so only fieldMetaAmong matters. Records the arguments so the test
 * can assert the tool actually consults the dictionary rather than guessing.
 */
function makeStubSchemaServiceWithFieldMeta(fieldMeta) {
  const calls = [];
  return {
    calls,
    async journalFieldsAmong() {
      return [];
    },
    async fieldMetaAmong(tableName, fieldNames, instance) {
      calls.push({ tableName, fieldNames, instance });
      return fieldMeta;
    },
  };
}

function makeEmptyTableService() {
  return {
    async queryRecordsWithMeta() {
      return { records: [], totalCount: 0 };
    },
  };
}

test('a zero-result query consults the dictionary and withholds groupBy on free text', async () => {
  const schemaService = makeStubSchemaServiceWithFieldMeta({
    user_message: { type: 'string', maxLength: 8000 },
  });
  const tool = createQueryRecordsTool(makeEmptyTableService(), schemaService);
  const res = await tool.handler({
    tableName: 'sn_aia_message',
    query: 'user_messageLIKEasset security score',
    fields: ['sys_id'],
    skipFieldValidation: true,
  });

  assert.deepEqual(schemaService.calls, [
    { tableName: 'sn_aia_message', fieldNames: ['user_message'], instance: undefined },
  ]);
  const hints = res.structuredContent.hints.join(' ');
  assert.ok(!hints.includes('groupBy'), 'no groupBy suggestion on an 8000-char column');
  assert.match(hints, /No records matched/);
});

test('a zero-result query still suggests groupBy on a bounded column', async () => {
  const schemaService = makeStubSchemaServiceWithFieldMeta({
    category: { type: 'string', maxLength: 40 },
  });
  const tool = createQueryRecordsTool(makeEmptyTableService(), schemaService);
  const res = await tool.handler({
    tableName: 'incident',
    query: 'category=nosuchvalue',
    fields: ['sys_id'],
    skipFieldValidation: true,
  });
  assert.match(res.structuredContent.hints.join(' '), /groupBy:\["category"\]/);
});

const REAL_403 = () =>
  new AccessDeniedError('User Not Authorized', {
    error: { message: 'User Not Authorized', detail: 'Failed API level ACL Validation' },
  });

test('403 with ws_access disabled explains the table-level block', async () => {
  const tableService = makeThrowingTableService(REAL_403());
  const schemaService = makeStubSchemaService({ exists: true, wsAccess: false });
  const tool = createQueryRecordsTool(tableService, schemaService);

  const result = await tool.handler({ tableName: 'sn_grc_indicator', limit: 5 });

  assert.equal(result.isError, true);
  assert.equal(schemaService.calls.length, 1);
  assert.equal(schemaService.calls[0].tableName, 'sn_grc_indicator');

  const text = result.content.map((c) => c.text).join(' ');
  assert.match(text, /ws_access/);
  assert.match(text, /web service/i);
  assert.doesNotMatch(text, /likely an acl.*lack the required role/i);
});

test('403 with ws_access enabled keeps the ACL/role hint', async () => {
  const tableService = makeThrowingTableService(REAL_403());
  const schemaService = makeStubSchemaService({ exists: true, wsAccess: true });
  const tool = createQueryRecordsTool(tableService, schemaService);

  const result = await tool.handler({ tableName: 'incident', limit: 5 });

  const text = result.content.map((c) => c.text).join(' ');
  assert.match(text, /ACL/);
  assert.match(text, /Web-service access.*enabled/i);
});

test('403 falls back to the generic ACL hint when the ws_access probe itself fails', async () => {
  const tableService = makeThrowingTableService(REAL_403());
  const schemaService = makeStubSchemaService(null);
  const tool = createQueryRecordsTool(tableService, schemaService);

  const result = await tool.handler({ tableName: 'incident', limit: 5 });

  assert.equal(schemaService.calls.length, 1);
  const text = result.content.map((c) => c.text).join(' ');
  assert.match(text, /Likely an ACL/);
});

test('client-side SERVICENOW_BLOCKED_TABLES denial never triggers the ws_access probe', async () => {
  const blockedError = new AccessDeniedError('Access to table "sn_grc_indicator" is blocked', {
    table: 'sn_grc_indicator',
    operationType: 'table-access',
    list: 'SERVICENOW_BLOCKED_TABLES',
  });
  const tableService = makeThrowingTableService(blockedError);
  const schemaService = makeStubSchemaService({ exists: true, wsAccess: false });
  const tool = createQueryRecordsTool(tableService, schemaService);

  await tool.handler({ tableName: 'sn_grc_indicator', limit: 5 });

  assert.equal(schemaService.calls.length, 0, 'the probe should be skipped for client-side blocks');
});

test('a non-403 error never triggers the ws_access probe', async () => {
  const notFound = new AccessDeniedError('placeholder');
  notFound.statusCode = 404;
  const tableService = makeThrowingTableService(notFound);
  const schemaService = makeStubSchemaService({ exists: true, wsAccess: false });
  const tool = createQueryRecordsTool(tableService, schemaService);

  await tool.handler({ tableName: 'incident', limit: 5 });

  assert.equal(schemaService.calls.length, 0);
});
