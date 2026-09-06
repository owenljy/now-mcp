/**
 * Zod schemas for schema discovery and introspection
 */

import { z } from 'zod';
import { instanceField, tableNameField } from './common.js';

/**
 * Guidance shared by every concept-search input. It lives in the schema, not in
 * a skill, so it reaches every MCP client and is read at the moment the call is
 * composed. One keyword is the common failure mode: the platform's vocabulary
 * rarely matches the user's wording.
 */
const CONCEPT_GUIDANCE =
	" Pass 3-6 variants rather than one — the platform's vocabulary rarely matches the user's wording (chat → also conversation, messaging, interaction; ticket → incident, task, case). Prefer word stems: escalat covers escalate/escalated/escalation/de-escalation. English only: labels are English unless a language plugin is active, so translate non-English input into English keywords first — searching the original text matches nothing. Avoid filler that matches thousands of rows and ranks nothing (record, data, table, info, management).";

/** Concept keyword list, with the shared guidance appended to `description`. */
const conceptKeywords = (description: string) =>
	z
		.array(z.string().min(1))
		.min(1)
		.max(8)
		.describe(description + CONCEPT_GUIDANCE);

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
	concept: conceptKeywords(
		"Concept keywords for when you DON'T know the name — matched against label AND name, OR'd together (a table with a useless label often has an obvious name, and vice versa). Use filter instead when you know part of the name; the two combine as AND when both are given.",
	).optional(),
	limit: z
		.number()
		.int()
		.positive()
		.max(500)
		.default(100)
		.describe('Maximum number of tables to return'),
	offset: z
		.number()
		.int()
		.nonnegative()
		.default(0)
		.describe(
			'Rows to skip in the stable relevance-ranked candidate set. Use pagination.nextOffset to continue; rankingComplete=false means the search was broader than the bounded candidate window and should be narrowed.',
		),
});

export type ListTablesInput = z.infer<typeof ListTablesSchema>;

/**
 * Schema for finding fields across tables by concept
 */
export const FindFieldsSchema = z.object({
	instance: instanceField,
	concept: conceptKeywords(
		"Concept keywords describing the field you're looking for — matched against the field label AND the column name, OR'd together.",
	),
	limit: z
		.number()
		.int()
		.positive()
		.max(200)
		.default(25)
		.describe(
			'Maximum number of fields to return. Keep it small — this is a shortlist to rank, not a census. A large totalMatching means the keywords were too generic.',
		),
	offset: z
		.number()
		.int()
		.nonnegative()
		.default(0)
		.describe(
			'Rows to skip in the stable relevance-ranked candidate set. Use pagination.nextOffset to continue; rankingComplete=false means the search should be narrowed.',
		),
});

export type FindFieldsInput = z.infer<typeof FindFieldsSchema>;

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
	/** Which `concept` keywords matched this row; present only on a concept search. */
	matched?: string;
}

/** One field hit from a cross-table concept search (`sn_find_fields`). */
export interface FieldSearchItem {
	/** Owning table scope for ranking; unknown never earns a core bonus. */
	scope?: string;
	/** The table the field lives on. */
	table: string;
	/** The column name. */
	element: string;
	label: string;
	type: string;
	/** For reference fields, the table pointed at. */
	reference?: string;
	/** Which `concept` keywords matched this row. */
	matched: string;
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

/**
 * Everything sys_db_object knows about how a table can be reached, in one read.
 *
 * The two access flags fail in DIFFERENT layers, which is why they must be
 * resolved together rather than one at a time:
 *
 *  - `ws_access` (Allow access to this table via web services) gates the REST
 *    Table/Stats APIs. Off ⇒ every REST read 403s before any ACL runs.
 *  - `read_access` (Can read / "Allow access to this table from web service"'s
 *    sibling, `sys_db_object.read_access`) gates cross-scope reads. Off ⇒ a
 *    GlideRecord running in a DIFFERENT application scope reads ZERO rows and
 *    reports success: no exception, `isValid()` true, `canRead()` true. That
 *    silent zero is the failure this profile exists to prevent — see the
 *    plan's Background section.
 *
 * Every field except `exists` is optional and `undefined` means UNKNOWN, never
 * false: the probe is advisory and must not manufacture an answer it could not
 * read. Callers branch on `=== true` / `=== false` and treat `undefined` as
 * "cannot determine the safe transport".
 */
export interface TableAccessProfile {
	/** False when sys_db_object has no readable row for this name. */
	exists: boolean;
	/** sys_db_object.ws_access — REST Table/Stats API reachability. */
	wsAccess?: boolean;
	/** sys_db_object.read_access — cross-scope readability. */
	readAccess?: boolean;
	/** The application that owns the table, when it could be resolved. */
	owningScope?: {
		sysId: string;
		/** Scope api_name, e.g. "sn_ai_observe" or "global". */
		name: string;
	};
}
