/**
 * Schema discovery service for introspecting ServiceNow table structures
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { InstanceManager } from '../client/instance-manager.js';
import type {
	FieldMetadata,
	TableListItem,
	TableMetadata,
	TableScopeInfo,
} from '../schemas/schema-schemas.js';
import { type FieldValidationResult, validateFieldNames } from '../utils/field-validation.js';
import { closestMatch } from '../utils/levenshtein.js';
import { logger } from '../utils/logger.js';
import { assertTableAllowed } from '../utils/table-access.js';

// ServiceNow reference fields can come back as a plain string (sys_id or name)
// or as a {value, display_value, link} object depending on instance config.
function normalizeSNRef(val: unknown): string | undefined {
	if (!val) return undefined;
	if (typeof val === 'string') return val || undefined;
	if (typeof val === 'object' && val !== null) {
		const o = val as { display_value?: string; value?: string };
		return o.display_value || o.value || undefined;
	}
	return undefined;
}

/**
 * sys_dictionary internal_type values for journal columns. These read back with
 * an empty `value` and the whole entry stream in `display_value` only — see
 * journalFieldsAmong below.
 */
const JOURNAL_TYPES = new Set(['journal', 'journal_input', 'journal_list']);

/**
 * Cache configuration for schema data
 */
const CACHE_TTL = 15 * 60 * 1000; // in-memory (L1) TTL: 15 minutes
// Disk (L2) TTL: survives restarts so field validation works immediately.
const DISK_CACHE_TTL =
	parseInt(process.env.SERVICENOW_SCHEMA_CACHE_TTL || '', 10) || 24 * 60 * 60 * 1000;

interface CacheEntry<T> {
	data: T;
	timestamp: number;
}

function schemaCacheDir(): string {
	return process.env.SERVICENOW_SCHEMA_CACHE_DIR || join(homedir(), '.now-mcp', 'schema-cache');
}

export class SchemaService {
	private cache: Map<string, CacheEntry<unknown>> = new Map();

	constructor(private instanceManager: InstanceManager) {}

	/** Resolve the actual target used when the caller omits `instance`. */
	resolveInstance(instance?: string): { name: string; url: string } {
		const target = this.instanceManager.resolveInstance(instance);
		return { name: target.name, url: target.config.url.replace(/\/+$/, '') };
	}

	/**
	 * Cache namespace tied to both profile name and URL. The URL digest prevents
	 * stale disk data being reused if a profile is repointed to another host.
	 */
	private resolveCacheTarget(instance?: string) {
		const target = this.instanceManager.resolveInstance(instance);
		const normalizedUrl = target.config.url.replace(/\/+$/, '').toLowerCase();
		const urlHash = createHash('sha256').update(normalizedUrl).digest('hex').slice(0, 16);
		return { ...target, cacheNamespace: `${target.name}:${urlHash}` };
	}

	/**
	 * Collect every field a table exposes, keyed by name, by walking the
	 * inheritance chain so fields defined on parent tables (e.g. `number` on
	 * `task`, inherited by `incident`) are included. Each table schema is cached,
	 * so the walk costs at most one API call per table in the chain.
	 */
	private async collectFields(
		tableName: string,
		instance?: string,
	): Promise<Map<string, FieldMetadata>> {
		const known = new Map<string, FieldMetadata>();
		let current: string | undefined = tableName;
		const visited = new Set<string>();
		while (current && !visited.has(current)) {
			visited.add(current);
			const schema = await this.getTableSchema(current, false, instance);
			for (const f of schema.fields) {
				// First definition wins: a child table's override of an inherited
				// field is the one that applies.
				if (f.name && !known.has(f.name)) known.set(f.name, f);
			}
			current = schema.extends;
		}
		return known;
	}

	/**
	 * Validate a set of field names against a table's schema, returning unknown
	 * fields with typo suggestions. Returns null if the schema can't be loaded
	 * (e.g. no read access to sys_dictionary) so callers can skip gracefully.
	 */
	async validateFields(
		tableName: string,
		fieldNames: string[],
		instance?: string,
	): Promise<FieldValidationResult | null> {
		try {
			const known = await this.collectFields(tableName, instance);
			if (known.size === 0) return null;
			return validateFieldNames(fieldNames, [...known.keys()]);
		} catch (error) {
			logger.debug(`Field validation skipped for ${tableName}`, {
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	/**
	 * Does `tableName` descend from `ancestor` (or is it that table)?
	 *
	 * Needed because a name prefix is not a reliable proxy for the CI hierarchy:
	 * on a stock instance `cmdb_ci_outage`, `cmdb_ci_model_entry` and several
	 * `cmdb_ci_m2m_*` tables all start with `cmdb_ci_` without extending
	 * `cmdb_ci`. Routing outage inserts to the identification engine on the
	 * strength of their name would block ordinary, correct writes.
	 *
	 * Returns null when the chain can't be resolved (no dictionary access), so
	 * callers can fail open rather than block on an unrelated failure. Each step
	 * is cached, so a repeated check costs nothing.
	 */
	async extendsFrom(
		tableName: string,
		ancestor: string,
		instance?: string,
	): Promise<boolean | null> {
		if (tableName === ancestor) return true;
		try {
			let current: string | undefined = tableName;
			const visited = new Set<string>();
			while (current && !visited.has(current)) {
				visited.add(current);
				const schema = await this.getTableSchema(current, false, instance);
				if (!schema.exists) return null;
				if (schema.extends === ancestor) return true;
				current = schema.extends;
			}
			return false;
		} catch (error) {
			logger.debug(`Inheritance check skipped for ${tableName}`, {
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	/**
	 * Of the given field names, which are journal fields (comments, work_notes,
	 * and any custom journal column)?
	 *
	 * Journal columns do not behave like other columns on a read: the stored
	 * `value` comes back as an EMPTY STRING and the entry stream (timestamps,
	 * authors, text) is only rendered into `display_value`. Verified on a live
	 * instance — INC0000060 returns nine comment entries in `display_value` and
	 * `"value": ""`.
	 *
	 * That makes the default `displayValue: false` actively misleading rather
	 * than merely incomplete: the caller asks for `comments`, receives `""`, and
	 * concludes the record has none. Callers use this to warn instead.
	 *
	 * Best-effort: returns an empty array when the schema can't be loaded, so it
	 * can never break a read.
	 */
	async journalFieldsAmong(
		tableName: string,
		fieldNames: string[],
		instance?: string,
	): Promise<string[]> {
		if (fieldNames.length === 0) return [];
		try {
			const known = await this.collectFields(tableName, instance);
			return fieldNames.filter((name) => {
				// Dot-walked names resolve on another table; only the local column's
				// type is knowable here.
				const meta = known.get(name);
				return meta ? JOURNAL_TYPES.has(meta.type) : false;
			});
		} catch (error) {
			logger.debug(`Journal-field detection skipped for ${tableName}`, {
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		}
	}

	/**
	 * A table and every ancestor it extends, child first.
	 *
	 * Needed wherever "who points at this record" is the question: a reference
	 * field declared against `task` holds incident sys_ids just as happily as
	 * task ones, so looking only for fields whose `reference` is `incident`
	 * misses most of the real referrers.
	 *
	 * Each hop is a cached schema read. Returns what it resolved before any
	 * failure rather than throwing — a partial chain still beats none.
	 */
	async tableChain(tableName: string, instance?: string): Promise<string[]> {
		const chain: string[] = [];
		const visited = new Set<string>();
		let current: string | undefined = tableName;
		try {
			while (current && !visited.has(current)) {
				visited.add(current);
				chain.push(current);
				const schema: TableMetadata = await this.getTableSchema(current, false, instance);
				current = schema.extends;
			}
		} catch (error) {
			logger.debug(`Table-chain walk stopped early for ${tableName}`, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return chain;
	}

	/**
	 * The column whose value the UI shows wherever a record of this table is
	 * referenced.
	 *
	 * Walks the inheritance chain, because sys_dictionary.display sits on the
	 * table where the column is DEFINED, not where it is used: incident's
	 * display field is `number`, flagged on `task`. Reading only the local
	 * dictionary (what includeExtended:false fetches) finds nothing for most
	 * child tables, so this walk is independent of that flag.
	 *
	 * `source` distinguishes a real dictionary flag from the platform's
	 * fallback-to-`name` convention, so a caller can tell an authoritative
	 * answer from an inferred one. Returns undefined when neither applies —
	 * some tables genuinely have no display column, and saying so beats
	 * nominating an arbitrary field.
	 */
	async resolveDisplayField(
		tableName: string,
		instance?: string,
	): Promise<{ field: string; source: 'dictionary' | 'name_convention' } | undefined> {
		try {
			const known = await this.collectFields(tableName, instance);
			for (const [name, meta] of known) {
				if (meta.display) return { field: name, source: 'dictionary' };
			}
			if (known.has('name')) return { field: 'name', source: 'name_convention' };
			return undefined;
		} catch (error) {
			logger.debug(`Display-field resolution skipped for ${tableName}`, {
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}

	/**
	 * Dictionary type + max_length for a set of field names, resolved through
	 * the inheritance chain. Returns only the names that resolved, so an unknown
	 * or dot-walked name is absent rather than present-with-a-guess.
	 *
	 * Every schema in the chain is already cached by the time a query returns
	 * (field validation walked it on the way in), so this costs no API call on
	 * the path it exists for: enriching a zero-result response.
	 */
	async fieldMetaAmong(
		tableName: string,
		fieldNames: string[],
		instance?: string,
	): Promise<Record<string, { type: string; maxLength?: number }>> {
		if (fieldNames.length === 0) return {};
		try {
			const known = await this.collectFields(tableName, instance);
			const out: Record<string, { type: string; maxLength?: number }> = {};
			for (const name of fieldNames) {
				const meta = known.get(name);
				if (meta) out[name] = { type: meta.type, maxLength: meta.maxLength };
			}
			return out;
		} catch (error) {
			logger.debug(`Field-meta lookup skipped for ${tableName}`, {
				error: error instanceof Error ? error.message : String(error),
			});
			return {};
		}
	}

	/**
	 * Suggest the closest real table name to a (possibly typo'd) one. Used when a
	 * table fails to resolve, to tell "typo'd table" apart from "no read access".
	 * Returns undefined if nothing is close enough (or the name is exact — an
	 * exact match means the table exists, so it's an access issue, not a typo).
	 * The table-name list is fetched once and cached (disk, 24h).
	 */
	async suggestTableName(tableName: string, instance?: string): Promise<string | undefined> {
		try {
			const target = this.resolveCacheTarget(instance);
			const cacheKey = `tablenames:${target.cacheNamespace}`;
			let names = this.getFromCache<string[]>(cacheKey);
			if (!names) {
				const resp = await target.client.get<{ result: Array<{ name: string }> }>(
					'/api/now/table/sys_db_object',
					{ sysparm_fields: 'name', sysparm_limit: 10000 },
				);
				names = resp.result.map((r) => r.name).filter(Boolean);
				this.setCache(cacheKey, names);
			}
			return closestMatch(tableName, names);
		} catch (error) {
			logger.debug(`Table-name suggestion skipped for ${tableName}`, {
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}

	/**
	 * Check whether a table allows access via web services (sys_db_object.ws_access).
	 * When false, the REST Table/Stats APIs reject ALL requests to the table
	 * before any role/ACL evaluation happens — independent of the caller's
	 * roles or admin status. Used to give a 403 a precise cause instead of a
	 * generic "maybe you lack a role" guess.
	 *
	 * Best-effort: returns null on any failure (network error, the probe
	 * itself blocked, etc.) so it can never mask or replace the original
	 * error — same pattern as suggestTableName above. Does not call
	 * assertTableAllowed: this is an internal advisory probe of table
	 * metadata, not a read of the blocked table's own data.
	 */
	async checkWebServiceAccess(
		tableName: string,
		instance?: string,
	): Promise<{ exists: boolean; wsAccess: boolean } | null> {
		try {
			const target = this.resolveCacheTarget(instance);
			const cacheKey = `wsaccess:${target.cacheNamespace}:${tableName}`;
			const cached = this.getFromCache<{ exists: boolean; wsAccess: boolean }>(cacheKey);
			if (cached) return cached;

			const resp = await target.client.get<{
				result: Array<{ name: string; ws_access: string }>;
			}>('/api/now/table/sys_db_object', {
				sysparm_query: `name=${tableName}`,
				sysparm_fields: 'name,ws_access',
				sysparm_limit: 1,
			});

			const row = resp.result[0];
			const result = { exists: Boolean(row), wsAccess: row?.ws_access === 'true' };
			this.setCache(cacheKey, result);
			return result;
		} catch (error) {
			logger.debug(`Web-service access check skipped for ${tableName}`, {
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	/**
	 * Resolve the application scope that owns a table (sys_db_object.sys_scope),
	 * so a write to it can run in that scope's transaction context instead of
	 * the caller's own session scope — without this, a before-insert/update
	 * business rule that checks gs.getCurrentScopeName() sees the integration
	 * user's scope (typically global), not the target app's, even though the
	 * record itself lands in the scoped table.
	 *
	 * Global tables — the overwhelming majority — resolve to `scoped: false` so
	 * callers can skip sysparm_transaction_scope entirely, leaving today's
	 * behavior unchanged for every out-of-box table.
	 *
	 * Best-effort: any failure (no read access to sys_db_object, network error)
	 * resolves to `scoped: false` rather than blocking the write that asked for
	 * it — same posture as checkWebServiceAccess/suggestTableName above.
	 */
	async resolveTableScope(tableName: string, instance?: string): Promise<TableScopeInfo> {
		const NOT_SCOPED: TableScopeInfo = { scoped: false };
		try {
			const target = this.resolveCacheTarget(instance);
			const cacheKey = `tablescope:${target.cacheNamespace}:${tableName}`;
			const cached = this.getFromCache<TableScopeInfo>(cacheKey);
			if (cached) return cached;

			const resp = await target.client.get<{
				result: Array<{ sys_scope: unknown; 'sys_scope.scope': string }>;
			}>('/api/now/table/sys_db_object', {
				sysparm_query: `name=${tableName}`,
				sysparm_fields: 'sys_scope,sys_scope.scope',
				sysparm_limit: 1,
				sysparm_exclude_reference_link: true,
			});

			const row = resp.result[0];
			const scopeSysId = normalizeSNRef(row?.sys_scope);
			const scopeName = row?.['sys_scope.scope'];
			// A table with no scope, or explicitly scoped to "global", needs no
			// transaction-scope override.
			const result: TableScopeInfo =
				scopeSysId && scopeName && scopeName !== 'global'
					? { scoped: true, scopeSysId, scopeName }
					: NOT_SCOPED;

			this.setCache(cacheKey, result);
			return result;
		} catch (error) {
			logger.debug(`Table scope resolution skipped for ${tableName}`, {
				error: error instanceof Error ? error.message : String(error),
			});
			return NOT_SCOPED;
		}
	}

	/**
	 * Get detailed schema information for a table.
	 *
	 * @param tableName Name of the table
	 * @param includeExtended Include fields inherited from parent tables
	 * @param instance Optional instance name
	 */
	async getTableSchema(
		tableName: string,
		includeExtended: boolean = false,
		instance?: string,
	): Promise<TableMetadata> {
		if (includeExtended) return this.getInheritedTableSchema(tableName, instance);
		return this.getLocalTableSchema(tableName, instance);
	}

	/**
	 * A table's own dictionary rows PLUS every field it inherits.
	 *
	 * sys_dictionary is keyed by the table a column is DEFINED on, so
	 * `name=incident` genuinely does not contain `number` — that row belongs to
	 * `task`. The only way to answer "every field incident exposes" is to walk
	 * the chain, which is what collectFields does and what includeExtended has
	 * always claimed to do.
	 *
	 * Each table in the chain is cached independently, so the walk costs at most
	 * one request per ancestor and usually zero.
	 */
	private async getInheritedTableSchema(
		tableName: string,
		instance?: string,
	): Promise<TableMetadata> {
		const base = await this.getLocalTableSchema(tableName, instance);
		if (!base.exists || !base.extends) return base;
		const known = await this.collectFields(tableName, instance);
		return { ...base, fields: [...known.values()] };
	}

	private async getLocalTableSchema(tableName: string, instance?: string): Promise<TableMetadata> {
		// Defense-in-depth: schema discovery bypasses validateTableName, so gate it
		// here too — a blocked table's structure shouldn't be readable either.
		assertTableAllowed(tableName);
		const target = this.resolveCacheTarget(instance);
		const cacheKey = `schema:v2:local:${target.cacheNamespace}:${tableName}`;

		// Check cache first
		const cached = this.getFromCache<TableMetadata>(cacheKey);
		if (cached) {
			logger.debug(`Cache hit for table schema: ${tableName}`);
			// Disk cache may predate the normalization fixes — re-normalize on the way
			// out, for the parent-table pointer and for each field's type/reference
			// (which were stored as {value, link} objects before exclude_reference_link
			// was set on the dictionary query).
			cached.extends = normalizeSNRef(cached.extends);
			for (const field of cached.fields) {
				field.type = normalizeSNRef(field.type) ?? '';
				field.reference = normalizeSNRef(field.reference);
			}
			return cached;
		}

		logger.info(`Fetching table schema: ${tableName}`, {
			instance: target.name,
			instanceUrl: target.config.url,
		});

		const client = target.client;

		// This table's OWN dictionary rows. The `collection` row is the table
		// itself, not a column — it carries an empty `element` and would surface
		// as a nameless field. Inherited columns live on the ancestor's rows and
		// are merged in by getInheritedTableSchema.
		const query = `name=${tableName}^internal_type!=collection`;

		// The field definitions (sys_dictionary) and the table metadata
		// (sys_db_object) are independent reads — fetch them concurrently so the
		// tool's latency is one round-trip, not two back-to-back.
		const [response, tableResponse] = await Promise.all([
			client.get<{
				result: Array<{
					element: string;
					column_label: string;
					// Reference columns: a plain name with exclude_reference_link, a
					// {value, link} object without it. normalizeSNRef handles both.
					internal_type: unknown;
					mandatory: string;
					read_only: string;
					max_length: string;
					reference: unknown;
					display: string;
				}>;
			}>('/api/now/table/sys_dictionary', {
				sysparm_query: query,
				sysparm_fields:
					'element,column_label,internal_type,mandatory,read_only,max_length,reference,display',
				sysparm_limit: 1000,
				// internal_type and reference are REFERENCE columns on sys_dictionary, so
				// without this they come back as {value, link} objects rather than plain
				// names. That made every field's advertised `type` an object carrying a
				// full API URL — noise in sn_get_table_schema's output, and it silently
				// broke any type comparison (e.g. spotting journal columns).
				sysparm_exclude_reference_link: true,
			}),
			client.get<{
				result: Array<{
					name: string;
					label: string;
					'super_class.name': string;
				}>;
			}>('/api/now/table/sys_db_object', {
				sysparm_query: `name=${tableName}`,
				sysparm_fields: 'name,label,super_class.name',
				sysparm_limit: 1,
			}),
		]);

		const fields: FieldMetadata[] = response.result.map((field) => ({
			name: field.element,
			label: field.column_label,
			// normalizeSNRef as well as the exclude_reference_link above: the disk cache
			// has a 24h TTL, so entries written before that fix still hold the object
			// form and would otherwise keep breaking type checks for a day.
			type: normalizeSNRef(field.internal_type) ?? '',
			mandatory: field.mandatory === 'true',
			readOnly: field.read_only === 'true',
			maxLength: field.max_length ? parseInt(field.max_length, 10) : undefined,
			reference: normalizeSNRef(field.reference),
			// Only ever true for one column per table — the one whose value the UI
			// shows wherever the record is referenced. Emitted as undefined rather
			// than false so it costs nothing on the 99% of fields that aren't it.
			display: field.display === 'true' ? true : undefined,
		}));

		const tableInfo = tableResponse.result[0];

		const metadata: TableMetadata = {
			name: tableName,
			label: tableInfo?.label || tableName,
			extends: normalizeSNRef(tableInfo?.['super_class.name']),
			fields,
			// A table that exists has a sys_db_object row; absent/unreadable does not.
			exists: Boolean(tableInfo) || fields.length > 0,
		};

		// Cache the result
		this.setCache(cacheKey, metadata);

		logger.info(`Retrieved ${fields.length} fields for table ${tableName}`);

		return metadata;
	}

	/**
	 * List all available tables
	 * @param filter Optional filter for table names
	 * @param limit Maximum number of tables to return
	 * @param instance Optional instance name
	 */
	async listTables(
		filter?: string,
		limit: number = 100,
		instance?: string,
	): Promise<TableListItem[]> {
		const target = this.resolveCacheTarget(instance);
		const cacheKey = `tables:${target.cacheNamespace}:${filter || 'all'}:${limit}`;

		// Check cache first
		const cached = this.getFromCache<TableListItem[]>(cacheKey);
		if (cached) {
			logger.debug('Cache hit for table list');
			return cached;
		}

		logger.info('Fetching table list', {
			instance: target.name,
			instanceUrl: target.config.url,
			filter,
			limit,
		});

		const client = target.client;

		// Build query for filtering. Honor leading/trailing `*` as anchors:
		//   incident*  -> STARTSWITH   *incident -> ENDSWITH
		//   *incident* / incident -> LIKE (substring)
		let query = 'sys_class_name=sys_db_object';
		if (filter) {
			const hasLead = filter.startsWith('*');
			const hasTrail = filter.endsWith('*');
			const core = filter.replace(/^\*+/, '').replace(/\*+$/, '');
			if (core) {
				if (hasTrail && !hasLead) {
					query += `^nameSTARTSWITH${core}`;
				} else if (hasLead && !hasTrail) {
					query += `^nameENDSWITH${core}`;
				} else {
					query += `^nameLIKE${core}`;
				}
			}
		}

		const response = await client.get<{
			result: Array<{
				name: string;
				label: string;
				'super_class.name': string;
				'sys_scope.scope': string;
			}>;
		}>('/api/now/table/sys_db_object', {
			sysparm_query: query,
			sysparm_fields: 'name,label,super_class.name,sys_scope.scope',
			sysparm_limit: limit,
			sysparm_order_by: 'name',
		});

		const tables: TableListItem[] = response.result.map((table) => {
			const scopeName = normalizeSNRef(table['sys_scope.scope']);
			return {
				name: table.name,
				label: table.label,
				extends: normalizeSNRef(table['super_class.name']),
				// "global" is the overwhelming majority (every OOB table); omit it so
				// it doesn't repeat on every row — presence of `scope` already signals
				// a scoped/custom app table.
				scope: scopeName && scopeName !== 'global' ? scopeName : undefined,
			};
		});

		// Cache the result
		this.setCache(cacheKey, tables);

		logger.info(`Retrieved ${tables.length} tables`);

		return tables;
	}

	/**
	 * Get choice list values for a specific field
	 * @param tableName Name of the table
	 * @param fieldName Name of the field
	 * @param instance Optional instance name
	 */
	async getChoiceList(
		tableName: string,
		fieldName: string,
		instance?: string,
	): Promise<Array<{ label: string; value: string }>> {
		assertTableAllowed(tableName);
		const target = this.resolveCacheTarget(instance);
		const cacheKey = `choices:${target.cacheNamespace}:${tableName}:${fieldName}`;

		// Check cache first
		const cached = this.getFromCache<Array<{ label: string; value: string }>>(cacheKey);
		if (cached) {
			logger.debug(`Cache hit for choice list: ${tableName}.${fieldName}`);
			return cached;
		}

		logger.info(`Fetching choice list: ${tableName}.${fieldName}`, {
			instance: target.name,
			instanceUrl: target.config.url,
		});

		const client = target.client;

		const response = await client.get<{
			result: Array<{
				label: string;
				value: string;
				sequence: string;
			}>;
		}>('/api/now/table/sys_choice', {
			sysparm_query: `name=${tableName}^element=${fieldName}^inactive=false`,
			sysparm_fields: 'label,value,sequence',
			sysparm_order_by: 'sequence',
			sysparm_limit: 500,
		});

		const choices = response.result.map((choice) => ({
			label: choice.label,
			value: choice.value,
		}));

		// Cache the result
		this.setCache(cacheKey, choices);

		logger.info(`Retrieved ${choices.length} choices for ${tableName}.${fieldName}`);

		return choices;
	}

	/**
	 * Get data from cache if not expired (L1 in-memory, then L2 disk).
	 */
	private getFromCache<T>(key: string): T | null {
		const now = Date.now();

		const entry = this.cache.get(key);
		if (entry) {
			if (now - entry.timestamp <= CACHE_TTL) {
				return entry.data as T;
			}
			this.cache.delete(key);
		}

		// L2: disk cache (survives restarts, longer TTL)
		const disk = this.readDisk<T>(key, now);
		if (disk !== null) {
			// Promote back into memory
			this.cache.set(key, { data: disk, timestamp: now });
			return disk;
		}

		return null;
	}

	/**
	 * Store data in cache (in-memory + disk write-through).
	 */
	private setCache<T>(key: string, data: T): void {
		this.cache.set(key, {
			data,
			timestamp: Date.now(),
		});
		this.writeDisk(key, data);
	}

	private diskPath(key: string): string {
		const hash = createHash('sha1').update(key).digest('hex').slice(0, 16);
		return join(schemaCacheDir(), `${hash}.json`);
	}

	private readDisk<T>(key: string, now: number): T | null {
		try {
			const path = this.diskPath(key);
			if (!existsSync(path)) return null;
			const entry = JSON.parse(readFileSync(path, 'utf-8')) as CacheEntry<T>;
			if (now - entry.timestamp > DISK_CACHE_TTL) return null;
			return entry.data;
		} catch {
			return null;
		}
	}

	private writeDisk<T>(key: string, data: T): void {
		try {
			const dir = schemaCacheDir();
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			writeFileSync(this.diskPath(key), JSON.stringify({ data, timestamp: Date.now() }), 'utf-8');
		} catch (error) {
			// Caching is best-effort; never break a schema read because of disk I/O.
			logger.debug('Schema disk cache write failed', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Clear all cached data
	 */
	clearCache(): void {
		this.cache.clear();
		logger.info('Schema cache cleared');
	}

	/**
	 * Get cache statistics
	 */
	getCacheStats(): { size: number; keys: string[] } {
		return {
			size: this.cache.size,
			keys: Array.from(this.cache.keys()),
		};
	}
}
