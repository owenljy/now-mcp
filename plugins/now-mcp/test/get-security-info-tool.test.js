import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGetSecurityInfoTool } from '../build/tools/get-security-info-tool.js';

const ACL_ID = 'a'.repeat(32);

/**
 * Fake TableService that records every queryRecords call's options and returns
 * canned rows shaped the way the real Table API would for the requested
 * displayValue mode — no network round trip.
 */
function makeFakeTableService() {
  const calls = [];
  return {
    calls,
    async queryRecords(table, options) {
      calls.push({ table, options });
      if (table === 'sys_security_acl') {
        return [{ sys_id: ACL_ID, name: 'incident', operation: 'read' }];
      }
      if (table === 'sys_security_acl_role') {
        // displayValue: 'all' -> reference fields become {value, display_value}
        return [
          {
            sys_security_acl: { value: ACL_ID, display_value: 'incident' },
            sys_user_role: { value: 'b'.repeat(32), display_value: 'itil' },
          },
        ];
      }
      return [];
    },
  };
}

test('get-security-info passes excludeReferenceLink on every queryRecords call', async () => {
  const tableService = makeFakeTableService();
  const tool = createGetSecurityInfoTool(tableService);

  await tool.handler({ tableName: 'incident' });

  assert.ok(tableService.calls.length > 0);
  for (const call of tableService.calls) {
    assert.equal(
      call.options.excludeReferenceLink,
      true,
      `expected excludeReferenceLink:true on ${call.table} query`,
    );
  }
});

test('get-security-info default response omits raw detail arrays and resolves role names', async () => {
  const tableService = makeFakeTableService();
  const tool = createGetSecurityInfoTool(tableService);

  const result = await tool.handler({ tableName: 'incident' });
  const data = result.structuredContent;

  assert.equal(data.acls.details, undefined);
  assert.equal(data.roleRequirements, undefined);
  assert.equal(data.dictionary, undefined, 'dictionary is gated behind includeDetails too');
  assert.deepEqual(data.aclRoleGroups.map((g) => g.requiredRolesAnyOf), [['itil']]);
  assert.equal(data.acls.total, 1);
  assert.equal(data.acls.byOperation.read, 1);

  const roleCall = tableService.calls.find((c) => c.table === 'sys_security_acl_role');
  assert.equal(roleCall.options.displayValue, 'all');
});

test('get-security-info includeDetails:true returns the raw arrays too', async () => {
  const tableService = makeFakeTableService();
  const tool = createGetSecurityInfoTool(tableService);

  const result = await tool.handler({ tableName: 'incident', includeDetails: true });
  const data = result.structuredContent;

  assert.equal(data.acls.details.length, 1);
  assert.equal(data.roleRequirements.length, 1);
  assert.deepEqual(data.dictionary, [], 'dictionary is queried and included once includeDetails is set');
  assert.deepEqual(data.aclRoleGroups.map((g) => g.requiredRolesAnyOf), [['itil']]);
});

test('get-security-info preserves per-ACL any-of role semantics', async () => {
  const calls = [];
  const tableService = {
    calls,
    async queryRecords(table, options) {
      calls.push({ table, options });
      if (table === 'sys_security_acl') {
        return [{
          sys_id: ACL_ID,
          name: 'incident',
          operation: 'delete',
          active: 'true',
          admin_overrides: 'false',
          condition: 'active=true',
          script: 'answer = current.canDelete();',
        }];
      }
      if (table === 'sys_security_acl_role') {
        return [
          {
            sys_security_acl: { value: ACL_ID, display_value: 'incident' },
            sys_user_role: { value: 'b'.repeat(32), display_value: 'admin' },
          },
          {
            sys_security_acl: { value: ACL_ID, display_value: 'incident' },
            sys_user_role: { value: 'c'.repeat(32), display_value: 'maint' },
          },
        ];
      }
      return [];
    },
  };

  const result = await createGetSecurityInfoTool(tableService).handler({ tableName: 'incident' });
  const data = result.structuredContent;

  assert.deepEqual(data.aclRoleGroups, [{
    aclSysId: ACL_ID,
    name: 'incident',
    operation: 'delete',
    active: true,
    adminOverrides: false,
    // roleRequirement dropped — derivable as requiredRolesAnyOf.length > 0.
    requiredRolesAnyOf: ['admin', 'maint'],
    hasCondition: true,
    hasScript: true,
  }]);
});

test('get-security-info omits hasCondition/hasScript (not false) when the ACL has neither', async () => {
  const tableService = {
    async queryRecords(table) {
      if (table === 'sys_security_acl') {
        return [{ sys_id: ACL_ID, name: 'incident', operation: 'read', active: 'true', admin_overrides: 'false' }];
      }
      return [];
    },
  };
  const result = await createGetSecurityInfoTool(tableService).handler({ tableName: 'incident' });
  const [group] = result.structuredContent.aclRoleGroups;
  assert.equal('hasCondition' in group, false);
  assert.equal('hasScript' in group, false);
});

test('get-security-info strips the raw script from beforeBusinessRules while keeping hasAbortAction', async () => {
  const tableService = {
    async queryRecords(table) {
      if (table === 'sys_script') {
        return [
          {
            sys_id: 'c'.repeat(32),
            name: 'Abort on close',
            when: 'before',
            script: "if (current.state == 7) { current.setAbortAction(true); }",
          },
        ];
      }
      return [];
    },
  };
  const result = await createGetSecurityInfoTool(tableService).handler({ tableName: 'incident' });
  const [br] = result.structuredContent.beforeBusinessRules;
  assert.equal(br.hasAbortAction, true);
  assert.equal('script' in br, false, 'the raw script body must not be echoed back');
});
