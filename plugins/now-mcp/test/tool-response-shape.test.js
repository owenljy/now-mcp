import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toolResult } from '../build/utils/tool-response.js';

import { createCreateRecordsTool } from '../build/tools/create-records-tool.js';
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

test('toolResult attaches _meta and emits exactly ONE text block', () => {
	// One block, always: a client that receives structuredContent drops the text
	// entirely, so anything load-bearing must be on a structuredContent key. The
	// single block is a human-readable recap of the transcript, nothing more.
	const r = toolResult({ ok: true }, 'summary', { meta: { instance: 'dev', durationMs: 5 } });
	assert.equal(r.content.length, 1);
	assert.equal(r.content[0].text, 'summary');
	assert.deepEqual(r._meta, { instance: 'dev', durationMs: 5 });
});

// --- fakes -----------------------------------------------------------------

function fakeSchemaService(fields) {
	return {
		resolveInstance: () => ({ name: 'dev', url: 'https://dev.service-now.com' }),
		async getTableSchema() {
			return { exists: true, name: 'incident', label: 'Incident', extends: 'task', fields };
		},
		// Mirrors the real resolver's precedence: dictionary flag, then the
		// fallback-to-`name` convention, then nothing.
		async resolveDisplayField() {
			const flagged = fields.find((f) => f.display);
			if (flagged) return { field: flagged.name, source: 'dictionary' };
			if (fields.some((f) => f.name === 'name')) return { field: 'name', source: 'name_convention' };
			return undefined;
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

test('get_table_schema reports the display column, even when it is a sys_ field', async () => {
	// The failure this prevents: a caller assumes `title` holds the label,
	// reads a junk value out of it, and reports it to the user as content.
	const fields = [
		{ name: 'title', label: 'Title', type: 'string', mandatory: false, readOnly: false },
		{ name: 'label', label: 'Label', type: 'string', mandatory: false, readOnly: false, display: true },
	];
	const tool = createGetTableSchemaTool(fakeSchemaService(fields));
	const out = (await tool.handler({ tableName: 'sys_cs_conversation' })).structuredContent;
	assert.equal(out.displayField, 'label');
	assert.equal(out.displayFieldSource, 'dictionary');
});

test('get_table_schema marks a name-convention display field as inferred, not authoritative', async () => {
	const fields = [
		{ name: 'name', label: 'Name', type: 'string', mandatory: false, readOnly: false },
		{ name: 'other', label: 'Other', type: 'string', mandatory: false, readOnly: false },
	];
	const out = (await createGetTableSchemaTool(fakeSchemaService(fields)).handler({
		tableName: 'sys_user_group',
	})).structuredContent;
	assert.equal(out.displayField, 'name');
	assert.equal(out.displayFieldSource, 'name_convention');
});

test('get_table_schema omits displayField when no column is flagged', async () => {
	const fields = [{ name: 'a', label: 'A', type: 'string', mandatory: false, readOnly: false }];
	const out = (await createGetTableSchemaTool(fakeSchemaService(fields)).handler({
		tableName: 'incident',
	})).structuredContent;
	assert.ok(!('displayField' in out));
	assert.ok(!('displayFieldSource' in out));
});

test('get_table_schema hides platform bookkeeping by default and names what it hid', async () => {
	const fields = [
		{ name: 'short_description', label: 'Short description', type: 'string', mandatory: false, readOnly: false },
		{ name: 'sys_mod_count', label: 'Updates', type: 'integer', mandatory: false, readOnly: true },
		{ name: 'sys_domain_path', label: 'Domain Path', type: 'domain_path', mandatory: false, readOnly: false },
		// Kept: callers legitimately time-bound on these.
		{ name: 'sys_created_on', label: 'Created', type: 'glide_date_time', mandatory: false, readOnly: true },
		{ name: 'sys_id', label: 'Sys ID', type: 'GUID', mandatory: false, readOnly: true },
	];
	const out = (await createGetTableSchemaTool(fakeSchemaService(fields)).handler({
		tableName: 'incident',
	})).structuredContent;

	const names = out.rows.map((r) => r[0]);
	assert.deepEqual(names, ['short_description', 'sys_created_on', 'sys_id']);
	assert.deepEqual(out.systemFieldsHidden, ['sys_mod_count', 'sys_domain_path']);
	// fieldCount stays the table's real width — a filtered view must not read
	// as a narrow table.
	assert.equal(out.fieldCount, 5);
});

test('get_table_schema returns every field when includeSystemFields is set', async () => {
	const fields = [
		{ name: 'a', label: 'A', type: 'string', mandatory: false, readOnly: false },
		{ name: 'sys_mod_count', label: 'Updates', type: 'integer', mandatory: false, readOnly: true },
	];
	const out = (await createGetTableSchemaTool(fakeSchemaService(fields)).handler({
		tableName: 'incident',
		includeSystemFields: true,
	})).structuredContent;
	assert.deepEqual(out.rows.map((r) => r[0]), ['a', 'sys_mod_count']);
	assert.ok(!('systemFieldsHidden' in out));
});

test('get_table_schema never hides the display column, even if it is on the system list', async () => {
	const fields = [
		{ name: 'sys_tags', label: 'Tags', type: 'string', mandatory: false, readOnly: false, display: true },
		{ name: 'sys_mod_count', label: 'Updates', type: 'integer', mandatory: false, readOnly: true },
	];
	const out = (await createGetTableSchemaTool(fakeSchemaService(fields)).handler({
		tableName: 'weird',
	})).structuredContent;
	assert.deepEqual(out.rows.map((r) => r[0]), ['sys_tags']);
	assert.deepEqual(out.systemFieldsHidden, ['sys_mod_count']);
});

test('get_table_schema match filters on name and label, and says so when nothing matches', async () => {
	const fields = [
		{ name: 'assigned_to', label: 'Assigned to', type: 'reference', mandatory: false, readOnly: false },
		{ name: 'assignment_group', label: 'Assignment group', type: 'reference', mandatory: false, readOnly: false },
		{ name: 'u_owner', label: 'Assignee (legacy)', type: 'string', mandatory: false, readOnly: false },
		{ name: 'priority', label: 'Priority', type: 'integer', mandatory: false, readOnly: false },
	];
	const svc = fakeSchemaService(fields);

	const hit = (await createGetTableSchemaTool(svc).handler({
		tableName: 'incident',
		match: 'ASSIGN',
	})).structuredContent;
	// u_owner matches on LABEL only — that is the point of searching both.
	assert.deepEqual(hit.rows.map((r) => r[0]), ['assigned_to', 'assignment_group', 'u_owner']);
	assert.equal(hit.matchedCount, 3);
	assert.equal(hit.fieldCount, 4);

	const miss = (await createGetTableSchemaTool(svc).handler({
		tableName: 'incident',
		match: 'zzz',
	})).structuredContent;
	assert.equal(miss.rows.length, 0);
	assert.equal(miss.matchedCount, 0);
	assert.match(miss.hints.join(' '), /Drop match/);
});

test('get_table_schema materializes fixed columns with explicit booleans, never omitted', async () => {
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

	assert.deepEqual(out.columns, ['name', 'type', 'mandatory', 'readOnly', 'maxLength', 'reference']);
	const idx = Object.fromEntries(out.columns.map((c, i) => [c, i]));
	const byName = Object.fromEntries(out.rows.map((row) => [row[idx.name], row]));

	// mandatory:true / readOnly:false are both explicit booleans — false is
	// never omitted, since columnar null already means "column not returned".
	assert.equal(byName.short_description[idx.type], 'string');
	assert.equal(byName.short_description[idx.mandatory], true);
	assert.equal(byName.short_description[idx.readOnly], false);
	assert.equal(byName.short_description[idx.maxLength], 160);
	assert.equal(byName.short_description[idx.reference], null);
	// readOnly:true kept explicit; mandatory:false stays an explicit false, not omitted
	assert.equal(byName.sys_id[idx.readOnly], true);
	assert.equal(byName.sys_id[idx.mandatory], false);
	// label was never a column at all
	assert.ok(!out.columns.includes('label'), 'label is not a column');
	// summary text does not carry the field payload
	assert.match(res.content[0].text, /2 field\(s\) on incident/);
	assert.equal(out.instance, 'dev');
	assert.ok(!('instanceUrl' in out), 'instanceUrl dropped — available from sn_connection_status');
});

test('a single-record create echoes sys_id + only the fields the caller set, not the whole row', async () => {
	const created = {
		sys_id: 'a'.repeat(32),
		short_description: 'Net down',
		// server-populated noise the lean echo must NOT return:
		sys_created_on: '2026-07-05',
		state: '1',
		number: 'INC0001',
	};
	const tool = createCreateRecordsTool(fakeTableServiceForCreate(created), undefined, undefined);
	const res = await tool.handler({
		tableName: 'incident',
		records: [{ short_description: 'Net down' }],
	});
	const out = res.structuredContent;

	assert.equal(out.results[0].sysId, 'a'.repeat(32));
	assert.deepEqual(Object.keys(out.results[0].record).sort(), ['short_description', 'sys_id']);
	assert.ok(!('message' in out), 'prose message field dropped');
});

test('query_records summary is thin and columnar rows stay in structuredContent', async () => {
	const rows = [{ sys_id: 'a'.repeat(32), number: 'INC1' }];
	const tableService = {
		async queryRecordsWithMeta() {
			return { records: rows, totalCount: 1 };
		},
	};
	const schemaService = {
		async journalFieldsAmong() { return []; },
		async validateFields() { return null; },
	};
	const tool = createQueryRecordsTool(tableService, schemaService);
	const res = await tool.handler({ tableName: 'incident', fields: ['sys_id', 'number'], limit: 100, offset: 0 });
	const out = res.structuredContent;

	assert.deepEqual(out.columns, ['sys_id', 'number']);
	assert.deepEqual(out.rows, [['a'.repeat(32), 'INC1']], 'rows live in structuredContent, columnar');
	assert.match(res.content[0].text, /1 row\(s\)/);
	assert.ok(!res.content[0].text.includes('INC1'), 'row data not duplicated into the summary text');
	// counts/truncation stay in the body; transport is in the body too, not
	// duplicated into _meta.
	assert.deepEqual(Object.keys(res._meta).sort(), ['durationMs', 'instance']);
	assert.equal(out.transport, 'table-api');
});

test('a multi-record create response drops successRate and prose message', async () => {
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
	const tool = createCreateRecordsTool(undefined, batchService, undefined);
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
