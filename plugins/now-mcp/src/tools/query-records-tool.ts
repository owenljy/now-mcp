/**
 * MCP tool for querying ServiceNow records
 */

import { QueryRecordsOutputSchema } from '../schemas/output-schemas.js';
import { QueryRecordsSchema } from '../schemas/table-schemas.js';
import { type GraphqlService, GraphqlUnavailableError } from '../services/graphql-service.js';
import type { SchemaService } from '../services/schema-service.js';
import type { TableService } from '../services/table-service.js';
import { ServiceNowError } from '../types/errors.js';
import { extractQueryFields } from '../utils/encoded-query.js';
import { toolError } from '../utils/error-handler.js';
import { zeroResultHints } from '../utils/failure-enrichment.js';
import { preflightReadFieldValidation } from '../utils/field-validation.js';
import { logger } from '../utils/logger.js';
import { assessQueryRisk } from '../utils/query-risk.js';
import { capRendered } from '../utils/render-cap.js';
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

export const QUERY_RECORDS_TOOL = {
	name: 'sn_query_records',
	title: 'Query records',
	description: `What: List/fetch/read the actual record rows from a ServiceNow table, with filters, field selection, dot-walking, and pagination.
When to use: To retrieve the rows themselves — show me / fetch / find matching records. For counts, group-by, or avg/sum/min/max use sn_aggregate_records instead.
Preconditions: Table must exist; the account needs read access to it.
Produces: An array of the matching records (plus pagination metadata, and recovery hints when empty).

Encoded query goes in the query param (operators: = != ^ ^OR > < >= <= LIKE STARTSWITH ENDSWITH IN ISEMPTY ISNOTEMPTY; dot-walk reference fields, e.g. caller_id.department.name=Network).

Field names in query/fields are checked against the table schema first, because ServiceNow SILENTLY IGNORES an unknown field in an encoded query — priorityy=1 returns the whole table with HTTP 200 and no error. A typo is reported here instead of quietly widening the result; skipFieldValidation:true runs the query as written.

Journal fields (comments, work_notes) read back EMPTY unless displayValue is set — the entry stream with timestamps and authors only exists in the display value. Use displayValue:"all" to get them.

expand pulls fields from referenced records in one request, e.g. expand={"caller_id":["name","email"]} — one level deep, and requires fields to be listed.

A 403 is auto-diagnosed against the table's web-service access flag, so the returned hint distinguishes "this table blocks all REST access regardless of role" from "your account lacks the required role/ACL" — trust that hint over re-investigating roles manually.

Examples:
- tableName="incident", query="priority=1^state=2", fields=["number","short_description"]
- Pagination: limit=50, offset=100 (response.pagination.hasMore / totalMatching guide the next page)`,
	inputSchema: QueryRecordsSchema,
	outputSchema: QueryRecordsOutputSchema,
};

export function createQueryRecordsTool(
	tableService: TableService,
	schemaService: SchemaService,
	graphqlService?: GraphqlService,
) {
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

				const expand = validated.expand;

				// Pre-flight the field names. This is the read-path counterpart to the
				// write tools' check, and it matters more here: an unknown field in a
				// WRITE payload is dropped from that payload, but an unknown field in an
				// encoded query drops the whole CONDITION — the read silently widens to
				// the entire table and still reports success.
				const referencedFields = [
					...extractQueryFields(validated.query),
					...(validated.fields ?? []),
					...Object.keys(expand ?? {}),
				];
				const fieldError = await preflightReadFieldValidation(
					schemaService,
					validated.tableName,
					referencedFields,
					{ skip: validated.skipFieldValidation, instance: validated.instance },
				);
				if (fieldError) {
					return {
						content: [{ type: 'text' as const, text: fieldError }],
						isError: true as const,
					};
				}

				const warnings: string[] = [];

				// Journal columns return "" in `value` and put the whole entry stream in
				// `display_value`, so the default displayValue:false turns "read the work
				// notes" into "there are no work notes". Warn rather than silently
				// overriding the caller's argument.
				if (validated.displayValue === false && validated.fields?.length) {
					const journalFields = await schemaService.journalFieldsAmong(
						validated.tableName,
						validated.fields,
						validated.instance,
					);
					if (journalFields.length > 0) {
						warnings.push(
							`${journalFields.join(', ')} ${journalFields.length === 1 ? 'is a journal field' : 'are journal fields'} — ` +
								`the value read back is EMPTY even when entries exist. An empty result here does NOT mean ` +
								`there are no comments/work notes. Re-run with displayValue:"all" to get the entry stream ` +
								`(timestamps, authors, text).`,
						);
					}
				}

				logger.info(`Querying ${validated.tableName}`, {
					query: validated.query,
					limit: validated.limit,
					offset: validated.offset,
					expand: expand ? Object.keys(expand) : undefined,
				});

				// Query records
				const startedAt = Date.now();
				// Initialized empty so the compiler can see them as assigned; one of the
				// two branches below always overwrites both.
				let records: Record<string, unknown>[] = [];
				let totalCount: number | null = null;
				let fallbackHasMore: boolean | undefined;
				let source: string | undefined;
				let fallbackProfile: string | undefined;
				let transport = 'table-api';

				const graphqlPlan = expand && graphqlService ? expand : undefined;
				let usedGraphql = false;

				if (graphqlPlan) {
					if (!validated.fields || validated.fields.length === 0) {
						return {
							content: [
								{
									type: 'text' as const,
									text:
										'expand requires fields to be listed: GraphQL has no "select every column", ' +
										'so name the base fields you want alongside the expanded reference(s).',
								},
							],
							isError: true as const,
						};
					}
					try {
						const gql = await (graphqlService as GraphqlService).queryRecords(
							validated.tableName,
							{
								query: validated.query,
								limit: validated.limit,
								offset: validated.offset,
								fields: validated.fields,
								displayValue: validated.displayValue,
								expand: graphqlPlan,
							},
							validated.instance,
						);
						records = gql.records as Record<string, unknown>[];
						totalCount = gql.totalCount;
						transport = 'graphql';
						usedGraphql = true;
					} catch (error) {
						if (!(error instanceof GraphqlUnavailableError)) throw error;
						logger.warn('GraphQL expand unavailable — falling back to dot-walked fields', {
							table: validated.tableName,
							error: error.message,
						});
						warnings.push(
							`expand fell back to the Table API (${error.message}) — the referenced fields are ` +
								`returned FLAT as dot-walked columns (e.g. "caller_id.name"), not nested under the ` +
								`reference field.`,
						);
					}
				}

				if (!usedGraphql) {
					// Dot-walked equivalents of `expand`, for the Table API path.
					const dotWalked = expand
						? Object.entries(expand).flatMap(([ref, subs]) => subs.map((sub) => `${ref}.${sub}`))
						: [];
					const requestFields =
						validated.fields && dotWalked.length > 0
							? [...validated.fields, ...dotWalked]
							: validated.fields;

					const result = await tableService.queryRecordsWithMeta(
						validated.tableName,
						{
							query: validated.query,
							limit: validated.limit,
							offset: validated.offset,
							fields: requestFields,
							displayValue: validated.displayValue,
							excludeReferenceLink: validated.excludeReferenceLink,
						},
						validated.instance,
					);
					records = result.records as Record<string, unknown>[];
					totalCount = result.totalCount;
					fallbackHasMore = result.hasMore;
					source = result.source;
					fallbackProfile = result.fallbackProfile;
				}
				const durationMs = Date.now() - startedAt;

				// fetchedCount = rows in this page; totalMatching = rows matching the
				// query across all pages (from X-Total-Count or GraphQL _rowCount, null
				// if not reported).
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
				const {
					rows: renderedRows,
					truncated: rowsTruncated,
					truncationReason: rowsTruncationReason,
				} = capRendered(fieldCappedRecords, {
					maxRows: MAX_RETURNED_ROWS,
					maxBytes: MAX_SERIALIZED_BYTES,
				});
				const truncated = rowsTruncated || fieldsTruncated;
				// A byte/row cap on the rows array takes priority over a cell-level cap
				// for naming *why* truncation happened; only report cell_chars when the
				// row/byte cap itself never fired.
				const truncationReason =
					rowsTruncationReason ?? (fieldsTruncated ? 'cell_chars' : undefined);

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
					transport,
				};

				// Signal truncation explicitly so the caller can narrow the query
				// instead of silently losing rows/data.
				if (truncated) {
					response.truncated = true;
					response.returnedRows = renderedRows.length;
					response.fetchedRows = fetchedCount;
					if (truncationReason) response.truncationReason = truncationReason;
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

				if (warnings.length > 0) {
					response.warnings = warnings;
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
					const reasonNote =
						rowsTruncationReason === 'row_count'
							? `row-count cap of ${MAX_RETURNED_ROWS} rows`
							: `byte cap of ${MAX_SERIALIZED_BYTES} bytes`;
					extraTextParts.push(
						`Note: the result was truncated — showing ${renderedRows.length} of ${fetchedCount} fetched rows ` +
							`(hit the ${reasonNote}). ` +
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
				// Journal/expand warnings are surfaced as their own text block too: a
				// caller that reads only the summary would otherwise act on an empty
				// journal value as if it meant "no comments".
				extraTextParts.push(...warnings);
				const extraText = extraTextParts.length > 0 ? extraTextParts : undefined;

				// _meta carries only genuinely result-level fields (WS-B §4.2); counts and
				// truncation flags already live in the body, so they are not duplicated here.
				return toolResult(response, summary, {
					meta: {
						instance: validated.instance || 'default',
						durationMs,
						transport,
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
