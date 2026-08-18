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
	description: `What: List tables in the instance, with optional name filtering.
When to use: To discover which table to use. For a single table's fields use sn_get_table_schema.
Preconditions: Read access to the dictionary.
Produces: {columns, rows} — one row per table (name, label, parent table); cached ~15 min in memory, up to 24h on disk.

Filter matching: trailing * = starts-with (incident*), leading * = ends-with (*task), both/neither = substring (*task*, task).

Examples:
- All tables (first 100): no parameters
- Starts with: filter="incident*"
- Substring, capped: filter="*task*", limit=50`,
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
					limit: validated.limit,
				});

				// List tables
				const tables = await schemaService.listTables(
					validated.filter,
					validated.limit,
					target.name,
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
				if (truncated) {
					response.truncated = true;
					if (truncationReason) response.truncationReason = truncationReason;
				}

				return toolResult(
					response,
					`${renderedRows.length} table(s)${validated.filter ? ` matching "${validated.filter}"` : ''}${
						truncated ? ' (truncated)' : ''
					}`,
				);
			} catch (error) {
				logger.error('Error listing tables', error);
				return toolError(error, { operation: 'list tables' });
			}
		},
	};
}
