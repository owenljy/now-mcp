/**
 * Zod schemas for schema discovery and introspection
 */

import { z } from 'zod';
import { instanceField, tableNameField } from './common.js';

/**
 * Schema for getting table schema/structure
 */
export const GetTableSchemaSchema = z.object({
	instance: instanceField,
	tableName: tableNameField(),
	includeExtended: z
		.boolean()
		.default(false)
		.describe('Include fields from parent tables (extended tables)'),
	includeSystemFields: z
		.boolean()
		.default(false)
		.describe(
			'Include platform bookkeeping columns (sys_mod_count, sys_domain, sys_domain_path, sys_tags, and the sys_metadata plumbing under includeExtended). Off by default; the response always reports how many were hidden and names them.',
		),
	match: z
		.string()
		.optional()
		.describe(
			'Case-insensitive substring filter over field name AND label — e.g. "assign" finds assigned_to and assignment_group. Applied after the system-field filter; fieldCount still reports the table total.',
		),
});

export type GetTableSchemaInput = z.infer<typeof GetTableSchemaSchema>;

/**
 * Schema for listing all available tables
 */
export const ListTablesSchema = z.object({
	instance: instanceField,
	filter: z.string().optional().describe('Filter tables by name (supports wildcards with *)'),
	limit: z
		.number()
		.int()
		.positive()
		.max(500)
		.default(100)
		.describe('Maximum number of tables to return'),
});

export type ListTablesInput = z.infer<typeof ListTablesSchema>;

/**
 * Schema for getting choice list values for a field
 */
export const GetChoiceListSchema = z.object({
	instance: instanceField,
	tableName: tableNameField(),
	fieldName: z
		.string()
		.min(1, 'Field name is required')
		.describe('Name of the field with choice list'),
});

export type GetChoiceListInput = z.infer<typeof GetChoiceListSchema>;

/**
 * Field metadata interface
 */
export interface FieldMetadata {
	name: string;
	label: string;
	type: string;
	mandatory: boolean;
	readOnly: boolean;
	maxLength?: number;
	reference?: string; // Referenced table name
	/** sys_dictionary.display — the column whose value the UI shows for this
	 * record. At most one per table hierarchy; undefined on every other field. */
	display?: boolean;
	choices?: Array<{ label: string; value: string }>;
}

/**
 * Table metadata interface
 */
export interface TableMetadata {
	name: string;
	label: string;
	extends?: string; // Parent table name
	fields: FieldMetadata[];
	/** False when sys_db_object has no row for this name (table absent/unreadable). */
	exists: boolean;
}

/**
 * Table list item interface
 */
export interface TableListItem {
	name: string;
	label: string;
	extends?: string;
	numberOfRecords?: number;
	/** Scoped-app name (e.g. `x_acme_myapp`); omitted for global/unscoped tables. */
	scope?: string;
}

/**
 * The application scope that owns a table (sys_db_object.sys_scope), resolved
 * so writes can run in that scope's transaction context. `scoped: false`
 * covers both global tables and unresolved lookups (no read access, network
 * failure) — callers should skip sysparm_transaction_scope in both cases.
 */
export interface TableScopeInfo {
	scoped: boolean;
	/** sys_scope sys_id. Present only when scoped is true. */
	scopeSysId?: string;
	/** Application scope api_name, e.g. "x_snc_myapp". Present only when scoped is true. */
	scopeName?: string;
}
