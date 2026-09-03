/**
 * MCP tool for finding fields ACROSS tables by business concept.
 *
 * The inverse of sn_get_table_schema: that tool needs the table name up front,
 * this one finds the table by one of its fields. Kept separate from
 * sn_list_tables because a row here is a FIELD (table + column + type), not a
 * table — folding it in would make one tool's rows mean two different things.
 */

import { FindFieldsOutputSchema } from '../schemas/output-schemas.js';
import { FindFieldsSchema } from '../schemas/schema-schemas.js';
import type { SchemaService } from '../services/schema-service.js';
import { toColumnar } from '../utils/columnar.js';
import { rankItems, rankingTerms } from '../utils/discovery-ranking.js';
import { toolError } from '../utils/error-handler.js';
import { logger } from '../utils/logger.js';
import { capRendered } from '../utils/render-cap.js';
import { toolResult } from '../utils/tool-response.js';

const MAX_RETURNED_ROWS = 1000;
const MAX_SERIALIZED_BYTES = 45_000;

export const FIND_FIELDS_TOOL = {
	name: 'sn_find_fields',
	title: 'Find fields by concept',
	description: `What: Search field labels and column names ACROSS every table for a business concept, and return matching fields as table + column + type.
When to use: When you know a value exists somewhere but not which table holds it ("where is the escalation flag stored", "which table has the customer's preferred language"). This is the inverse of sn_get_table_schema, which needs the table name up front; to find a TABLE by its own name or label use sn_list_tables.
Preconditions: Read access to the dictionary.
Produces: {columns, rows} — one row per field (table, element, label, type, reference, matched); cached ~15 min in memory, up to 24h on disk. matched reports which of your keywords hit each row, so a miss tells you which variant to change.

Flow Designer's per-flow variable-pool tables (var__m_*) are always excluded: measured on a live instance they were two thirds of a result set and front-loaded, burying the genuine hits. Staging mirrors (*_ext_staging) and audit shadow tables are NOT excluded and may appear — rank them down.

Rows are RANKED by relevance (exact column/label match, then prefix, with staging/history/audit shadows demoted) — take the order as given. pagination.totalMatching says how much of the match set you are seeing, and tableDistribution shows where a broad result clusters, which often identifies the table faster than the rows themselves. Verify with sn_get_table_schema before acting on a hit: a sys_dictionary row can outlive the column it described.

Examples:
- concept=["escalat"]
- concept=["language","locale","preferred"], limit=40`,
	inputSchema: FindFieldsSchema,
	outputSchema: FindFieldsOutputSchema,
};

export function createFindFieldsTool(schemaService: SchemaService) {
	return {
		...FIND_FIELDS_TOOL,
		handler: async (params: unknown) => {
			try {
				const validated = FindFieldsSchema.parse(params);
				const target = schemaService.resolveInstance(validated.instance);

				logger.info('Finding fields by concept', {
					instance: target.name,
					instanceUrl: target.url,
					concept: validated.concept,
					limit: validated.limit,
				});

				const { fields, totalMatching } = await schemaService.findFields(
					validated.concept,
					validated.limit,
					target.name,
					validated.offset,
				);

				// Rank on the COLUMN name and label. `name` for ranking purposes is the
				// element, not the table: the caller asked for a field concept, so an
				// exact column-name hit is the strongest signal available.
				const terms = rankingTerms(undefined, validated.concept);
				const ranked = rankItems(
					fields.map((f) => ({ ...f, name: f.element })),
					terms,
				).map((r) => {
					// Drop the synthetic `name` again so the wire shape is unchanged —
					// rows stay {table, element, label, type, reference, matched}.
					const { name: _ranking, ...row } = r.item;
					return row;
				});

				const { columns, rows } = toColumnar(ranked as unknown as Record<string, unknown>[]);
				const {
					rows: renderedRows,
					truncated,
					truncationReason,
				} = capRendered(rows, {
					maxRows: MAX_RETURNED_ROWS,
					maxBytes: MAX_SERIALIZED_BYTES,
					reservedBytes: Buffer.byteLength(JSON.stringify(columns)),
				});

				const hasMore =
					totalMatching !== null
						? validated.offset + fields.length < totalMatching
						: fields.length === validated.limit;

				const response: Record<string, unknown> = {
					success: true,
					count: renderedRows.length,
					concept: validated.concept,
					instance: target.name,
					columns,
					rows: renderedRows,
					ranked: true,
					pagination: {
						limit: validated.limit,
						offset: validated.offset,
						hasMore,
						...(totalMatching !== null ? { totalMatching } : {}),
					},
				};

				// On a broad result, where the matches CLUSTER is often the real answer
				// — "40 hits, 31 of them on sys_user" points at a table far faster than
				// reading 40 individual rows. Only worth its bytes when the set is
				// genuinely broad and actually spread across tables.
				if (fields.length >= 10) {
					const counts = new Map<string, number>();
					for (const f of fields) counts.set(f.table, (counts.get(f.table) ?? 0) + 1);
					if (counts.size > 1) {
						response.tableDistribution = [...counts.entries()]
							.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
							.slice(0, 10)
							.map(([table, count]) => ({ table, fields: count }));
					}
				}

				if (truncated) {
					response.truncated = true;
					if (truncationReason) response.truncationReason = truncationReason;
				}

				// Zero results mean the keywords missed, not that the field is absent —
				// say so here, where it can still change the next call.
				if (renderedRows.length === 0) {
					response.hints = [
						`No field label or column name matched ${JSON.stringify(validated.concept)}. Try different vocabulary before concluding the field does not exist.`,
						'Try shorter word stems (escalat rather than escalation), and if the concept came from non-English input, translate it to English first — labels are English unless a language plugin is active.',
						'If the concept describes a container rather than a value, the answer may be a TABLE — try sn_list_tables with concept set to the same keywords.',
					];
				} else if (hasMore) {
					// Now says HOW MUCH is missing rather than only that something is.
					// "25 of 380" is a judgement the caller can act on; "there may be
					// more" is not.
					const scale =
						totalMatching !== null
							? `${totalMatching} fields match; this page shows ${renderedRows.length}`
							: `more fields match than this page shows`;
					response.hints = [
						`${scale}. Rows are ranked within this page only, so the best overall match may be outside it. Narrow with a sharper keyword rather than paging or raising the limit — a keyword matching hundreds of fields is usually filler.`,
					];
				}

				return toolResult(
					response,
					`${renderedRows.length} field(s) for concept ${JSON.stringify(validated.concept)}${
						truncated ? ' (truncated)' : ''
					}${renderedRows.length === 0 ? ' — see hints' : ''}`,
				);
			} catch (error) {
				logger.error('Error finding fields', error);
				return toolError(error, { operation: 'find fields' });
			}
		},
	};
}
