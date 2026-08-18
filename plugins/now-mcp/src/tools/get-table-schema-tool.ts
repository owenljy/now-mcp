/**
 * MCP tool for discovering ServiceNow table structure and field definitions
 */

import { GetTableSchemaOutputSchema } from '../schemas/output-schemas.js';
import type { FieldMetadata } from '../schemas/schema-schemas.js';
import { GetTableSchemaSchema } from '../schemas/schema-schemas.js';
import type { SchemaService } from '../services/schema-service.js';
import { toolError } from '../utils/error-handler.js';
import { logger } from '../utils/logger.js';
import { capRendered } from '../utils/render-cap.js';
import { toolResult } from '../utils/tool-response.js';

/** ~60 KB of serialized fields before trailing ones are dropped with a note. */
const MAX_FIELDS_BYTES = 60_000;

/** Fixed column order — see GetTableSchemaOutputSchema for why mandatory/readOnly are always explicit booleans, never omitted. */
const FIELD_COLUMNS = ['name', 'type', 'mandatory', 'readOnly', 'maxLength', 'reference'];

function fieldToRow(f: FieldMetadata): unknown[] {
	return [f.name, f.type, !!f.mandatory, !!f.readOnly, f.maxLength ?? null, f.reference ?? null];
}

export const GET_TABLE_SCHEMA_TOOL = {
	name: 'sn_get_table_schema',
	title: 'Get table schema',
	description: `What: Get a ServiceNow table's field definitions and constraints — each field's name, data type, mandatory/readonly flags (always explicit booleans), max length, and (for reference fields) the table it points to.
When to use: To discover what fields/columns, data types, and constraints a table defines, before querying or writing. For the valid values of one choice field use sn_get_choice_list. To inspect a referenced table's own fields, call this tool again with that table name.
Preconditions: Table must exist; the account needs read access.
Produces: {columns, rows} — one row per field, columns = ['name','type','mandatory','readOnly','maxLength','reference']; cached ~15 min in memory, up to 24h on disk. Set includeExtended=true to include inherited parent-table fields.

Example: tableName="incident"`,
	inputSchema: GetTableSchemaSchema,
	outputSchema: GetTableSchemaOutputSchema,
};

export function createGetTableSchemaTool(schemaService: SchemaService) {
	return {
		...GET_TABLE_SCHEMA_TOOL,
		handler: async (params: unknown) => {
			let tableName: string | undefined;
			try {
				// Validate input
				const validated = GetTableSchemaSchema.parse(params);
				tableName = validated.tableName;
				const target = schemaService.resolveInstance(validated.instance);

				logger.info(`Getting schema for table: ${validated.tableName}`, {
					instance: target.name,
					instanceUrl: target.url,
					includeExtended: validated.includeExtended,
				});

				// Get table schema
				const schema = await schemaService.getTableSchema(
					validated.tableName,
					validated.includeExtended,
					target.name,
				);

				// Table absent from sys_db_object (and no fields) = doesn't exist or
				// isn't readable — distinguish that from a genuinely empty schema so the
				// model doesn't treat a typo'd table name as "table has no fields".
				if (!schema.exists) {
					// Hint lives in the structured body only (not also a separate text
					// block) — no double emission.
					const notFound = {
						success: false,
						table: validated.tableName,
						fieldCount: 0,
						error: `Table '${validated.tableName}' not found or not readable`,
						hints: [
							`No schema found for '${validated.tableName}'. The table may not exist or you may lack read access — verify the name with sn_list_tables.`,
						],
					};
					return {
						...toolResult(notFound, `table '${validated.tableName}' not found or not readable`),
						isError: true as const,
					};
				}

				// Materialize each field as a fixed-column row, then cap the serialized
				// size so a very wide table (hundreds of fields) truncates cleanly at a
				// row boundary instead of mid-JSON at the text-renderer's char cap.
				const allRows = schema.fields.map(fieldToRow);
				const { rows, truncated: fieldsTruncated } = capRendered(allRows, {
					maxRows: Number.POSITIVE_INFINITY,
					maxBytes: MAX_FIELDS_BYTES,
					reservedBytes: Buffer.byteLength(JSON.stringify(FIELD_COLUMNS)),
				});

				const response: Record<string, unknown> = {
					success: true,
					table: schema.name,
					label: schema.label,
					extends: schema.extends,
					fieldCount: schema.fields.length,
					columns: FIELD_COLUMNS,
					rows,
					instance: target.name,
				};
				if (fieldsTruncated) response.fieldsTruncated = true;

				const summary = `${schema.fields.length} field(s) on ${schema.name}${
					fieldsTruncated ? ` (showing ${rows.length})` : ''
				}`;
				return toolResult(response, summary);
			} catch (error) {
				logger.error('Error getting table schema', error);
				return toolError(error, { table: tableName });
			}
		},
	};
}
