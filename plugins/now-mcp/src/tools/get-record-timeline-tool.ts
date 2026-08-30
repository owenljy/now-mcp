import {
	type GetRecordTimelineInput,
	GetRecordTimelineOutputSchema,
	GetRecordTimelineSchema,
} from '../schemas/record-timeline-schemas.js';
import type { TableService } from '../services/table-service.js';
import { toolError } from '../utils/error-handler.js';
import { capRendered } from '../utils/render-cap.js';
import { toolResult } from '../utils/tool-response.js';
import { truncateValue } from '../utils/value-truncation.js';
import { collectRuntimeEvents } from './get-runtime-events-tool.js';

const TIMELINE_COLUMNS = [
	'timestamp',
	'kind',
	'source',
	'actor',
	'field',
	'oldValue',
	'newValue',
	'message',
	'sysId',
	'confidence',
] as const;
const SNAPSHOT_FIELDS = [
	'sys_id',
	'sys_created_on',
	'sys_created_by',
	'sys_updated_on',
	'sys_updated_by',
	'sys_mod_count',
];
const MAX_VALUE_CHARS = 1000;
const MAX_SERIALIZED_BYTES = 45_000;

type TimelineRow = [
	string,
	string,
	string,
	unknown,
	unknown,
	unknown,
	unknown,
	unknown,
	unknown,
	'confirmed' | 'correlated',
];

type Diagnostic = {
	status: 'ok' | 'unavailable';
	rows: number;
	queries: number;
	error?: string;
};

function plain(value: unknown): unknown {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const ref = value as { value?: unknown; display_value?: unknown };
		return ref.display_value ?? ref.value ?? value;
	}
	return value ?? null;
}

function text(value: unknown): string {
	const v = plain(value);
	return v === null ? '' : String(v);
}

function timestamp(value: unknown): string {
	const raw =
		value && typeof value === 'object' && !Array.isArray(value)
			? String((value as { value?: unknown }).value ?? text(value))
			: text(value);
	if (!raw) return '';
	const parsed = new Date(/Z$|[+-]\d\d:\d\d$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`);
	return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

function capped(value: unknown): unknown {
	return truncateValue(plain(value), MAX_VALUE_CHARS).value;
}

function objectRows(group: { columns: string[]; rows: unknown[][] } | undefined) {
	if (!group) return [];
	return group.rows.map((cells) =>
		Object.fromEntries(group.columns.map((column, index) => [column, cells[index]])),
	);
}

function sourceError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function optionalSource<T>(
	query: () => Promise<T[]>,
): Promise<{ records: T[]; diagnostic: Diagnostic }> {
	try {
		const records = await query();
		return { records, diagnostic: { status: 'ok', rows: records.length, queries: 1 } };
	} catch (error) {
		return {
			records: [],
			diagnostic: { status: 'unavailable', rows: 0, queries: 1, error: sourceError(error) },
		};
	}
}

export const GET_RECORD_TIMELINE_TOOL = {
	name: 'sn_get_record_timeline',
	title: 'Get record timeline',
	description: `What: Reconstruct what happened to one ServiceNow record within a required time window.
When to use: For "who changed this field", "why did this record change", or "what happened after this record was created". Use sn_get_runtime_events instead for a system-wide log/event/job search that is not centered on one record.
	Produces: a compact chronological table combining confirmed sys_audit field changes, journal entries, Flow Designer execution contexts, and runtime evidence correlated by sys_id, plus the current record snapshot and per-source diagnostics. A runtime log containing the sys_id is marked correlated, not treated as proof of causation. An unreadable optional source is reported as unavailable without discarding evidence from other sources.`,
	inputSchema: GetRecordTimelineSchema,
	outputSchema: GetRecordTimelineOutputSchema,
};

export function createGetRecordTimelineTool(tableService: TableService) {
	return {
		...GET_RECORD_TIMELINE_TOOL,
		handler: async (params: unknown) => {
			let tableName: string | undefined;
			try {
				const input: GetRecordTimelineInput = GetRecordTimelineSchema.parse(params);
				tableName = input.tableName;
				const since = input.since
					? new Date(input.since)
					: new Date(Date.now() - (input.lookbackMinutes as number) * 60_000);
				const sinceIso = since.toISOString();
				const lowerBound = sinceIso.slice(0, 19).replace('T', ' ');

				// The target record is the anchor, not an optional evidence source. If it
				// is missing or unreadable, a timeline for that identity would be unsafe.
				const record = await tableService.getRecord(
					input.tableName,
					input.recordSysId,
					SNAPSHOT_FIELDS,
					input.instance,
				);

				const diagnostics: Record<string, Diagnostic> = {
					record: { status: 'ok', rows: 1, queries: 1 },
				};
				const rows: TimelineRow[] = [];
				const createdAt = timestamp((record as Record<string, unknown>).sys_created_on);
				if (createdAt && createdAt >= sinceIso) {
					rows.push([
						createdAt,
						'created',
						input.tableName,
						plain((record as Record<string, unknown>).sys_created_by),
						null,
						null,
						null,
						null,
						input.recordSysId,
						'confirmed',
					]);
				}

				const tasks: Promise<void>[] = [];
				if (input.include.includes('audit')) {
					tasks.push(
						optionalSource(() =>
							tableService.queryRecords(
								'sys_audit',
								{
									query: [
										`documentkey=${input.recordSysId}`,
										`sys_created_on>=${lowerBound}`,
										'ORDERBYsys_created_on',
									].join('^'),
									fields: ['sys_id', 'sys_created_on', 'user', 'fieldname', 'oldvalue', 'newvalue'],
									limit: input.limit,
									offset: 0,
									displayValue: 'all',
									excludeReferenceLink: true,
								},
								input.instance,
							),
						).then(({ records, diagnostic }) => {
							diagnostics.audit = diagnostic;
							for (const audit of records as Record<string, unknown>[]) {
								rows.push([
									timestamp(audit.sys_created_on),
									'field_change',
									'sys_audit',
									plain(audit.user),
									plain(audit.fieldname),
									capped(audit.oldvalue),
									capped(audit.newvalue),
									null,
									plain(audit.sys_id),
									'confirmed',
								]);
							}
						}),
					);
				}

				if (input.include.includes('journal')) {
					tasks.push(
						optionalSource(() =>
							tableService.queryRecords(
								'sys_journal_field',
								{
									query: [
										`element_id=${input.recordSysId}`,
										`sys_created_on>=${lowerBound}`,
										'ORDERBYsys_created_on',
									].join('^'),
									fields: [
										'sys_id',
										'sys_created_on',
										'sys_created_by',
										'name',
										'element',
										'value',
									],
									limit: input.limit,
									offset: 0,
									displayValue: false,
									excludeReferenceLink: true,
								},
								input.instance,
							),
						).then(({ records, diagnostic }) => {
							diagnostics.journal = diagnostic;
							for (const journal of records as Record<string, unknown>[]) {
								rows.push([
									timestamp(journal.sys_created_on),
									'journal',
									'sys_journal_field',
									plain(journal.sys_created_by),
									plain(journal.element),
									null,
									null,
									capped(journal.value),
									plain(journal.sys_id),
									'confirmed',
								]);
							}
						}),
					);
				}

				if (input.include.includes('flow')) {
					tasks.push(
						optionalSource(() =>
							tableService.queryRecords(
								'sys_flow_context',
								{
									query: [
										`source_record=${input.recordSysId}`,
										`sys_updated_on>=${lowerBound}`,
										'ORDERBYsys_updated_on',
									].join('^'),
									fields: [
										'sys_id',
										'sys_created_on',
										'sys_updated_on',
										'sys_created_by',
										'name',
										'flow',
										'state',
										'error_state',
										'error_message',
										'execution_id',
										'run_time',
										'calling_source',
									],
									limit: input.limit,
									offset: 0,
									displayValue: false,
									excludeReferenceLink: true,
								},
								input.instance,
							),
						).then(({ records, diagnostic }) => {
							diagnostics.flow = diagnostic;
							for (const context of records as Record<string, unknown>[]) {
								const details = [
									text(context.name),
									text(context.state) ? `state=${text(context.state)}` : '',
									text(context.error_state) ? `error_state=${text(context.error_state)}` : '',
									text(context.error_message),
									text(context.run_time) ? `run_time_ms=${text(context.run_time)}` : '',
									text(context.calling_source)
										? `calling_source=${text(context.calling_source)}`
										: '',
									text(context.sys_created_on)
										? `started=${timestamp(context.sys_created_on)}`
										: '',
								].filter(Boolean);
								rows.push([
									timestamp(context.sys_updated_on ?? context.sys_created_on),
									'flow_context',
									'sys_flow_context',
									plain(context.sys_created_by),
									null,
									null,
									plain(context.state),
									capped(details.join(' | ')),
									plain(context.sys_id),
									'confirmed',
								]);
							}
						}),
					);
				}

				if (input.include.includes('runtime')) {
					tasks.push(
						collectRuntimeEvents(tableService, {
							instance: input.instance,
							since: sinceIso,
							include: input.runtimeKinds,
							recordSysId: input.recordSysId,
							limitPerSource: Math.min(input.limit, 50),
						})
							.then((runtime) => {
								let runtimeRows = 0;
								let runtimeQueries = 0;
								for (const log of objectRows(runtime.groups.logs)) {
									runtimeRows += 1;
									rows.push([
										timestamp(log.sys_created_on),
										'log',
										'syslog',
										null,
										null,
										null,
										null,
										capped(
											[text(log.level), text(log.source), text(log.message)]
												.filter(Boolean)
												.join(' | '),
										),
										plain(log.sys_id),
										'correlated',
									]);
								}
								for (const event of objectRows(runtime.groups.events)) {
									runtimeRows += 1;
									rows.push([
										timestamp(event.sys_created_on),
										'event',
										'sysevent',
										null,
										null,
										null,
										null,
										capped(
											[text(event.name), text(event.parm1), text(event.parm2)]
												.filter(Boolean)
												.join(' | '),
										),
										plain(event.sys_id),
										'confirmed',
									]);
								}
								for (const diagnostic of Object.values(runtime.diagnostics)) {
									runtimeQueries += diagnostic.queries;
								}
								diagnostics.runtime = {
									status: 'ok',
									rows: runtimeRows,
									queries: runtimeQueries,
								};
							})
							.catch((error) => {
								diagnostics.runtime = {
									status: 'unavailable',
									rows: 0,
									queries: input.runtimeKinds.length,
									error: sourceError(error),
								};
							}),
					);
				}

				await Promise.all(tasks);
				rows.sort((a, b) => {
					const direction = input.order === 'oldest_first' ? 1 : -1;
					return direction * a[0].localeCompare(b[0]);
				});
				const totalEvents = rows.length;
				const rendered = capRendered(rows, {
					maxRows: input.limit,
					maxBytes: MAX_SERIALIZED_BYTES,
					reservedBytes: Buffer.byteLength(JSON.stringify(TIMELINE_COLUMNS)),
				});
				const returned = rendered.rows;
				const unavailable = Object.entries(diagnostics)
					.filter(([, value]) => value.status === 'unavailable')
					.map(([source]) => source);

				const response: Record<string, unknown> = {
					success: true,
					table: input.tableName,
					recordSysId: input.recordSysId,
					since: sinceIso,
					record,
					columns: TIMELINE_COLUMNS,
					rows: returned,
					totalEvents,
					diagnostics,
				};
				if (rendered.truncated) {
					response.truncated = true;
					response.truncationReason = rendered.truncationReason;
				}
				if (unavailable.length > 0) {
					response.warnings = [
						`Optional evidence unavailable from: ${unavailable.join(', ')}. Absence from this timeline is not proof that no activity occurred.`,
					];
				}
				if (
					input.include.includes('flow') &&
					diagnostics.flow?.status === 'ok' &&
					diagnostics.flow.rows === 0
				) {
					const flowWarning =
						'No readable Flow Designer contexts were found in the time window. Completed contexts have limited retention, so absence is not proof that no flow ran.';
					response.warnings = [...((response.warnings as string[] | undefined) ?? []), flowWarning];
				}

				return toolResult(
					response,
					`${returned.length} timeline event(s) for ${input.tableName}/${input.recordSysId}${
						totalEvents > returned.length ? ` of ${totalEvents}` : ''
					}`,
				);
			} catch (error) {
				return toolError(error, { table: tableName, operation: 'get record timeline' });
			}
		},
	};
}
