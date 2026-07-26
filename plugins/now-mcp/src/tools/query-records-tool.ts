/**
 * MCP tool for querying ServiceNow records
 */

import { QueryRecordsOutputSchema } from '../schemas/output-schemas.js';
import { QueryRecordsSchema } from '../schemas/table-schemas.js';
import type { SchemaService } from '../services/schema-service.js';
import type { TableService } from '../services/table-service.js';
import { ServiceNowError } from '../types/errors.js';
import { toolError } from '../utils/error-handler.js';
import { zeroResultHints } from '../utils/failure-enrichment.js';
import { logger } from '../utils/logger.js';
import { assessQueryRisk } from '../utils/query-risk.js';
import { toolResult, toolText } from '../utils/tool-response.js';
import { truncateRecordFields } from '../utils/value-truncation.js';

/**
 * Render guardrail — independent of the requested `limit` (which the schema caps
 * at 10000). A single response that dumps thousands of rows floods the caller's
 * context, so we cap the rows *actually returned* to the client and also cap the
 * serialized JSON size. Whichever cap bites first truncates `records`; the
 * truncation is signaled explicitly (structuredContent.truncated + _meta) and in
 * a human note so the caller can narrow the query instead of silently losing rows.
 *
 * The byte cap must stay well under the MCP host's own per-call output ceiling
 * (Claude Code defaults to ~25k tokens), not just "reasonably small" — dense
 * content (JSON, stack traces, log lines) tokenizes at ~2-3 chars/token rather
 * than the ~4 chars/token of English prose, so a naive byte budget sized for
 * prose can still blow the host limit. 70,000 bytes leaves comfortable margin
 * even at the worst-case ratio.
 */
const MAX_RETURNED_ROWS = 1000;
const MAX_SERIALIZED_BYTES = 70_000;
/** Per-field cap applied before the row/byte cap — one oversized field (e.g. a
 * syslog `message`) shouldn't be able to eat the whole byte budget by itself
 * and starve out every other row. */
const MAX_FIELD_VALUE_CHARS = 3000;

/**
 * Cap `records` by row count and serialized size. Returns the (possibly
 * shortened) array plus whether truncation happened. Pure — no side effects.
 */
function capRenderedRows(records: Record<string, unknown>[]): {
	rows: Record<string, unknown>[];
	truncated: boolean;
} {
	// Row-count cap first (cheap), then size cap on the survivors.
	let rows = records.length > MAX_RETURNED_ROWS ? records.slice(0, MAX_RETURNED_ROWS) : records;
	let truncated = rows.length < records.length;

	if (Buffer.byteLength(JSON.stringify(rows)) > MAX_SERIALIZED_BYTES) {
		// Binary search for the largest prefix that fits the byte budget.
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

export const QUERY_RECORDS_TOOL = {
	name: 'sn_query_records',
	title: 'Query records',
	description: `What: List/fetch/read the actual record rows from a ServiceNow table, with filters, field selection, dot-walking, and pagination.
When to use: To retrieve the rows themselves — show me / fetch / find matching records. For counts, group-by, or avg/sum/min/max use sn_aggregate_records instead.
Preconditions: Table must exist; the account needs read access to it.
Produces: An array of the matching records (plus pagination metadata, and recovery hints when empty).

Encoded query goes in the query param (operators: = != ^ ^OR > < >= <= LIKE STARTSWITH ENDSWITH IN ISEMPTY ISNOTEMPTY; dot-walk reference fields, e.g. caller_id.department.name=Network).

A 403 is auto-diagnosed against the table's web-service access flag, so the returned hint distinguishes "this table blocks all REST access regardless of role" from "your account lacks the required role/ACL" — trust that hint over re-investigating roles manually.

Examples:
- tableName="incident", query="priority=1^state=2", fields=["number","short_description"]
- Pagination: limit=50, offset=100 (response.pagination.hasMore / totalMatching guide the next page)`,
	inputSchema: QueryRecordsSchema,
	outputSchema: QueryRecordsOutputSchema,
};

export function createQueryRecordsTool(tableService: TableService, schemaService: SchemaService) {
	return {
		...QUERY_RECORDS_TOOL,
		handler: async (params: unknown) => {
			let tableName: string | undefined;
			let instance: string | undefined;
			try {
				// Validate input
				const validated = QueryRecordsSchema.parse(params);
				tableName = validated.tableName;
				instance = validated.instance;
				const risk = assessQueryRisk(validated.tableName, validated.query);
				if (validated.queryPolicy === 'safe' && risk.risky) {
					const blocked = {
						blocked: true,
						reason: 'Query blocked by the safe query policy before it was sent to ServiceNow.',
						table: validated.tableName,
						reasons: risk.reasons,
						suggestedQuery: risk.suggestion,
						hint: "Narrow the time window or set queryPolicy:'allow_expensive' to explicitly accept the scan risk.",
					};
					return {
						content: [{ type: 'text' as const, text: toolText(blocked) }],
						isError: true as const,
					};
				}

				logger.info(`Querying ${validated.tableName}`, {
					query: validated.query,
					limit: validated.limit,
					offset: validated.offset,
				});

				// Query records
				const startedAt = Date.now();
				const {
					records,
					totalCount,
					hasMore: fallbackHasMore,
					source,
					fallbackProfile,
				} = await tableService.queryRecordsWithMeta(
					validated.tableName,
					{
						query: validated.query,
						limit: validated.limit,
						offset: validated.offset,
						fields: validated.fields,
						displayValue: validated.displayValue,
						excludeReferenceLink: validated.excludeReferenceLink,
					},
					validated.instance,
				);
				const durationMs = Date.now() - startedAt;

				// fetchedCount = rows in this page; totalMatching = rows matching the
				// query across all pages (from X-Total-Count, null if not reported).
				const fetchedCount = records.length;
				const totalMatching = totalCount;

				// Per-field cap first: one oversized value (e.g. a syslog `message`)
				// shouldn't consume the whole byte budget and starve out other rows.
				const { records: fieldCappedRecords, truncated: fieldsTruncated } = truncateRecordFields(
					records,
					MAX_FIELD_VALUE_CHARS,
				);

				// Render guardrail: cap the rows that actually reach the caller,
				// independent of the requested `limit`, so a huge result can't flood the
				// client context. `renderedRows` is what we serialize.
				const { rows: renderedRows, truncated: rowsTruncated } =
					capRenderedRows(fieldCappedRecords);
				const truncated = rowsTruncated || fieldsTruncated;

				// hasMore: prefer the exact answer from the total count (are there rows
				// beyond this page's offset+size?); fall back to the page-size heuristic
				// when the instance didn't return X-Total-Count.
				const hasMore =
					fallbackHasMore ??
					(totalMatching !== null
						? validated.offset + fetchedCount < totalMatching
						: fetchedCount === validated.limit);

				// Format response for LLM
				const response: Record<string, unknown> = {
					success: true,
					table: validated.tableName,
					count: fetchedCount, // rows returned in this page
					records: renderedRows,
					pagination: {
						limit: validated.limit,
						offset: validated.offset,
						hasMore,
						...(totalMatching !== null ? { totalMatching } : {}),
					},
				};

				// Signal truncation explicitly so the caller can narrow the query
				// instead of silently losing rows/data.
				if (truncated) {
					response.truncated = true;
					response.returnedRows = renderedRows.length;
					response.fetchedRows = fetchedCount;
				}
				if (fieldsTruncated) {
					response.fieldsTruncated = true;
				}

				// Enrich an empty result set with recovery hints.
				if (records.length === 0) {
					response.hints = zeroResultHints({
						table: validated.tableName,
						query: validated.query,
					});
				}

				// Thin text summary; the rows live in structuredContent (which the caller
				// receives) so we don't pay for the payload twice. The render guardrail
				// above already capped what goes into `records`.
				const totalNote = totalMatching !== null ? ` of ${totalMatching} matching` : '';
				const summary = `${fetchedCount} row(s)${totalNote} on ${validated.tableName}${
					rowsTruncated ? ` (truncated to ${renderedRows.length})` : ''
				}${fieldsTruncated ? ' (some field values truncated)' : ''}${
					records.length === 0 ? ' — see hints' : ''
				}`;

				const extraTextParts: string[] = [];
				if (rowsTruncated) {
					extraTextParts.push(
						`Note: the result was truncated — showing ${renderedRows.length} of ${fetchedCount} fetched rows ` +
							`(render cap ${MAX_RETURNED_ROWS} rows / ${MAX_SERIALIZED_BYTES} bytes). ` +
							`Narrow the query to see the rest: add filters, select fewer fields, or use sn_aggregate_records for counts/group-by.`,
					);
				}
				if (fieldsTruncated) {
					extraTextParts.push(
						`Note: one or more field values exceeded ${MAX_FIELD_VALUE_CHARS} chars and were truncated ` +
							`(marked "…[truncated N chars]"). Select fewer/narrower fields, or fetch the full value for a ` +
							`specific record another way (e.g. a targeted background script) if you need it in full.`,
					);
				}
				const extraText = extraTextParts.length > 0 ? extraTextParts : undefined;

				// _meta carries only genuinely result-level fields (WS-B §4.2); counts and
				// truncation flags already live in the body, so they are not duplicated here.
				return toolResult(response, summary, {
					meta: {
						instance: validated.instance || 'default',
						durationMs,
						...(source ? { source } : {}),
						...(fallbackProfile ? { fallbackProfile } : {}),
					},
					extraText,
				});
			} catch (error) {
				logger.error('Error querying records', error);
				const wsAccess = await probeWebServiceAccess(error, tableName, instance, schemaService);
				return toolError(error, {
					table: tableName,
					query: undefined,
					operation: 'query',
					wsAccess,
				});
			}
		},
	};
}

/**
 * On a genuine server-side 403 (not the client-side SERVICENOW_BLOCKED_TABLES/
 * ALLOWED_TABLES check, which already carries its own precise hint), probe
 * whether the table's web-service access is disabled — the actual cause of a
 * whole class of 403s that have nothing to do with roles/ACLs. Best-effort:
 * any failure of the probe itself falls back to 'unknown' so it never masks
 * the original error.
 */
async function probeWebServiceAccess(
	error: unknown,
	tableName: string | undefined,
	instance: string | undefined,
	schemaService: SchemaService,
): Promise<'disabled' | 'enabled' | 'unknown'> {
	if (!tableName) return 'unknown';
	if (!(error instanceof ServiceNowError) || error.statusCode !== 403) return 'unknown';
	const details = error.servicenowError as { operationType?: string } | undefined;
	if (details?.operationType === 'table-access') return 'unknown';

	try {
		const result = await schemaService.checkWebServiceAccess(tableName, instance);
		if (!result?.exists) return 'unknown';
		return result.wsAccess ? 'enabled' : 'disabled';
	} catch {
		return 'unknown';
	}
}
