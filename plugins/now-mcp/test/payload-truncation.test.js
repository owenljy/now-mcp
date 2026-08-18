import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAggregateRecordsTool } from '../build/tools/aggregate-records-tool.js';
import { createDiffRecordsTool } from '../build/tools/diff-records-tool.js';
import { createExecuteBackgroundScriptTool } from '../build/tools/execute-background-script-tool.js';
import { createQueryRecordsTool } from '../build/tools/query-records-tool.js';

/**
 * Per-field/value truncation and render guardrails, calibrated to stay well
 * under the MCP host's own per-call output ceiling (Claude Code defaults to
 * ~25k tokens) rather than a byte budget sized for prose. See query-records-tool.
 */

test('query_records truncates an oversized field value without dropping the row', async () => {
	const hugeMessage = 'x'.repeat(5000);
	const tableService = {
		async queryRecordsWithMeta() {
			return {
				records: [{ sys_id: 'a'.repeat(32), message: hugeMessage }],
				totalCount: 1,
			};
		},
	};
	const schemaService = {
		async journalFieldsAmong() { return []; },
		async validateFields() { return null; },
	};
	const tool = createQueryRecordsTool(tableService, schemaService);
	const res = await tool.handler({ tableName: 'syslog', fields: ['sys_id', 'message'], limit: 5, offset: 0 });
	const out = res.structuredContent;

	assert.equal(out.rows.length, 1, 'row is kept, not dropped');
	const messageCell = out.rows[0][out.columns.indexOf('message')];
	assert.ok(messageCell.length < hugeMessage.length, 'field value was shortened');
	assert.match(messageCell, /truncated \d+ chars/);
	assert.equal(out.fieldsTruncated, true);
});

test('query_records leaves small payloads untouched', async () => {
	const tableService = {
		async queryRecordsWithMeta() {
			return { records: [{ sys_id: 'a'.repeat(32), number: 'INC1' }], totalCount: 1 };
		},
	};
	const tool = createQueryRecordsTool(tableService);
	const res = await tool.handler({ tableName: 'incident', limit: 5, offset: 0 });
	assert.equal(res.structuredContent.fieldsTruncated, undefined);
	assert.equal(res.structuredContent.truncated, undefined);
});

test('execute_background_script truncates output on the scripted-REST fast path (no other cap exists there)', async () => {
	const hugeOutput = 'line\n'.repeat(5000);
	const scriptService = {
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
			return { success: true, output: hugeOutput, executionTime: 42 };
		},
	};
	const tool = createExecuteBackgroundScriptTool(scriptService, undefined);
	const res = await tool.handler({ script: 'gs.info("x");' });
	const out = res.structuredContent;

	assert.ok(out.output.length < hugeOutput.length, 'output was shortened');
	assert.match(out.output, /truncated \d+ chars/);
	assert.equal(out.outputTruncated, true);
});

test('execute_background_script leaves small output untouched', async () => {
	const scriptService = {
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
			return { success: true, output: 'ok', executionTime: 1 };
		},
	};
	const tool = createExecuteBackgroundScriptTool(scriptService, undefined);
	const res = await tool.handler({ script: 'gs.info("ok");' });
	assert.equal(res.structuredContent.output, 'ok');
	assert.equal(res.structuredContent.outputTruncated, undefined);
});

test('diff_records truncates oversized diffed values on both sides', async () => {
	const tableService = {
		async getRecord(_table, sysId) {
			return sysId === 'a'.repeat(32)
				? { sys_id: sysId, script: 'a'.repeat(5000) }
				: { sys_id: sysId, script: 'b'.repeat(5000) };
		},
	};
	const tool = createDiffRecordsTool(tableService);
	const res = await tool.handler({
		tableName: 'sys_script',
		sysIdA: 'a'.repeat(32),
		sysIdB: 'b'.repeat(32),
	});
	const out = res.structuredContent;

	assert.ok(out.diffs.script.a.length < 5000);
	assert.ok(out.diffs.script.b.length < 5000);
	assert.equal(out.valuesTruncated, true);
});

test('aggregate_records caps a high-cardinality group-by result', async () => {
	const groups = Array.from({ length: 3000 }, (_, i) => ({
		groupBy: { caller_id: `user${i}` },
		stats: { count: String(i) },
	}));
	const tableService = {
		async aggregateRecords() {
			return groups;
		},
	};
	const tool = createAggregateRecordsTool(tableService);
	const res = await tool.handler({ tableName: 'incident', groupBy: ['caller_id'], count: true });
	const out = res.structuredContent;

	assert.ok(out.result.length <= 2000, 'grouped result is capped');
	assert.equal(out.truncated, true);
	assert.equal(out.fetchedGroups, 3000);
});

test('aggregate_records leaves a small group-by result untouched', async () => {
	const groups = [{ groupBy: { priority: '1' }, stats: { count: '5' } }];
	const tableService = {
		async aggregateRecords() {
			return groups;
		},
	};
	const tool = createAggregateRecordsTool(tableService);
	const res = await tool.handler({ tableName: 'incident', groupBy: ['priority'], count: true });
	assert.deepEqual(res.structuredContent.result, groups);
	assert.equal(res.structuredContent.truncated, undefined);
});
