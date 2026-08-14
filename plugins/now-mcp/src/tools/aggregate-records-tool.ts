/**
 * MCP tool for aggregating ServiceNow records via the Stats API
 */

import { AggregateRecordsOutputSchema } from '../schemas/output-schemas.js';
import { AggregateRecordsSchema } from '../schemas/table-schemas.js';
import type { SchemaService } from '../services/schema-service.js';
import type { TableService } from '../services/table-service.js';
import { extractQueryFields } from '../utils/encoded-query.js';
import { toolError } from '../utils/error-handler.js';
import { preflightReadFieldValidation } from '../utils/field-validation.js';
import { logger } from '../utils/logger.js';
import { toolResult } from '../utils/tool-response.js';

/**
 * The Stats API has no sysparm_limit — a high-cardinality groupBy (e.g. by
 * caller_id) can return an unbounded number of groups. Same render-guardrail
 * rationale as query-records-tool: cap rows and bytes so a wide group-by can't
 * flood the response, well under the MCP host's own per-call output ceiling.
 */
const MAX_GROUP_ROWS = 2000;
const MAX_SERIALIZED_BYTES = 70_000;

function capGroups(groups: unknown[]): { rows: unknown[]; truncated: boolean } {
	let rows = groups.length > MAX_GROUP_ROWS ? groups.slice(0, MAX_GROUP_ROWS) : groups;
	let truncated = rows.length < groups.length;

	if (Buffer.byteLength(JSON.stringify(rows)) > MAX_SERIALIZED_BYTES) {
		let lo = 0;
		let hi = rows.length;
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2);
			if (Buffer.byteLength(JSON.stringify(rows.slice(0, mid))) <= MAX_SERIALIZED_BYTES) {
				lo = mid;
			} else {
				hi = mid - 1;
			}
		}
		rows = rows.slice(0, lo);
		truncated = true;
	}

	return { rows, truncated };
}

export const AGGREGATE_RECORDS_TOOL = {
	name: 'sn_aggregate_records',
	title: 'Aggregate records',
	description: `What: Compute a count, or avg/sum/min/max, over a table via the Stats API — optionally grouped by one or more fields (dot-walking supported).
When to use: For "how many", "total count", "per group", "grouped by", or numeric rollups — not when you need the actual rows (use sn_query_records for those).
Preconditions: Table must exist; the account needs read access.
Produces: Aggregate numbers (a single object, or an array of groups when groupBy is set). Far cheaper than querying rows and reducing client-side.

having filters post-aggregation (e.g. "count>5"). When grouping by a reference field (assignment_group, caller_id, …), pass displayValue=true so groups come back as names instead of sys_ids.

Field names in query/groupBy/*Fields are checked against the table schema first: ServiceNow silently ignores an unknown field in an encoded query, which would return the count for the WHOLE table as if it were the filtered count. skipFieldValidation:true aggregates as written.

Examples:
- Count P1s per group (as names): tableName="incident", query="priority=1", groupBy=["assignment_group"], count=true, displayValue=true
- Avg over a field: tableName="incident", query="active=true", avgFields=["reassignment_count"]`,
	inputSchema: AggregateRecordsSchema,
	outputSchema: AggregateRecordsOutputSchema,
};

export function createAggregateRecordsTool(
	tableService: TableService,
	schemaService?: SchemaService,
) {
	return {
		...AGGREGATE_RECORDS_TOOL,
		handler: async (params: unknown) => {
			let tableName: string | undefined;
			try {
				const v = AggregateRecordsSchema.parse(params);
				tableName = v.tableName;

				// Same silent-widening hazard as sn_query_records, with a worse payload:
				// an unknown field in `query` drops the condition, so the count comes back
				// as the whole table's — a plausible-looking number that is simply wrong.
				// A typo in groupBy collapses the grouping instead. `having` and `orderBy`
				// reference aggregates (count, avg) rather than columns, so they are not
				// checked here.
				const fieldError = await preflightReadFieldValidation(
					schemaService,
					v.tableName,
					[
						...extractQueryFields(v.query),
						...(v.groupBy ?? []),
						...(v.avgFields ?? []),
						...(v.sumFields ?? []),
						...(v.minFields ?? []),
						...(v.maxFields ?? []),
					],
					{ skip: v.skipFieldValidation, instance: v.instance },
				);
				if (fieldError) {
					return {
						content: [{ type: 'text' as const, text: fieldError }],
						isError: true as const,
					};
				}

				logger.info(`Aggregating ${v.tableName}`, {
					query: v.query,
					groupBy: v.groupBy,
					count: v.count,
				});

				const startedAt = Date.now();
				const result = await tableService.aggregateRecords(
					v.tableName,
					{
						query: v.query,
						count: v.count,
						groupBy: v.groupBy,
						avgFields: v.avgFields,
						sumFields: v.sumFields,
						minFields: v.minFields,
						maxFields: v.maxFields,
						having: v.having,
						orderBy: v.orderBy,
						displayValue: v.displayValue,
					},
					v.instance,
				);
				const durationMs = Date.now() - startedAt;

				const grouped = Boolean(v.groupBy && v.groupBy.length > 0);

				// The Stats API has no row limit — a high-cardinality groupBy could
				// return an unbounded number of groups, so cap what's rendered same as
				// query-records-tool's render guardrail.
				let renderedResult = result;
				let truncated = false;
				let fetchedGroups: number | undefined;
				if (grouped && Array.isArray(result)) {
					fetchedGroups = result.length;
					const capped = capGroups(result);
					renderedResult = capped.rows;
					truncated = capped.truncated;
				}

				const response: Record<string, unknown> = {
					success: true,
					table: v.tableName,
					grouped,
					result: renderedResult,
				};
				if (truncated) {
					response.truncated = true;
					response.returnedGroups = (renderedResult as unknown[]).length;
					response.fetchedGroups = fetchedGroups;
				}

				// rowCount is only meaningful for a grouped result (one row per group);
				// a single rollup has no row count, so omit it then.
				const meta: Record<string, unknown> = {
					instance: v.instance || 'default',
					durationMs,
				};
				if (grouped && Array.isArray(renderedResult)) {
					meta.rowCount = renderedResult.length;
				}

				const returnedGroupCount = Array.isArray(renderedResult) ? renderedResult.length : 0;
				const summary = grouped
					? `${returnedGroupCount} group(s) on ${v.tableName}${truncated ? ' (truncated)' : ''}`
					: `aggregate on ${v.tableName}`;
				return toolResult(response, summary, {
					meta,
					extraText: truncated
						? [
								`Note: the result was truncated — showing ${returnedGroupCount} of ${fetchedGroups} groups ` +
									`(render cap ${MAX_GROUP_ROWS} groups / ${MAX_SERIALIZED_BYTES} bytes). ` +
									`Narrow the query, add a having filter, or group by a lower-cardinality field to see the rest.`,
							]
						: undefined,
				});
			} catch (error) {
				logger.error('Error aggregating records', error);
				return toolError(error, { table: tableName, operation: 'aggregate' });
			}
		},
	};
}
