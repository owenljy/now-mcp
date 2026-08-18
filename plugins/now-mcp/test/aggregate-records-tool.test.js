import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAggregateRecordsTool } from '../build/tools/aggregate-records-tool.js';

test('groupBy on a unique-per-row column is blocked', async () => {
	let called = false;
	const tableService = { async aggregateRecords() { called = true; return []; } };
	const tool = createAggregateRecordsTool(tableService);
	const res = await tool.handler({ tableName: 'incident', groupBy: ['sys_id'], count: true });
	assert.equal(res.isError, true);
	assert.match(res.content[0].text, /unique per row/);
	assert.equal(called, false, 'must not reach the instance');
});

test('having that does not name an aggregate function is blocked, not silently sent', async () => {
	let called = false;
	const tableService = { async aggregateRecords() { called = true; return { stats: { count: '5' } }; } };
	const tool = createAggregateRecordsTool(tableService);
	const res = await tool.handler({ tableName: 'incident', having: 'priority>3', count: true });
	assert.equal(res.isError, true);
	assert.match(res.content[0].text, /does not name an aggregate/);
	assert.equal(called, false);
});

test('having naming an aggregate that was not requested is blocked', async () => {
	let called = false;
	const tableService = { async aggregateRecords() { called = true; return { stats: { count: '5' } }; } };
	const tool = createAggregateRecordsTool(tableService);
	// having references avg, but avgFields was never set.
	const res = await tool.handler({ tableName: 'incident', having: 'avg>3', count: true });
	assert.equal(res.isError, true);
	assert.match(res.content[0].text, /not actually requested/);
	assert.equal(called, false);
});

test('having naming an aggregate that was not requested, but skipFieldValidation:true, runs as written', async () => {
	let receivedHaving;
	const tableService = {
		async aggregateRecords(_table, opts) {
			receivedHaving = opts.having;
			return { stats: { count: '5' } };
		},
	};
	const tool = createAggregateRecordsTool(tableService);
	const res = await tool.handler({
		tableName: 'incident',
		having: 'avg>3',
		count: true,
		skipFieldValidation: true,
	});
	assert.equal(res.isError, undefined);
	assert.equal(receivedHaving, 'avg>3');
});

test('topGroups without count or orderBy is rejected as unorderable', async () => {
	let called = false;
	const tableService = { async aggregateRecords() { called = true; return []; } };
	const tool = createAggregateRecordsTool(tableService);
	const res = await tool.handler({
		tableName: 'incident',
		groupBy: ['priority'],
		count: false,
		topGroups: 3,
	});
	assert.equal(res.isError, true);
	assert.match(res.content[0].text, /ordering criterion/);
	assert.equal(called, false);
});

test('topGroups defaults orderBy to DESCcount when count is requested and no orderBy given', async () => {
	let receivedOrderBy;
	const groups = Array.from({ length: 10 }, (_, i) => ({ groupBy: { priority: String(i) }, stats: { count: String(10 - i) } }));
	const tableService = {
		async aggregateRecords(_table, opts) {
			receivedOrderBy = opts.orderBy;
			return groups;
		},
	};
	const tool = createAggregateRecordsTool(tableService);
	const res = await tool.handler({ tableName: 'incident', groupBy: ['priority'], count: true, topGroups: 3 });
	assert.equal(receivedOrderBy, 'DESCcount');
	assert.equal(res.structuredContent.result.length, 3);
	assert.equal(res.structuredContent.totalGroups, 10);
});

test('an explicit orderBy is never overridden by the topGroups default', async () => {
	let receivedOrderBy;
	const groups = [{ groupBy: { priority: '1' }, stats: { count: '5' } }];
	const tableService = {
		async aggregateRecords(_table, opts) {
			receivedOrderBy = opts.orderBy;
			return groups;
		},
	};
	const tool = createAggregateRecordsTool(tableService);
	await tool.handler({ tableName: 'incident', groupBy: ['priority'], count: true, orderBy: 'priority', topGroups: 1 });
	assert.equal(receivedOrderBy, 'priority');
});

test('a plain groupBy+count call without topGroups never gets a default orderBy injected', async () => {
	let receivedOrderBy = 'unset';
	const tableService = {
		async aggregateRecords(_table, opts) {
			receivedOrderBy = opts.orderBy;
			return [{ groupBy: { priority: '1' }, stats: { count: '5' } }];
		},
	};
	const tool = createAggregateRecordsTool(tableService);
	await tool.handler({ tableName: 'incident', groupBy: ['priority'], count: true });
	assert.equal(receivedOrderBy, undefined, 'no orderBy was requested and topGroups was not set — must stay undefined');
});

test('totalGroups is absent when topGroups is not used', async () => {
	const groups = [{ groupBy: { priority: '1' }, stats: { count: '5' } }];
	const tableService = { async aggregateRecords() { return groups; } };
	const tool = createAggregateRecordsTool(tableService);
	const res = await tool.handler({ tableName: 'incident', groupBy: ['priority'], count: true });
	assert.equal('totalGroups' in res.structuredContent, false);
});

test('the ungrouped summary line carries the count, not a bare "aggregate on X"', async () => {
	const tableService = { async aggregateRecords() { return { stats: { count: '27' } }; } };
	const tool = createAggregateRecordsTool(tableService);
	const res = await tool.handler({ tableName: 'incident', count: true });
	assert.match(res.content[0].text, /count=27 on incident/);
});

test('an ungrouped rollup with no stats.count (e.g. avg-only) falls back to the generic summary', async () => {
	const tableService = { async aggregateRecords() { return { stats: { avg: { reassignment_count: '1.5' } } }; } };
	const tool = createAggregateRecordsTool(tableService);
	const res = await tool.handler({ tableName: 'incident', count: false, avgFields: ['reassignment_count'] });
	assert.match(res.content[0].text, /aggregate on incident/);
});
