import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toolResult } from '../build/utils/tool-response.js';

import { createBatchCreateTool } from '../build/tools/batch-create-tool.js';
import { createCreateRecordTool } from '../build/tools/create-record-tool.js';
import { createGetTableSchemaTool } from '../build/tools/get-table-schema-tool.js';
import { createQueryRecordsTool } from '../build/tools/query-records-tool.js';

/**
 * Token-consumption guardrails for tool responses (see the optimization pass):
 * full payloads live ONLY in structuredContent, the text block is a thin summary,
 * schema fields are compacted, and single-record writes echo lean.
 */

test('toolResult keeps data in structuredContent and text as a short summary', () => {
	const data = { success: true, records: [{ a: 1 }, { a: 2 }] };
	const r = toolResult(data, '2 rows');
	assert.equal(r.structuredContent, data, 'full data is the structuredContent');
	assert.equal(r.content.length, 1);
	assert.equal(r.content[0].text, '2 rows', 'text is the summary, not the payload');
	assert.ok(!r.content[0].text.includes('records'), 'payload is not duplicated into text');
});

test('toolResult appends extraText blocks and attaches _meta', () => {
	const r = toolResult({ ok: true }, 'summary', {
		meta: { instance: 'dev', durationMs: 5 },
		extraText: ['note: truncated'],
	});
	assert.equal(r.content.length, 2);
	assert.equal(r.content[1].text, 'note: truncated');
	assert.deepEqual(r._meta, { instance: 'dev', durationMs: 5 });
});

// --- fakes -----------------------------------------------------------------

function fakeSchemaService(fields) {
	return {
		resolveInstance: () => ({ name: 'dev', url: 'https://dev.service-now.com' }),
		async getTableSchema() {
			return { exists: true, name: 'incident', label: 'Incident', extends: 'task', fields };
		},
	};
}

function fakeTableServiceForCreate(created) {
	return {
		async createRecord() {
			return created;
		},
	};
}

test('get_table_schema compacts fields: name/type always, falsey booleans omitted, no label', async () => {
	const fields = [
		{
			name: 'short_description',
			label: 'Short description',
			type: 'string',
			mandatory: true,
			readOnly: false,
			maxLength: 160,
		},
		{ name: 'sys_id', label: 'Sys ID', type: 'GUID', mandatory: false, readOnly: true },
	];
	const tool = createGetTableSchemaTool(fakeSchemaService(fields));
	const res = await tool.handler({ tableName: 'incident' });
	const out = res.structuredContent;

	const byName = Object.fromEntries(out.fields.map((f) => [f.name, f]));
	// name + type always present
	assert.equal(byName.short_description.type, 'string');
	// mandatory:true kept; readOnly:false omitted
	assert.equal(byName.short_description.mandatory, true);
	assert.ok(!('readOnly' in byName.short_description), 'readOnly:false is omitted');
	assert.equal(byName.short_description.maxLength, 160);
	// readOnly:true kept; mandatory:false omitted
	assert.equal(byName.sys_id.readOnly, true);
	assert.ok(!('mandatory' in byName.sys_id), 'mandatory:false is omitted');
	// label dropped entirely from every field
	assert.ok(out.fields.every((f) => !('label' in f)), 'per-field label is dropped');
	// summary text does not carry the field payload
	assert.match(res.content[0].text, /2 field\(s\) on incident/);
	assert.equal(out.instance, 'dev');
	assert.equal(out.instanceUrl, 'https://dev.service-now.com');
});

test('create_record echoes sys_id + only the fields the caller set, not the whole row', async () => {
	const created = {
		sys_id: 'a'.repeat(32),
		short_description: 'Net down',
		// server-populated noise the lean echo must NOT return:
		sys_created_on: '2026-07-05',
		state: '1',
		number: 'INC0001',
	};
	const tool = createCreateRecordTool(fakeTableServiceForCreate(created), undefined);
	const res = await tool.handler({ tableName: 'incident', fields: { short_description: 'Net down' } });
	const out = res.structuredContent;

	assert.equal(out.sys_id, 'a'.repeat(32));
	assert.deepEqual(Object.keys(out.record).sort(), ['short_description', 'sys_id']);
	assert.ok(!('message' in out), 'prose message field dropped');
});

test('query_records summary is thin and rows stay in structuredContent', async () => {
	const rows = [{ sys_id: 'a'.repeat(32), number: 'INC1' }];
	const tableService = {
		async queryRecordsWithMeta() {
			return { records: rows, totalCount: 1 };
		},
	};
	const tool = createQueryRecordsTool(tableService);
	const res = await tool.handler({ tableName: 'incident', limit: 100, offset: 0 });

	assert.deepEqual(res.structuredContent.records, rows, 'rows live in structuredContent');
	assert.match(res.content[0].text, /1 row\(s\)/);
	assert.ok(!res.content[0].text.includes('INC1'), 'row data not duplicated into the summary text');
	// counts/truncation stay in the body; _meta is instance/duration plus which
	// transport served the read (table-api vs graphql, when expand is used).
	assert.deepEqual(Object.keys(res._meta).sort(), ['durationMs', 'instance', 'transport']);
	assert.equal(res._meta.transport, 'table-api');
});

test('batch_create response drops successRate and prose message', async () => {
	const batchService = {
		async batchCreate() {
			return {
				success: true,
				successCount: 2,
				failureCount: 0,
				results: [{ index: 0, success: true, sysId: 'a'.repeat(32) }],
			};
		},
	};
	// no schemaService => pre-flight validation is skipped
	const tool = createBatchCreateTool(batchService, undefined);
	const res = await tool.handler({
		tableName: 'incident',
		records: [{ short_description: '1' }, { short_description: '2' }],
	});
	const out = res.structuredContent;
	assert.ok(!('message' in out), 'prose message dropped');
	assert.ok(!('successRate' in out.summary), 'successRate dropped');
	assert.equal(out.summary.successCount, 2);
	assert.match(res.content[0].text, /2 ok, 0 failed/);
});
