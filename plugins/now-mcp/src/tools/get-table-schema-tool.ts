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

/**
 * Platform bookkeeping columns, hidden unless includeSystemFields is set.
 *
 * Deliberately NARROW. sys_id, sys_created_on/by and sys_updated_on/by stay
 * visible because callers legitimately query and time-bound on them; sys_name
 * stays because it is the display column on every sys_metadata-derived table;
 * sys_class_name stays because it is meaningful on a hierarchy. What's left is
 * plumbing no caller filters on. The `sys_*_update*` / package / policy block
 * only ever appears under includeExtended (it comes from sys_metadata), which
 * is exactly where the row count hurts most.
 */
const SYSTEM_FIELDS = new Set([
	'sys_mod_count',
	'sys_domain',
	'sys_domain_path',
	'sys_tags',
	'sys_package',
	'sys_scope',
	'sys_policy',
	'sys_update_name',
	'sys_update_env',
	'sys_customer_update',
	'sys_replace_on_upgrade',
	'sys_overrides',
]);

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

displayField names the column the UI shows wherever this record is referenced, resolved through the inheritance chain (incident's is number, flagged on task). Read it before assuming a field named title or name holds the human-readable label — plenty of tables carry a junk value there and put the real label elsewhere. displayFieldSource is "dictionary" for a real sys_dictionary.display flag and "name_convention" for the platform's fallback to a name column; both keys are absent when the table has neither, which means the visible label is computed by the application, not by a column.

Platform bookkeeping columns (sys_mod_count, sys_domain, sys_domain_path, sys_tags, and the sys_metadata plumbing) are omitted by default and counted in systemFieldsHidden; pass includeSystemFields=true for the full list. On a wide table pass match to filter by field name/label instead of reading every row.

Examples:
- tableName="incident"
- tableName="incident", match="assign"`,
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

				// The display column is what the UI renders wherever this record is
				// referenced. Resolved through the inheritance chain (incident's is
				// `number`, flagged on `task`) and before any filtering, so it is
				// reported even when the field itself is filtered out of the rows.
				const display = await schemaService.resolveDisplayField(validated.tableName, target.name);
				const displayField = display?.field;

				// Drop platform bookkeeping, then apply the caller's match. Both narrow
				// the ROWS only — fieldCount keeps reporting the table's real width so a
				// filtered response can't read as a narrow table.
				const hiddenSystemFields = validated.includeSystemFields
					? []
					: schema.fields
							.filter((f) => SYSTEM_FIELDS.has(f.name) && f.name !== displayField)
							.map((f) => f.name);
				const hidden = new Set(hiddenSystemFields);
				let visible = schema.fields.filter((f) => !hidden.has(f.name));

				const needle = validated.match?.trim().toLowerCase();
				let matchedCount: number | undefined;
				if (needle) {
					visible = visible.filter(
						(f) =>
							f.name.toLowerCase().includes(needle) ||
							(f.label ?? '').toLowerCase().includes(needle),
					);
					matchedCount = visible.length;
				}

				// Materialize each field as a fixed-column row, then cap the serialized
				// size so a very wide table (hundreds of fields) truncates cleanly at a
				// row boundary instead of mid-JSON at the text-renderer's char cap.
				const allRows = visible.map(fieldToRow);
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
				if (display) {
					response.displayField = display.field;
					response.displayFieldSource = display.source;
				}
				if (hiddenSystemFields.length > 0) {
					response.systemFieldsHidden = hiddenSystemFields;
				}
				if (needle) {
					response.match = validated.match;
					response.matchedCount = matchedCount;
				}
				if (fieldsTruncated) response.fieldsTruncated = true;

				// An empty match is a dead end unless the caller is told the filter —
				// not the table — is what emptied it.
				if (needle && matchedCount === 0) {
					response.hints = [
						`No field on ${schema.name} matches "${validated.match}" by name or label (${schema.fields.length} fields total). Drop match to see them all.`,
					];
				}

				const summary = `${schema.fields.length} field(s) on ${schema.name}${
					needle ? `, ${matchedCount} matching "${validated.match}"` : ''
				}${fieldsTruncated ? ` (showing ${rows.length})` : ''}`;
				return toolResult(response, summary);
			} catch (error) {
				logger.error('Error getting table schema', error);
				return toolError(error, { table: tableName });
			}
		},
	};
}
