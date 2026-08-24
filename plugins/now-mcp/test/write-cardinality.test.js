import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCreateRecordsTool } from '../build/tools/create-records-tool.js';
import { createUpdateRecordsTool } from '../build/tools/update-records-tool.js';

/**
 * The merged write surface: sn_create_records / sn_update_records take one record
 * or many, and the tool — not the caller — picks the transport. One record goes
 * over the plain Table API (real HTTP status, echoed row); two or more go over the
 * Table Batch API. Callers never choose a tool by cardinality, and never loop.
 */

const SYS_ID = 'a'.repeat(32);
const OTHER_ID = 'b'.repeat(32);

function spyTableService() {
	const calls = { create: 0, update: 0 };
	return {
		calls,
		async createRecord(_table, fields) {
			calls.create++;
			return { sys_id: SYS_ID, ...fields };
		},
		async updateRecord(_table, sysId, fields) {
			calls.update++;
			return { sys_id: sysId, ...fields };
		},
		async getRecord(_table, sysId, fields) {
			// Read-back agrees with what was written.
			return { sys_id: sysId, active: 'true', ...Object.fromEntries((fields ?? []).map((f) => [f, 'true'])) };
		},
	};
}

function spyBatchService(result) {
	const calls = { create: 0, update: 0, lastVerify: undefined };
	return {
		calls,
		async batchCreate(_table, records) {
			calls.create++;
			return (
				result ?? {
					success: true,
					successCount: records.length,
					failureCount: 0,
					results: records.map((_r, index) => ({ index, success: true, sysId: SYS_ID })),
				}
			);
		},
		async batchUpdate(_table, updates, _updateType, _continueOnError, verify) {
			calls.update++;
			calls.lastVerify = verify;
			return (
				result ?? {
					success: true,
					successCount: updates.length,
					failureCount: 0,
					results: updates.map((u, index) => ({ index, success: true, sysId: u.sysId })),
				}
			);
		},
	};
}

test('one record goes over the single-record Table API path, not the batch endpoint', async () => {
	const tableService = spyTableService();
	const batchService = spyBatchService();
	const res = await createCreateRecordsTool(tableService, batchService).handler({
		tableName: 'incident',
		records: [{ short_description: 'Net down' }],
	});

	assert.equal(tableService.calls.create, 1);
	assert.equal(batchService.calls.create, 0, 'a single insert must not pay the batch envelope');
	assert.equal(res.structuredContent.summary.total, 1);
	assert.equal(res.structuredContent.results[0].sysId, SYS_ID);
	assert.match(res.content[0].text, /^created incident/);
});

test('two or more records go over the batch endpoint in ONE tool call', async () => {
	const tableService = spyTableService();
	const batchService = spyBatchService();
	const res = await createCreateRecordsTool(tableService, batchService).handler({
		tableName: 'incident',
		records: [{ short_description: '1' }, { short_description: '2' }, { short_description: '3' }],
	});

	assert.equal(batchService.calls.create, 1, 'one batch call, not three');
	assert.equal(tableService.calls.create, 0);
	assert.equal(res.structuredContent.summary.successCount, 3);
	assert.match(res.content[0].text, /3 ok, 0 failed/);
});

test('the same envelope shape comes back for one record and for many', async () => {
	const tool = createCreateRecordsTool(spyTableService(), spyBatchService());
	const one = await tool.handler({ tableName: 'incident', records: [{ short_description: '1' }] });
	const many = await tool.handler({
		tableName: 'incident',
		records: [{ short_description: '1' }, { short_description: '2' }],
	});

	const shape = (r) => Object.keys(r.structuredContent).sort();
	assert.deepEqual(shape(one), shape(many));
	assert.deepEqual(shape(one), ['instance', 'results', 'success', 'summary', 'table']);
});

test('single-record update takes the Table API path and verifies by default', async () => {
	const tableService = spyTableService();
	const batchService = spyBatchService();
	const res = await createUpdateRecordsTool(tableService, batchService).handler({
		tableName: 'incident',
		updates: [{ sysId: SYS_ID, fields: { active: true } }],
	});

	assert.equal(tableService.calls.update, 1);
	assert.equal(batchService.calls.update, 0);
	assert.equal(res.structuredContent.results[0].verified, true, 'verify defaults to on');
	assert.equal(res.structuredContent.success, true);
});

test('multi-record update forwards verify to the batched read-back', async () => {
	const batchService = spyBatchService();
	await createUpdateRecordsTool(spyTableService(), batchService).handler({
		tableName: 'incident',
		updates: [
			{ sysId: SYS_ID, fields: { active: true } },
			{ sysId: OTHER_ID, fields: { active: true } },
		],
	});

	assert.equal(batchService.calls.update, 1);
	assert.equal(batchService.calls.lastVerify, true, 'verify must not be silently dropped in batch');
});

test('a write where nothing succeeded is an error result carrying recovery hints', async () => {
	const batchService = spyBatchService({
		success: false,
		successCount: 0,
		failureCount: 2,
		results: [
			{ index: 0, success: false, error: 'HTTP 403 — Access denied' },
			{ index: 1, success: false, error: 'HTTP 403 — Access denied' },
		],
	});
	const res = await createCreateRecordsTool(spyTableService(), batchService).handler({
		tableName: 'incident',
		records: [{ short_description: '1' }, { short_description: '2' }],
	});

	assert.equal(res.isError, true, 'zero writes landed → the call failed');
	// The hints a thrown single-record error would have carried are attached once,
	// not repeated per record — and they live in structuredContent, because a
	// client that gets structuredContent never sees the text blocks.
	const hints = res.structuredContent.hints;
	assert.ok(Array.isArray(hints) && hints.length >= 1, 'hints ride in the body');
	assert.match(hints.join(' '), /Access denied on 'incident'/);
	assert.ok(
		!res.content.some((c) => /^Hints:/.test(c.text)),
		'and are not ALSO emitted as a text block, which would pay for them twice',
	);
});

test('a partial failure is reported with counts rather than as an error', async () => {
	const batchService = spyBatchService({
		success: false,
		successCount: 1,
		failureCount: 1,
		results: [
			{ index: 0, success: true, sysId: SYS_ID },
			{ index: 1, success: false, error: 'HTTP 400 — Bad request' },
		],
	});
	const res = await createCreateRecordsTool(spyTableService(), batchService).handler({
		tableName: 'incident',
		records: [{ short_description: '1' }, { short_description: '2' }],
	});

	assert.equal(res.isError, undefined, 'one record did land — not an error result');
	assert.equal(res.structuredContent.success, false);
	assert.equal(res.structuredContent.summary.successCount, 1);
});
