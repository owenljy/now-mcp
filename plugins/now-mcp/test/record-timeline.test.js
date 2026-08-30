import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	GetRecordTimelineOutputSchema,
	GetRecordTimelineSchema,
} from '../build/schemas/record-timeline-schemas.js';
import {
	createGetRecordTimelineTool,
	GET_RECORD_TIMELINE_TOOL,
} from '../build/tools/get-record-timeline-tool.js';
import { GET_RUNTIME_EVENTS_TOOL } from '../build/tools/get-runtime-events-tool.js';
import { routeAsk } from './eval/tool-eval-scorer.mjs';

const recordSysId = 'a'.repeat(32);
const since = '2026-08-30T01:00:00.000Z';

function service(overrides = {}) {
	return {
		async getRecord(table, sysId, fields) {
			assert.equal(table, 'incident');
			assert.equal(sysId, recordSysId);
			assert.ok(fields.includes('sys_created_on'));
			return {
				sys_id: recordSysId,
				sys_created_on: '2026-08-30 00:55:00',
				sys_created_by: 'api.user',
				sys_updated_on: '2026-08-30 01:04:00',
				sys_updated_by: 'system',
				sys_mod_count: '2',
			};
		},
		async queryRecords(table, options) {
			if (table === 'sys_audit') {
				assert.match(options.query, /sys_created_on>=2026-08-30 01:00:00/);
				assert.match(options.query, new RegExp(`documentkey=${recordSysId}`));
				assert.doesNotMatch(options.query, /tablename=/);
				return [
					{
						sys_id: 'b'.repeat(32),
						sys_created_on: '2026-08-30 01:02:00',
						user: { value: 'u1', display_value: 'System Administrator' },
						fieldname: 'priority',
						oldvalue: '3',
						newvalue: '1',
					},
				];
			}
			if (table === 'sys_journal_field') {
				assert.match(options.query, /sys_created_on>=2026-08-30 01:00:00/);
				assert.match(options.query, new RegExp(`element_id=${recordSysId}`));
				return [
					{
						sys_id: 'c'.repeat(32),
						sys_created_on: '2026-08-30 01:03:00',
						sys_created_by: 'alice',
						element: 'work_notes',
						value: 'Investigating the network path',
					},
				];
			}
			if (table === 'sys_flow_context') {
				assert.match(options.query, new RegExp(`source_record=${recordSysId}`));
				assert.match(options.query, /sys_updated_on>=2026-08-30 01:00:00/);
				return [
					{
						sys_id: 'f'.repeat(32),
						sys_created_on: '2026-08-30 01:01:30',
						sys_updated_on: '2026-08-30 01:02:30',
						sys_created_by: 'system',
						name: 'Incident Assignment Flow',
						flow: 'flow-definition-id',
						state: 'WAITING',
						error_state: '',
						error_message: '',
						execution_id: 'execution-1',
						run_time: '1250',
						calling_source: 'record_trigger',
					},
				];
			}
			throw new Error(`unexpected table ${table}`);
		},
		async queryRecordsWithMeta(table, options) {
			assert.match(options.query, new RegExp(recordSysId));
			if (table === 'syslog') {
				return {
					records: [
						{
							sys_id: 'd'.repeat(32),
							sys_created_on: '2026-08-30 01:04:00',
							level: '1',
							source: 'incident-rule',
							message: `processed ${recordSysId}`,
						},
					],
				};
			}
			if (table === 'sysevent') {
				return {
					records: [
						{
							sys_id: 'e'.repeat(32),
							sys_created_on: '2026-08-30 01:01:00',
							name: 'incident.assigned',
							instance: recordSysId,
							parm1: 'Network',
							parm2: '',
							state: 'ready',
						},
					],
				};
			}
			throw new Error(`unexpected runtime table ${table}`);
		},
		...overrides,
	};
}

test('timeline input requires exactly one bounded time selector', () => {
	assert.equal(
		GetRecordTimelineSchema.safeParse({ tableName: 'incident', recordSysId }).success,
		false,
	);
	assert.equal(
		GetRecordTimelineSchema.safeParse({
			tableName: 'incident',
			recordSysId,
			since,
			lookbackMinutes: 5,
		}).success,
		false,
	);
	assert.equal(
		GetRecordTimelineSchema.safeParse({ tableName: 'incident', recordSysId, since }).success,
		true,
	);
});

test('tool descriptions distinguish record history from system runtime searches', () => {
	const candidates = [GET_RECORD_TIMELINE_TOOL, GET_RUNTIME_EVENTS_TOOL];
	for (const [ask, expected] of [
		['Who changed the priority on this incident record?', 'sn_get_record_timeline'],
		['What happened to this RITM after it was created?', 'sn_get_record_timeline'],
		['Show recent syslog errors and queued events across the instance', 'sn_get_runtime_events'],
		['Did scheduled job cleanup run recently?', 'sn_get_runtime_events'],
	]) {
		assert.equal(routeAsk(ask, candidates).tool, expected, ask);
	}
});

test('record timeline merges audit, journal, and runtime evidence in chronological order', async () => {
	const tool = createGetRecordTimelineTool(service());
	const result = await tool.handler({ tableName: 'incident', recordSysId, since });

	assert.equal(result.isError, undefined);
	assert.equal(result.structuredContent.success, true);
	assert.equal(result.structuredContent.totalEvents, 5);
	assert.equal(GetRecordTimelineOutputSchema.safeParse(result.structuredContent).success, true);
	assert.deepEqual(
		result.structuredContent.rows.map((row) => [row[0], row[1], row[9]]),
		[
			['2026-08-30T01:01:00.000Z', 'event', 'confirmed'],
			['2026-08-30T01:02:00.000Z', 'field_change', 'confirmed'],
			['2026-08-30T01:02:30.000Z', 'flow_context', 'confirmed'],
			['2026-08-30T01:03:00.000Z', 'journal', 'confirmed'],
			['2026-08-30T01:04:00.000Z', 'log', 'correlated'],
		],
	);
	assert.equal(result.structuredContent.rows[1][3], 'System Administrator');
	assert.equal(result.structuredContent.rows[2][6], 'WAITING');
	assert.match(result.structuredContent.rows[2][7], /Incident Assignment Flow/);
	assert.equal(result.structuredContent.diagnostics.audit.status, 'ok');
	assert.equal(result.structuredContent.diagnostics.flow.rows, 1);
	assert.equal(result.structuredContent.diagnostics.runtime.queries, 2);
});

test('an unreadable optional source is reported without discarding other evidence', async () => {
	const base = service();
	const tool = createGetRecordTimelineTool(
		service({
			async queryRecords(table, options) {
				if (table === 'sys_journal_field') throw new Error('journal ACL denied');
				return base.queryRecords(table, options);
			},
		}),
	);
	const result = await tool.handler({
		tableName: 'incident',
		recordSysId,
		since,
		include: ['audit', 'journal'],
	});

	assert.equal(result.isError, undefined);
	assert.equal(result.structuredContent.totalEvents, 1);
	assert.equal(result.structuredContent.diagnostics.journal.status, 'unavailable');
	assert.match(result.structuredContent.warnings[0], /journal/);
});

test('the global timeline limit is applied after sorting and is explicit', async () => {
	const tool = createGetRecordTimelineTool(service());
	const result = await tool.handler({
		tableName: 'incident',
		recordSysId,
		since,
		limit: 2,
		order: 'newest_first',
	});

	assert.equal(result.structuredContent.totalEvents, 5);
	assert.equal(result.structuredContent.rows.length, 2);
	assert.equal(result.structuredContent.truncated, true);
	assert.equal(result.structuredContent.rows[0][1], 'log');
});

test('a missing target record fails the whole timeline', async () => {
	const tool = createGetRecordTimelineTool(
		service({
			async getRecord() {
				throw new Error('record not found');
			},
		}),
	);
	const result = await tool.handler({ tableName: 'incident', recordSysId, since });
	assert.equal(result.isError, true);
});
