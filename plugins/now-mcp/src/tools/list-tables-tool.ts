/**
 * MCP tool for listing available ServiceNow tables
 */

import { ListTablesOutputSchema } from '../schemas/output-schemas.js';
import { ListTablesSchema } from '../schemas/schema-schemas.js';
import type { SchemaService } from '../services/schema-service.js';
import { toColumnar } from '../utils/columnar.js';
import { toolError } from '../utils/error-handler.js';
import { logger } from '../utils/logger.js';
import { capRendered } from '../utils/render-cap.js';
import { toolResult } from '../utils/tool-response.js';

const MAX_RETURNED_ROWS = 1000;
const MAX_SERIALIZED_BYTES = 45_000;

export const LIST_TABLES_TOOL = {
	name: 'sn_list_tables',
	title: 'List tables',
	description: `What: List tables in the instance — by name fragment (filter) when you know part of the name, or by business concept (concept) when you only know what the table is FOR.
When to use: To discover which table to use. For a single table's fields use sn_get_table_schema; to find a table by one of its FIELDS use sn_find_fields.
Preconditions: Read access to the dictionary.
Produces: {columns, rows} — one row per table (name, label, parent table, scope, and matched on a concept search); cached ~15 min in memory, up to 24h on disk. scope is only present for scoped-app/custom tables (e.g. "x_acme_myapp") — absent means global/OOB.

filter matches the NAME: trailing * = starts-with (incident*), leading * = ends-with (*task), both/neither = substring (*task*, task).

concept matches the LABEL and the NAME, for when name matching has nothing to bite on ("the table behind this chat panel"). Keywords are OR'd; combining filter and concept ANDs them. The matched column reports which of your keywords hit each row, so a miss tells you which variant to change.

Ranking is yours to do — the instance returns no relevance order. Prefer Global/core scope over an unrelated store app, prefer the base table over its satellites (check the parent column), and prefer an exactly-matching label over an incidental one.

Examples:
- All tables (first 100): no parameters
- Starts with: filter="incident*"
- Substring, capped: filter="*task*", limit=50
- By concept: concept=["chat","conversation","messaging"]`,
	inputSchema: ListTablesSchema,
	outputSchema: ListTablesOutputSchema,
};

export function createListTablesTool(schemaService: SchemaService) {
	return {
		...LIST_TABLES_TOOL,
		handler: async (params: unknown) => {
			try {
				// Validate input
				const validated = ListTablesSchema.parse(params);
				const target = schemaService.resolveInstance(validated.instance);

				logger.info('Listing tables', {
					instance: target.name,
					instanceUrl: target.url,
					filter: validated.filter,
					concept: validated.concept,
					limit: validated.limit,
				});

				// List tables
				const tables = await schemaService.listTables(
					validated.filter,
					validated.limit,
					target.name,
					validated.concept,
				);

				const { columns, rows } = toColumnar(tables as unknown as Record<string, unknown>[]);
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
					filter: validated.filter,
					instance: target.name,
					columns,
					rows: renderedRows,
				};
				if (validated.concept) response.concept = validated.concept;
				if (truncated) {
					response.truncated = true;
					if (truncationReason) response.truncationReason = truncationReason;
				}

				// A concept search that finds nothing means the keywords were wrong,
				// not that the table is absent — say so at the point of failure, where
				// it can still change the next call.
				if (renderedRows.length === 0 && validated.concept) {
					response.hints = [
						`No table label or name matched ${JSON.stringify(validated.concept)}. Try different vocabulary before concluding the table does not exist — platform naming often diverges from the user's wording (chat → conversation/messaging/interaction, ticket → incident/task/case).`,
						'Try shorter word stems (escalat rather than escalation), and if the concept came from non-English input, translate it to English first — labels are English unless a language plugin is active.',
						'If the concept describes a value rather than a container, the answer may be a FIELD on an existing table — try sn_find_fields with the same keywords.',
					];
				}

				const describedAs = [
					validated.filter ? ` matching "${validated.filter}"` : '',
					validated.concept ? ` for concept ${JSON.stringify(validated.concept)}` : '',
				].join('');

				return toolResult(
					response,
					`${renderedRows.length} table(s)${describedAs}${truncated ? ' (truncated)' : ''}${
						renderedRows.length === 0 && validated.concept ? ' — see hints' : ''
					}`,
				);
			} catch (error) {
				logger.error('Error listing tables', error);
				return toolError(error, { operation: 'list tables' });
			}
		},
	};
}
