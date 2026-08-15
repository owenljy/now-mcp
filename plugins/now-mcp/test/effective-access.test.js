import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEffectiveAccessQuery,
  GraphqlService,
  GraphqlUnavailableError,
} from '../build/services/graphql-service.js';
import { preflightEffectiveAccess } from '../build/utils/access-preflight.js';
import { createGetSecurityInfoTool } from '../build/tools/get-security-info-tool.js';
import { createUpdateRecordsTool } from '../build/tools/update-records-tool.js';
import { createCreateRecordsTool } from '../build/tools/create-records-tool.js';

const SYS_ID = 'a'.repeat(32);

function makeService(post) {
  return new GraphqlService({ getClient: () => ({ post }) });
}

/** Envelope shaped the way the live instance answers (verified by probing). */
function envelope(tableName, result) {
  return { data: { GlideRecord_Query: { [tableName]: result } } };
}

test('the table-level probe needs neither arguments nor a row', () => {
  const q = buildEffectiveAccessQuery('incident');

  assert.equal(
    q,
    '{ GlideRecord_Query { incident { _table_metadata { label plural canRead canWrite canCreate canDelete auditWanted } } } }',
  );
  // No _results selection: asking for one would need a readable row the caller
  // did not ask for.
  assert.ok(!q.includes('_results'));
});

test('field verdicts add a limit-1 page, because they live on a row', () => {
  const q = buildEffectiveAccessQuery('incident', { fields: ['priority', 'sys_created_by'] });

  assert.match(q, /pagination: \{limit: 1, offset: 0\}/);
  assert.match(q, /_results \{ priority \{ label internalType isMandatory canRead canWrite \}/);
  assert.match(q, /sys_created_by \{ label internalType isMandatory canRead canWrite \} \}/);
});

test('recordQuery pins the row the field verdicts describe', () => {
  const q = buildEffectiveAccessQuery('incident', {
    fields: ['priority'],
    recordQuery: `sys_id=${SYS_ID}`,
  });

  assert.match(q, new RegExp(`queryConditions: "sys_id=${SYS_ID}"`));
});

test('identifiers are rejected rather than escaped', () => {
  assert.throws(
    () => buildEffectiveAccessQuery('incident', { fields: ['priority } evil'] }),
    /Invalid field name/,
  );
  assert.throws(() => buildEffectiveAccessQuery('incident) { evil'), /Invalid table name/);
});

test('parses the verdict the platform actually returns for a restricted table', async () => {
  // Verified live: the API admin user gets read-only on sys_security_acl, because
  // ACLs with admin_overrides=false apply to admin too.
  const svc = makeService(async () =>
    envelope('sys_security_acl', {
      _table_metadata: {
        label: 'Access Control',
        plural: 'Access Controls',
        canRead: true,
        canWrite: false,
        canCreate: false,
        canDelete: false,
        auditWanted: true,
      },
    }),
  );

  const access = await svc.fetchEffectiveAccess('sys_security_acl');

  assert.deepEqual(access.table, {
    label: 'Access Control',
    plural: 'Access Controls',
    canRead: true,
    canWrite: false,
    canCreate: false,
    canDelete: false,
    auditWanted: true,
  });
  assert.equal(access.fieldVerdicts, 'not_requested');
});

test('a null field leaf is an unknown field name, not a denial', async () => {
  // GraphQL resolves an unknown FIELD to null with no error at all — the same
  // silent failure the Table API has. Reporting that as canWrite:false would
  // invent a security finding.
  const svc = makeService(async () =>
    envelope('incident', {
      _table_metadata: { canRead: true, canWrite: true, canCreate: true, canDelete: true },
      _results: [
        { priority: { label: 'Priority', canRead: true, canWrite: true }, priorityy: null },
      ],
    }),
  );

  const access = await svc.fetchEffectiveAccess('incident', { fields: ['priority', 'priorityy'] });

  assert.deepEqual(access.unresolvedFields, ['priorityy']);
  assert.equal(access.fields.length, 1);
  assert.equal(access.fields[0].canWrite, true);
  assert.equal(access.fieldVerdicts, 'resolved');
});

test('no readable row means no field verdicts — reported, not guessed', async () => {
  const svc = makeService(async () =>
    envelope('incident', {
      _table_metadata: { canRead: true, canWrite: true, canCreate: true, canDelete: true },
      _results: [],
    }),
  );

  const access = await svc.fetchEffectiveAccess('incident', { fields: ['priority'] });

  assert.equal(access.fieldVerdicts, 'no_sample_row');
  assert.deepEqual(access.fields, []);
  // The table-level verdict is still valid: it needs no row.
  assert.equal(access.table.canWrite, true);
});

test('a missing metadata flag stays null instead of collapsing to false', async () => {
  const svc = makeService(async () => envelope('incident', { _table_metadata: { canRead: true } }));

  const access = await svc.fetchEffectiveAccess('incident');

  assert.equal(access.table.canRead, true);
  assert.equal(access.table.canWrite, null);
  assert.equal(access.table.canDelete, null);
});

test('a table resolved to null is reported as a missing table, not as GraphQL being down', async () => {
  // Verified live: an unknown table gives HTTP 200, no errors array, and a null
  // value for the table key.
  const svc = makeService(async () => envelope('no_such_table_xyz', null));

  await assert.rejects(
    () => svc.fetchEffectiveAccess('no_such_table_xyz'),
    /does not exist or is not exposed/,
  );
});

test('a missing GlideRecord namespace is still reported as unavailable', async () => {
  const svc = makeService(async () => ({ data: { GlideRecord_Query: {} } }));

  await assert.rejects(() => svc.fetchEffectiveAccess('incident'), GraphqlUnavailableError);
});

test('the write pre-flight is off unless asked for, and makes no request when off', async () => {
  let calls = 0;
  const reader = {
    async fetchEffectiveAccess() {
      calls += 1;
      return { table: { canWrite: false }, fields: [], fieldVerdicts: 'not_requested', unresolvedFields: [] };
    },
  };

  const message = await preflightEffectiveAccess(reader, {
    operation: 'update',
    tableName: 'incident',
  });

  assert.equal(message, null);
  assert.equal(calls, 0);
});

test('the create pre-flight checks canCreate and asks for no field verdicts', async () => {
  let seenOptions;
  const reader = {
    async fetchEffectiveAccess(_table, options) {
      seenOptions = options;
      return {
        table: { canRead: true, canWrite: false, canCreate: false, canDelete: false },
        fields: [],
        fieldVerdicts: 'not_requested',
        unresolvedFields: [],
      };
    },
  };

  const message = await preflightEffectiveAccess(reader, {
    operation: 'create',
    tableName: 'sys_security_acl',
    fields: ['name'],
    enabled: true,
  });

  // Field verdicts describe an existing row's write ACLs — the wrong question for
  // an insert, so create must not ask for them.
  assert.deepEqual(seenOptions.fields, []);
  assert.match(message, /cannot create records in sys_security_acl/);
  assert.match(message, /canCreate=false/);
  assert.match(message, /preflightAccess: false/);
});

test('a read-only field blocks an update even when the table is writable', async () => {
  const reader = {
    async fetchEffectiveAccess() {
      return {
        table: { canRead: true, canWrite: true, canCreate: true, canDelete: true },
        fields: [
          { field: 'short_description', canRead: true, canWrite: true },
          { field: 'sys_created_by', canRead: true, canWrite: false },
        ],
        fieldVerdicts: 'resolved',
        unresolvedFields: [],
      };
    },
  };

  const message = await preflightEffectiveAccess(reader, {
    operation: 'update',
    tableName: 'incident',
    fields: ['short_description', 'sys_created_by'],
    enabled: true,
  });

  assert.match(message, /cannot write field sys_created_by on incident/);
  assert.ok(!message.includes('short_description'));
});

test('an unknown verdict does not block — only an explicit false does', async () => {
  const reader = {
    async fetchEffectiveAccess() {
      return {
        table: { canRead: true, canWrite: null, canCreate: null, canDelete: null },
        fields: [{ field: 'priority', canRead: true, canWrite: null }],
        fieldVerdicts: 'resolved',
        unresolvedFields: [],
      };
    },
  };

  const message = await preflightEffectiveAccess(reader, {
    operation: 'update',
    tableName: 'incident',
    fields: ['priority'],
    enabled: true,
  });

  assert.equal(message, null);
});

test('a broken probe never blocks the write', async () => {
  const reader = {
    async fetchEffectiveAccess() {
      throw new GraphqlUnavailableError('This instance does not expose /api/now/graphql.');
    },
  };

  const message = await preflightEffectiveAccess(reader, {
    operation: 'update',
    tableName: 'incident',
    fields: ['priority'],
    enabled: true,
  });

  assert.equal(message, null);
});

/** sn_get_security_info needs only these two tables to answer; the rest are empty. */
function makeFakeTableService() {
  return {
    async queryRecords(table) {
      if (table === 'sys_security_acl') {
        return [{ sys_id: 'b'.repeat(32), name: 'incident', operation: 'write' }];
      }
      return [];
    },
  };
}

test('sn_get_security_info reports the verdict alongside the ACL inventory', async () => {
  const reader = {
    async fetchEffectiveAccess(table, options) {
      assert.deepEqual(options.fields, ['sys_created_by']);
      assert.equal(options.recordQuery, `sys_id=${SYS_ID}`);
      return {
        table: {
          label: 'Incident',
          canRead: true,
          canWrite: true,
          canCreate: true,
          canDelete: false,
          auditWanted: true,
        },
        fields: [{ field: 'sys_created_by', canRead: true, canWrite: false }],
        fieldVerdicts: 'resolved',
        unresolvedFields: [],
      };
    },
  };

  const result = await createGetSecurityInfoTool(makeFakeTableService(), reader).handler({
    tableName: 'incident',
    fields: ['sys_created_by'],
    recordSysId: SYS_ID,
  });
  const data = result.structuredContent;

  assert.equal(data.effectiveAccess.available, true);
  assert.equal(data.effectiveAccess.table.canDelete, false);
  assert.equal(data.effectiveAccess.evaluatedAgainstRecord, SYS_ID);
  assert.equal(data.effectiveAccess.fields[0].canWrite, false);
  // The compact verdict leads the summary line: '.' for a denied operation.
  assert.match(result.content[0].text, /effective access RWC\./);
  // The inventory still answers "why".
  assert.equal(data.acls.total, 1);
});

test('an unavailable verdict is stated, and warned about, never omitted', async () => {
  const reader = {
    async fetchEffectiveAccess() {
      throw new GraphqlUnavailableError('This instance does not expose /api/now/graphql.');
    },
  };

  const result = await createGetSecurityInfoTool(makeFakeTableService(), reader).handler({
    tableName: 'incident',
  });
  const data = result.structuredContent;

  assert.equal(data.effectiveAccess.available, false);
  assert.match(data.effectiveAccess.reason, /does not expose/);
  assert.ok(data.warnings.some((w) => /do not read this as denied access/.test(w)));
});

test('an unknown field name is warned about rather than reported as denied', async () => {
  const reader = {
    async fetchEffectiveAccess() {
      return {
        table: { canRead: true, canWrite: true, canCreate: true, canDelete: true },
        fields: [],
        fieldVerdicts: 'resolved',
        unresolvedFields: ['priorityy'],
      };
    },
  };

  const result = await createGetSecurityInfoTool(makeFakeTableService(), reader).handler({
    tableName: 'incident',
    fields: ['priorityy'],
  });

  assert.ok(
    result.structuredContent.warnings.some((w) => /these names are probably wrong/.test(w)),
  );
});

test('sn_update_records refuses before any HTTP call when the pre-flight denies', async () => {
  const tableService = {
    async updateRecord() {
      throw new Error('updateRecord must not be reached');
    },
    async getRecord() {
      throw new Error('getRecord must not be reached');
    },
  };
  const reader = {
    async fetchEffectiveAccess(_table, options) {
      // The target record is pinned, so the verdict describes THAT row.
      assert.equal(options.recordQuery, `sys_id=${SYS_ID}`);
      return {
        table: { canRead: true, canWrite: false, canCreate: false, canDelete: false },
        fields: [],
        fieldVerdicts: 'no_sample_row',
        unresolvedFields: [],
      };
    },
  };

  const result = await createUpdateRecordsTool(tableService, undefined, undefined, reader).handler({
    tableName: 'sys_security_acl',
    updates: [{ sysId: SYS_ID, fields: { active: 'false' } }],
    preflightAccess: true,
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /cannot update sys_security_acl/);
});

test('without preflightAccess the write is sent exactly as before', async () => {
  let created = 0;
  const tableService = {
    async createRecord() {
      created += 1;
      return { sys_id: SYS_ID, short_description: 'x' };
    },
  };
  const reader = {
    async fetchEffectiveAccess() {
      throw new Error('probe must not be reached');
    },
  };

  const result = await createCreateRecordsTool(tableService, undefined, undefined, reader).handler({
    tableName: 'incident',
    records: [{ short_description: 'x' }],
  });

  assert.equal(created, 1);
  assert.equal(result.structuredContent.success, true);
});
