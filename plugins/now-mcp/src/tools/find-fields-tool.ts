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

Ranking is yours to do — the instance returns no relevance order. A field on a widely-used base table (task, incident) usually outranks the same label on a leaf config table. Verify with sn_get_table_schema before acting on a hit: a sys_dictionary row can outlive the column it described.

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

				const { fields } = await schemaService.findFields(
					validated.concept,
					validated.limit,
					target.name,
				);

				const { columns, rows } = toColumnar(fields as unknown as Record<string, unknown>[]);
				const {
					rows: renderedRows,
					truncated,
					truncationReason,
				} = capRendered(rows, {
					maxRows: MAX_RETURNED_ROWS,
					maxBytes: MAX_SERIALIZED_BYTES,
					reservedBytes: Buffer.byteLength(JSON.stringify(columns)),
				});

				const response: Record<string, unknown> = {
					success: true,
					count: renderedRows.length,
					concept: validated.concept,
					instance: target.name,
					columns,
					rows: renderedRows,
				};
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
				} else if (renderedRows.length >= validated.limit) {
					response.hints = [
						`Hit the ${validated.limit}-row limit, so this is a truncated slice of a larger match set and the best candidate may not be in it. Narrow with a sharper keyword rather than raising the limit — a keyword matching hundreds of fields is usually filler.`,
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
