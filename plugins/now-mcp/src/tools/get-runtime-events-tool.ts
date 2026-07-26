import {
	GetRuntimeEventsOutputSchema,
	GetRuntimeEventsSchema,
} from '../schemas/runtime-diagnostic-schemas.js';
import type { TableService } from '../services/table-service.js';
import { toolError } from '../utils/error-handler.js';
import { toolResult } from '../utils/tool-response.js';

const CONFIG = {
	logs: { table: 'syslog', fields: ['sys_id', 'sys_created_on', 'level', 'source', 'message'] },
	triggers: {
		table: 'sys_trigger',
		fields: ['sys_id', 'sys_created_on', 'name', 'next_action', 'state'],
	},
	events: {
		table: 'sysevent',
		fields: ['sys_id', 'sys_created_on', 'name', 'instance', 'parm1', 'parm2', 'state'],
	},
} as const;

function encode(value: string): string {
	return value.replace(/\^/g, '');
}

export const GET_RUNTIME_EVENTS_TOOL = {
	name: 'sn_get_runtime_events',
	title: 'Get bounded runtime events',
	description: `Read-only, bounded observability across recent syslog, sys_trigger, and sysevent rows. A time bound is mandatory and each message term is queried separately to avoid broad OR scans. Results are evidence, not proof of absence: trigger rows are ephemeral and readable logs may be incomplete.`,
	inputSchema: GetRuntimeEventsSchema,
	outputSchema: GetRuntimeEventsOutputSchema,
};

export function createGetRuntimeEventsTool(tableService: TableService) {
	return {
		...GET_RUNTIME_EVENTS_TOOL,
		handler: async (params: unknown) => {
			try {
				const input = GetRuntimeEventsSchema.parse(params);
				const since = input.since
					? new Date(input.since)
					: new Date(Date.now() - (input.lookbackMinutes as number) * 60_000);
				const lowerBound = since.toISOString().slice(0, 19).replace('T', ' ');
				const groups: Record<string, Record<string, unknown>[]> = {};
				const diagnostics: Record<string, Record<string, unknown>> = {};

				for (const kind of input.include) {
					const config = CONFIG[kind];
					const common = [`sys_created_on>=${lowerBound}`];
					if (input.recordSysId && kind === 'events') common.push(`instance=${input.recordSysId}`);
					if (input.recordSysId && kind === 'logs') common.push(`messageLIKE${input.recordSysId}`);
					if (input.operationId && kind === 'logs')
						common.push(`messageNOT LIKE${encode(input.operationId)}`);
					if (kind === 'logs' && input.sources?.length)
						common.push(`sourceIN${input.sources.map(encode).join(',')}`);
					if (kind === 'logs' && input.levels?.length)
						common.push(`levelIN${input.levels.map(encode).join(',')}`);
					if (kind === 'triggers' && input.triggerNameContains)
						common.push(`nameLIKE${encode(input.triggerNameContains)}`);
					const terms =
						kind === 'logs' && input.messageContains?.length ? input.messageContains : [undefined];
					const unique = new Map<string, Record<string, unknown>>();
					for (const term of terms) {
						const query = [
							...common,
							...(term ? [`messageLIKE${encode(term)}`] : []),
							'ORDERBYDESCsys_created_on',
						].join('^');
						const { records } = await tableService.queryRecordsWithMeta(
							config.table,
							{
								query,
								fields: [...config.fields],
								limit: input.limitPerSource,
								offset: 0,
								displayValue: false,
								excludeReferenceLink: true,
							},
							input.instance,
						);
						for (const row of records) unique.set(String(row.sys_id ?? JSON.stringify(row)), row);
					}
					groups[kind] = [...unique.values()].slice(0, input.limitPerSource);
					diagnostics[kind] = {
						table: config.table,
						rows: groups[kind].length,
						bounded: true,
						separateMessageQueries: terms.length,
					};
				}

				const response = {
					success: true,
					since: since.toISOString(),
					groups,
					diagnostics,
					evidenceLimitations: [
						'No trigger row may mean completed-and-deleted, never queued, inaccessible, or outside the time window.',
						'No matching log means only that no matching readable row was found.',
						'Direct invocation isolates a dependency; it does not prove a Business Rule or flow trigger path ran.',
					],
				};
				return toolResult(response, `bounded runtime diagnostics since ${response.since}`);
			} catch (error) {
				return toolError(error, { operation: 'get runtime events' });
			}
		},
	};
}
