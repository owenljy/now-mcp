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

/** ~200 KB of serialized fields before trailing ones are dropped with a note. */
const MAX_FIELDS_BYTES = 200_000;

/**
 * Compact a field for the wire: keep name/type always; include mandatory/readOnly
 * only when true (the common case is false, so emitting `false` is pure noise —
 * matches how maxLength/reference are already omitted when empty); drop the human
 * `label` (rarely needed to build a query and roughly doubles per-field bytes).
 */
function compactField(f: FieldMetadata): Record<string, unknown> {
	const out: Record<string, unknown> = { name: f.name, type: f.type };
	if (f.mandatory) out.mandatory = true;
	if (f.readOnly) out.readOnly = true;
	if (f.maxLength !== undefined) out.maxLength = f.maxLength;
	if (f.reference) out.reference = f.reference;
	return out;
}

export const GET_TABLE_SCHEMA_TOOL = {
	name: 'sn_get_table_schema',
	title: 'Get table schema',
	description: `What: Get a ServiceNow table's fields and their data types — each field's name, type, mandatory/readonly flags (present only when true), max length, and (for reference fields) the table it points to.
When to use: To discover what fields/columns and data types a table defines, before querying or writing. For the valid values of one choice field use sn_get_choice_list. To inspect a referenced table's own fields, call this tool again with that table name.
Preconditions: Table must exist; the account needs read access.
Produces: An array of field definitions (cached ~15 min in memory, up to 24h on disk). Set includeExtended=true to include inherited parent-table fields.

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

				// Compact each field, then cap the serialized size so a very wide table
				// (hundreds of fields) truncates cleanly at a field boundary instead of
				// mid-JSON at the text-renderer's char cap.
				const allFields = schema.fields.map(compactField);
				const { rows: fields, truncated: fieldsTruncated } = capRendered(allFields, {
					maxRows: Number.POSITIVE_INFINITY,
					maxBytes: MAX_FIELDS_BYTES,
				});

				const response: Record<string, unknown> = {
					success: true,
					table: schema.name,
					label: schema.label,
					extends: schema.extends,
					fieldCount: schema.fields.length,
					fields,
					instance: target.name,
					instanceUrl: target.url,
				};
				if (fieldsTruncated) response.fieldsTruncated = true;

				const summary = `${schema.fields.length} field(s) on ${schema.name}${
					fieldsTruncated ? ` (showing ${fields.length})` : ''
				}`;
				return toolResult(response, summary);
			} catch (error) {
				logger.error('Error getting table schema', error);
				return toolError(error, { table: tableName });
			}
		},
	};
}
