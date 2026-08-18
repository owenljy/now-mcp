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
import { capRendered } from '../utils/render-cap.js';
import { toolResult } from '../utils/tool-response.js';

/**
 * The Stats API has no sysparm_limit — a high-cardinality groupBy (e.g. by
 * caller_id) can return an unbounded number of groups. Same render-guardrail
 * rationale as query-records-tool: cap rows and bytes so a wide group-by can't
 * flood the response, well under the MCP host's own per-call output ceiling.
 */
const MAX_GROUP_ROWS = 2000;
const MAX_SERIALIZED_BYTES = 70_000;

/** One group per row is strictly worse than the row query it replaced. */
const UNIQUE_COLUMNS = new Set(['sys_id', 'number', 'sys_created_on', 'sys_updated_on']);

/**
 * having/orderBy are calibrated, not maximal: ServiceNow's full sysparm_having
 * grammar can't be verified from this repo, so this is deliberately not a
 * strict regex on the whole expression. It only checks the one unambiguous
 * signal — the value names an aggregate function — because a bare column
 * comparison (e.g. "priority>3") is silently ignored or misapplied and almost
 * always means the caller meant `query`, not `having`.
 */
const AGGREGATE_FN_RE = /(count|avg|sum|min|max)/i;

function namesRequestedAggregate(
	expr: string,
	v: {
		count?: boolean;
		avgFields?: string[];
		sumFields?: string[];
		minFields?: string[];
		maxFields?: string[];
	},
): boolean {
	const lower = expr.toLowerCase();
	if (v.count && lower.includes('count')) return true;
	if (v.avgFields?.length && lower.includes('avg')) return true;
	if (v.sumFields?.length && lower.includes('sum')) return true;
	if (v.minFields?.length && lower.includes('min')) return true;
	if (v.maxFields?.length && lower.includes('max')) return true;
	return false;
}

export const AGGREGATE_RECORDS_TOOL = {
	name: 'sn_aggregate_records',
	title: 'Aggregate records',
	description: `What: Compute a count, or average/sum/min/max (avg/sum/min/max), over a table via the Stats API — optionally grouped by one or more fields (dot-walking supported).
When to use: Reach for this BEFORE sn_query_records whenever the question is how many, total, count, average, per group, grouped by, breakdown, top N, or the distribution of the values a column takes — anything answerable with numbers rather than the rows themselves. Not when you need the actual row data.
Preconditions: Table must exist; read access. groupBy on a column unique per row (sys_id, number, sys_created_on, sys_updated_on) is blocked — one group per row beats nothing.
Produces: Aggregate numbers (a single object, or an array of groups when groupBy is set). Far cheaper than querying rows and reducing client-side.

topGroups:N returns only the top N groups, ordered by count (or your orderBy) — shapes the RESPONSE, not the database scan, since the Stats API has no row limit. having filters post-aggregation and must name the aggregate you requested (e.g. "count>5"); it is not a row filter — that's query. When grouping by a reference field (assignment_group, caller_id, …), pass displayValue=true for names instead of sys_ids.

Field names in query/groupBy/*Fields are checked against the table schema first: ServiceNow silently ignores an unknown field in an encoded query, which would return the count for the WHOLE table as if it were the filtered count. skipFieldValidation:true aggregates as written.

Examples:
- Count P1s per group (as names): tableName="incident", query="priority=1", groupBy=["assignment_group"], count=true, displayValue=true
- Distribution of a column's values: tableName="incident", groupBy=["state"], count=true
- Top 5 assignment groups by volume: tableName="incident", groupBy=["assignment_group"], count=true, topGroups=5, displayValue=true
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

				const uniqueGroupBy = v.groupBy?.find((f) => UNIQUE_COLUMNS.has(f));
				if (uniqueGroupBy) {
					return {
						content: [
							{
								type: 'text' as const,
								text: `groupBy:["${uniqueGroupBy}"] groups by a column that's unique per row — one group per row is strictly worse than the sn_query_records call it replaced. Group by a lower-cardinality field instead, or use sn_query_records if you need the individual rows.`,
							},
						],
						isError: true as const,
					};
				}

				if (v.having && !AGGREGATE_FN_RE.test(v.having)) {
					return {
						content: [
							{
								type: 'text' as const,
								text: `having:"${v.having}" does not name an aggregate function (count|avg|sum|min|max) — having filters post-AGGREGATION, not rows. You probably meant query:"${v.having}". Escape hatch: skipFieldValidation:true runs it as written.`,
							},
						],
						isError: true as const,
					};
				}
				if (v.having && !v.skipFieldValidation && !namesRequestedAggregate(v.having, v)) {
					return {
						content: [
							{
								type: 'text' as const,
								text: `having:"${v.having}" names an aggregate that was not actually requested (check count/avgFields/sumFields/minFields/maxFields) — it would be silently ignored or misapplied. Escape hatch: skipFieldValidation:true runs it as written.`,
							},
						],
						isError: true as const,
					};
				}

				if (v.topGroups !== undefined) {
					if (!v.count && !v.orderBy) {
						return {
							content: [
								{
									type: 'text' as const,
									text: 'topGroups needs an ordering criterion — set orderBy explicitly, or leave count:true (its default) so "top" defaults to DESCcount.',
								},
							],
							isError: true as const,
						};
					}
				}
				// Defaulting is gated strictly on topGroups being set — it must never
				// change behavior for an existing groupBy+count call that didn't ask
				// for a top-N slice.
				const effectiveOrderBy =
					v.topGroups !== undefined && !v.orderBy && v.count ? 'DESCcount' : v.orderBy;

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
						orderBy: effectiveOrderBy,
						displayValue: v.displayValue,
					},
					v.instance,
				);
				const durationMs = Date.now() - startedAt;

				const grouped = Boolean(v.groupBy && v.groupBy.length > 0);

				// topGroups shapes the RESPONSE, not the database scan — the Stats API
				// has no sysparm_limit, so this slices the already-fetched array.
				// totalGroups records the true pre-slice count so the caller knows
				// what it didn't see.
				let totalGroups: number | undefined;
				let workingResult = result;
				if (grouped && Array.isArray(result) && v.topGroups !== undefined) {
					totalGroups = result.length;
					workingResult = result.slice(0, v.topGroups);
				}

				// The Stats API has no row limit — a high-cardinality groupBy could
				// return an unbounded number of groups, so cap what's rendered same as
				// query-records-tool's render guardrail.
				let renderedResult = workingResult;
				let truncated = false;
				let fetchedGroups: number | undefined;
				if (grouped && Array.isArray(workingResult)) {
					fetchedGroups = workingResult.length;
					const capped = capRendered(workingResult, {
						maxRows: MAX_GROUP_ROWS,
						maxBytes: MAX_SERIALIZED_BYTES,
					});
					renderedResult = capped.rows;
					truncated = capped.truncated;
				}

				const response: Record<string, unknown> = {
					success: true,
					table: v.tableName,
					grouped,
					result: renderedResult,
				};
				if (totalGroups !== undefined) {
					response.totalGroups = totalGroups;
				}
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
				// Read the ungrouped rollup's own count off the Stats API's
				// {stats:{count:"27"}} shape so the summary line alone carries the
				// answer, rather than making the caller open structuredContent for it.
				const ungroupedCount =
					!grouped &&
					renderedResult &&
					typeof renderedResult === 'object' &&
					'stats' in (renderedResult as Record<string, unknown>)
						? (renderedResult as { stats?: { count?: unknown } }).stats?.count
						: undefined;
				const summary = grouped
					? `${returnedGroupCount} group(s) on ${v.tableName}${truncated ? ' (truncated)' : ''}`
					: ungroupedCount !== undefined
						? `count=${ungroupedCount} on ${v.tableName}`
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
