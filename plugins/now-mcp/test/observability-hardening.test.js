import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UploadAttachmentSchema } from '../build/schemas/attachment-schemas.js';
import { GetRuntimeEventsSchema } from '../build/schemas/runtime-diagnostic-schemas.js';
import { createQueryRecordsTool } from '../build/tools/query-records-tool.js';
import { createGetRuntimeEventsTool } from '../build/tools/get-runtime-events-tool.js';
import { assessQueryRisk } from '../build/utils/query-risk.js';

const id = 'a'.repeat(32);

test('attachment input enforces fileContent/filePath XOR and path can infer fileName', () => {
	assert.equal(UploadAttachmentSchema.safeParse({ tableName: 'incident', recordSysId: id }).success, false);
	assert.equal(UploadAttachmentSchema.safeParse({ tableName: 'incident', recordSysId: id, filePath: '/tmp/a.txt', fileContent: 'YQ==' }).success, false);
	assert.equal(UploadAttachmentSchema.safeParse({ tableName: 'incident', recordSysId: id, filePath: '/tmp/a.txt' }).success, true);
});

test('safe policy identifies the risky syslog OR text query', async () => {
	const query = 'messageLIKEanalyze-case-photo^ORmessageLIKEAI Lens';
	const risk = assessQueryRisk('syslog', query);
	assert.equal(risk.risky, true);
	assert.match(risk.reasons.join(' '), /limit constrains returned rows/i);
	assert.match(risk.suggestion, /sys_created_on>=/);

	let called = false;
	const tool = createQueryRecordsTool({ async queryRecordsWithMeta() { called = true; return { records: [] }; } });
	const result = await tool.handler({ tableName: 'syslog', query, limit: 20 });
	assert.equal(result.isError, true);
	assert.equal(called, false);
});

test('allow_expensive explicitly permits a risky query', async () => {
	let called = false;
	const tool = createQueryRecordsTool({ async queryRecordsWithMeta() { called = true; return { records: [], totalCount: 0 }; } });
	await tool.handler({ tableName: 'syslog', query: 'messageLIKEx', queryPolicy: 'allow_expensive' });
	assert.equal(called, true);
});

test('runtime diagnostics require one time bound and split message terms', async () => {
	assert.equal(GetRuntimeEventsSchema.safeParse({}).success, false);
	assert.equal(GetRuntimeEventsSchema.safeParse({ since: new Date().toISOString(), lookbackMinutes: 5 }).success, false);
	const queries = [];
	const tool = createGetRuntimeEventsTool({
		async queryRecordsWithMeta(table, options) { queries.push({ table, query: options.query }); return { records: [] }; },
	});
	const result = await tool.handler({ lookbackMinutes: 5, include: ['logs'], messageContains: ['one', 'two'] });
	assert.equal(result.structuredContent.success, true);
	assert.equal(queries.length, 2);
	assert.ok(queries.every((q) => q.query.startsWith('sys_created_on>=')));
	assert.ok(queries.every((q) => !/\^OR(?!DERBY)/.test(q.query)));
});