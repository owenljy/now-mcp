import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDeleteRecordsTool } from '../build/tools/delete-records-tool.js';
import { createDiagnoseMutationTool } from '../build/tools/diagnose-mutation-tool.js';
import { EXECUTE_BACKGROUND_SCRIPT_TOOL, createExecuteBackgroundScriptTool } from '../build/tools/execute-background-script-tool.js';
import { DELETE_RECORDS_TOOL } from '../build/tools/delete-records-tool.js';
import { createUpdateRecordsTool } from '../build/tools/update-records-tool.js';

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

test('single-record update verification fails when the persisted value differs', async () => {
	const service = {
		async updateRecord() { return { sys_id: 'a'.repeat(32), active: 'true' }; },
		async getRecord() { return { sys_id: 'a'.repeat(32), active: 'false' }; },
	};
	const res = await createUpdateRecordsTool(service).handler({
		tableName: 'incident',
		updates: [{ sysId: 'a'.repeat(32), fields: { active: true } }],
		verify: true,
	});
	// Nothing succeeded, so the whole call is an error — same signal the split
	// single-record tool gave.
	assert.equal(res.isError, true);
	assert.equal(res.structuredContent.success, false);
	assert.equal(res.structuredContent.results[0].verified, false);
	assert.deepEqual(res.structuredContent.results[0].mismatches, [
		{ field: 'active', expected: true, actual: 'false' },
	]);
	assert.equal(res.structuredContent.failureType, 'mutation_not_persisted');
	assert.equal(res.structuredContent.recommendedTool, 'sn_diagnose_mutation');
});

test('a single-record update is not gated behind a confirmation prompt', async () => {
	let elicited = 0;
	const server = {
		async elicitInput() {
			elicited++;
			return { action: 'accept', content: { confirmed: true } };
		},
	};
	const service = {
		async updateRecord() { return { sys_id: 'a'.repeat(32), active: 'true' }; },
	};
	const res = await createUpdateRecordsTool(service).handler(
		{ tableName: 'incident', updates: [{ sysId: 'a'.repeat(32), fields: { active: true } }], verify: false },
		server,
	);
	assert.equal(elicited, 0, 'one targeted field change must not prompt');
	assert.equal(res.structuredContent.success, true);
});

test('a multi-record update requires confirmation and writes nothing when declined', async () => {
	let updated = 0;
	const batchService = {
		async batchUpdate() {
			updated++;
			return { success: true, successCount: 2, failureCount: 0, results: [] };
		},
	};
	const server = { async elicitInput() { return { action: 'decline' }; } };
	const res = await createUpdateRecordsTool(undefined, batchService).handler(
		{
			tableName: 'incident',
			updates: [
				{ sysId: 'a'.repeat(32), fields: { active: true } },
				{ sysId: 'b'.repeat(32), fields: { active: true } },
			],
		},
		server,
	);
	assert.equal(updated, 0, 'a declined confirmation must not reach the instance');
	assert.match(res.content[0].text, /cancelled by user/);
});

test('a multi-record update surfaces a non-persisted row as a failure with the diagnosis', async () => {
	// The read-back itself is BatchService's job (see batch-service.test.js); here
	// we assert the tool reports the diagnosis and does not launder the failure.
	const batchService = {
		async batchUpdate() {
			return {
				success: false,
				successCount: 1,
				failureCount: 1,
				results: [
					{ index: 0, success: true, sysId: 'a'.repeat(32), verified: true },
					{
						index: 1,
						success: false,
						sysId: 'b'.repeat(32),
						verified: false,
						mismatches: [{ field: 'active', expected: true, actual: 'false' }],
						error: 'Update returned success, but the requested values did not persist.',
					},
				],
			};
		},
	};
	const res = await createUpdateRecordsTool(undefined, batchService).handler({
		tableName: 'incident',
		updates: [
			{ sysId: 'a'.repeat(32), fields: { active: true } },
			{ sysId: 'b'.repeat(32), fields: { active: true } },
		],
	});
	assert.equal(res.structuredContent.success, false);
	assert.equal(res.structuredContent.summary.failureCount, 1);
	assert.equal(res.structuredContent.failureType, 'mutation_not_persisted');
	// A partial success is NOT an error result — one row did persist.
	assert.equal(res.isError, undefined);
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