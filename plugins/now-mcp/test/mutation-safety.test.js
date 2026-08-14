import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDeleteRecordsTool } from '../build/tools/delete-records-tool.js';
import { createDiagnoseMutationTool } from '../build/tools/diagnose-mutation-tool.js';
import { EXECUTE_BACKGROUND_SCRIPT_TOOL, createExecuteBackgroundScriptTool } from '../build/tools/execute-background-script-tool.js';
import { DELETE_RECORDS_TOOL } from '../build/tools/delete-records-tool.js';
import { createUpdateRecordTool } from '../build/tools/update-record-tool.js';

test('tool descriptions route ordinary deletion to the dedicated delete tool first', () => {
	assert.match(DELETE_RECORDS_TOOL.description, /FIRST and preferred tool/i);
	assert.match(DELETE_RECORDS_TOOL.description, /before reaching for GlideRecord\.deleteRecord/);
	assert.match(EXECUTE_BACKGROUND_SCRIPT_TOOL.description, /call sn_delete_records FIRST/);
});

test('background script reports application outcome false as an error', async () => {
	const tool = createExecuteBackgroundScriptTool({
		getExecutionTransportStatus() {
			return {
				transport: 'scripted_rest',
				configuredPath: '/api/x_test/script',
				usesCompanionEndpoint: true,
				fallbackOnFailure: false,
				privilegeModel: 'configured_endpoint_context',
				diagnostic: 'test',
			};
		},
		async executeBackgroundScript() {
			return { success: true, output: '{"ok":false,"reason":"abort"}', executionTime: 1, executionPath: 'scripted-rest', outcome: 'completed' };
		},
	});
	const res = await tool.handler({ script: 'log(JSON.stringify({ok:false}));', resultMode: 'json' });
	assert.equal(res.isError, true);
	assert.equal(res.structuredContent.transportSuccess, true);
	assert.equal(res.structuredContent.applicationSuccess, false);
});

test('security metadata writes require the explicit break-glass flag even without elicitation support', async () => {
	let called = false;
	const tool = createExecuteBackgroundScriptTool({ async executeBackgroundScript() { called = true; } });
	const res = await tool.handler({
		script: "var gr=new GlideRecord('sys_security_acl');gr.get('abc');gr.setValue('active',false);gr.update();",
		allowWrites: true,
	});
	assert.equal(res.isError, true);
	assert.match(res.content[0].text, /second explicit approval/);
	assert.equal(called, false);
});

test('update verification fails when persisted value differs', async () => {
	const service = {
		async updateRecord() { return { sys_id: 'a'.repeat(32), active: 'true' }; },
		async getRecord() { return { sys_id: 'a'.repeat(32), active: 'false' }; },
	};
	const res = await createUpdateRecordTool(service).handler({
		tableName: 'incident', sysId: 'a'.repeat(32), fields: { active: true }, verify: true,
	});
	assert.equal(res.isError, true);
	assert.equal(res.structuredContent.verification.persisted, false);
	assert.equal(res.structuredContent.failureType, 'mutation_not_persisted');
	assert.equal(res.structuredContent.recommendedTool, 'sn_diagnose_mutation');
});

test('delete surfaces a record that survived verification as a failure', async () => {
	// The verification itself is BatchService's job (see batch-service.test.js);
	// here we assert the tool does not launder a failed entry into a success.
	const batchService = {
		async batchDelete(table, sysIds) {
			return {
				success: false,
				successCount: 0,
				failureCount: 1,
				results: [{
					index: 0,
					success: false,
					sysId: sysIds[0],
					verified: false,
					error: 'Delete returned success, but the record still exists.',
				}],
			};
		},
	};
	const res = await createDeleteRecordsTool(batchService).handler({
		tableName: 'incident', sysIds: ['a'.repeat(32)], verify: true,
	});
	assert.equal(res.structuredContent.success, false);
	assert.equal(res.structuredContent.summary.failureCount, 1);
	assert.equal(res.structuredContent.results[0].verified, false);
});

test('mutation diagnostic parses the final JSON log line', async () => {
	const tool = createDiagnoseMutationTool({
		async executeBackgroundScript(script) {
			assert.match(script, /GlideRecordSecure/);
			return { success: true, output: 'prefix\n{"recordExists":true,"capabilities":{"canWrite":false},"fieldCapabilities":[],"activeBusinessRules":[],"applicableAcls":[],"referenceDependencies":[]}' };
		},
	});
	const res = await tool.handler({ tableName: 'incident', sysId: 'a'.repeat(32), operation: 'update', fields: ['active'] });
	assert.equal(res.structuredContent.recordExists, true);
	assert.equal(res.structuredContent.capabilities.canWrite, false);
});

test('mutation diagnostic maps update to write ACLs and reports missing coverage', async () => {
	const tool = createDiagnoseMutationTool({
		async executeBackgroundScript(script) {
			assert.match(script, /requestedOp==='update'\?'write':requestedOp/);
			assert.match(script, /sys_security_acl_role/);
			assert.match(script, /hierarchy/);
			return {
				success: true,
				output: JSON.stringify({
					recordExists: true,
					capabilities: { canWrite: false },
					fieldCapabilities: [],
					activeBusinessRules: [],
					applicableAcls: [],
					aclCoverage: { metadataReadable: true, operation: 'write', coverage: 'none' },
					referenceDependencies: [],
				}),
			};
		},
	});
	const res = await tool.handler({ tableName: 'incident', sysId: 'a'.repeat(32), operation: 'update' });
	assert.equal(res.structuredContent.aclCoverage.operation, 'write');
	assert.equal(res.structuredContent.probableBlocker, 'missing_acl_coverage');
});

test('mutation diagnostic does not overstate missing ACLs when metadata is unreadable', async () => {
	const tool = createDiagnoseMutationTool({
		async executeBackgroundScript() {
			return {
				success: true,
				output: JSON.stringify({
					recordExists: true,
					aclCoverage: { metadataReadable: false, coverage: 'unknown' },
				}),
			};
		},
	});
	const res = await tool.handler({ tableName: 'incident', sysId: 'a'.repeat(32), operation: 'delete' });
	assert.equal(res.structuredContent.aclCoverage.coverage, 'unknown');
	assert.equal(res.structuredContent.probableBlocker, 'acl_coverage_unknown');
});