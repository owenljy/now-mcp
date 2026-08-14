/**
 * GraphQL read channel (GlideRecord namespace).
 *
 * Read-only by design. GraphQL is used as an internal TRANSPORT, never exposed
 * as a raw query tool, for three reasons found on a live instance:
 *   - Errors arrive as HTTP 200 with an `errors` array, so a raw pass-through
 *     would let failures read as successes.
 *   - The auto-generated schema covers ~6,200 tables and introspection is
 *     disabled by default (and costs tens of MB when enabled), so a caller
 *     cannot discover the schema at runtime anyway.
 *   - An unknown FIELD resolves to null with no error at all — the same silent
 *     failure the Table API has, which is why the field pre-flight runs on this
 *     path too.
 *
 * Writes deliberately stay on the Table API: a GraphQL mutation can report
 * success with a null result and requires a re-read to confirm, which is
 * strictly worse than the REST response we already trust.
 *
 * What it buys us: `_rowCount` is the true total matching the query independent
 * of pagination (verified: 67 for the whole incident table, on every page), and
 * `_reference` walks into a referenced record with per-field selection — so
 * "incident plus the caller's name and email" is one round trip instead of two,
 * and each field can be asked for as a raw value or a display value
 * independently rather than doubling the whole payload with display_value=all.
 *
 * The second thing it buys us is `_table_metadata` / the per-field metadata
 * leaves: ServiceNow's OWN access verdict for the authenticated caller, on the
 * caller's own credentials. That is a different kind of answer from anything
 * `sys_security_acl` can give — reading ACL rows tells you which rules exist,
 * not what they add up to for this user (measured on a live instance: the API
 * admin gets canWrite/canCreate/canDelete=false on sys_security_acl, because
 * ACLs with admin_overrides=false apply to admin too). See
 * `fetchEffectiveAccess` below.
 */

import type { InstanceManager } from '../client/instance-manager.js';
import { API_ENDPOINTS } from '../config/constants.js';
import { ServiceNowError } from '../types/errors.js';
import type { ServiceNowRecord } from '../types/servicenow.js';
import { logger } from '../utils/logger.js';

/** Raw GraphQL envelope. `data` is null when validation failed outright. */
interface GraphqlEnvelope {
	data?: {
		GlideRecord_Query?: Record<string, GlideRecordResult | null>;
	} | null;
	errors?: Array<{ message?: string; errorType?: string }>;
}

interface GlideRecordResult {
	_rowCount?: number;
	_results?: Array<Record<string, unknown>>;
	_table_metadata?: Record<string, unknown> | null;
}

/** A GraphQL scalar leaf as the GlideRecord namespace returns it. */
interface FieldLeaf {
	value?: unknown;
	displayValue?: unknown;
	_reference?: Record<string, unknown> | null;
}

export interface GraphqlQueryOptions {
	query?: string;
	limit: number;
	offset: number;
	/** Required: GraphQL has no "select all columns". */
	fields: string[];
	displayValue: boolean | 'all';
	/** Reference field -> fields to pull from the referenced record. */
	expand: Record<string, string[]>;
}

export interface GraphqlQueryResult {
	records: ServiceNowRecord[];
	/** True total matching the query, independent of pagination. */
	totalCount: number | null;
}

export interface EffectiveAccessOptions {
	/** Fields to resolve field-level verdicts for. Omit for table-level only. */
	fields?: string[];
	/**
	 * Encoded query pinning the row the field verdicts should describe. Without
	 * it, verdicts come from whichever row the table returns first, which is only
	 * an approximation when an ACL condition or script varies per record.
	 */
	recordQuery?: string;
}

/** Table-level verdict as `_table_metadata` reports it for the calling user. */
export interface TableAccessVerdict {
	label?: string;
	plural?: string;
	canRead: boolean | null;
	canWrite: boolean | null;
	canCreate: boolean | null;
	canDelete: boolean | null;
	auditWanted: boolean | null;
}

/** Field-level verdict, read off the field leaf of a sample row. */
export interface FieldAccessVerdict {
	field: string;
	label?: string;
	internalType?: string;
	isMandatory: boolean | null;
	canRead: boolean | null;
	canWrite: boolean | null;
}

/**
 * Why field verdicts are or aren't present. `no_sample_row` matters: field
 * metadata only exists on a row, so a table (or filter) that returns nothing
 * yields no field verdicts — which must not be read as "denied".
 */
export type FieldVerdictStatus = 'resolved' | 'not_requested' | 'no_sample_row';

export interface EffectiveAccessResult {
	table: TableAccessVerdict;
	fields: FieldAccessVerdict[];
	fieldVerdicts: FieldVerdictStatus;
	/**
	 * Requested fields whose leaf came back null. GraphQL does that for a field
	 * that does not exist, with no error — so these are unknown names, NOT denials.
	 */
	unresolvedFields: string[];
}

/**
 * Thrown when this instance cannot serve GraphQL GlideRecord queries at all
 * (endpoint absent, namespace disabled). Distinct from a query error so callers
 * can fall back to the Table API instead of surfacing a failure.
 */
export class GraphqlUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GraphqlUnavailableError';
	}
}

/**
 * GraphQL identifiers are interpolated into the query document, so they are
 * restricted to the character class ServiceNow column and table names actually
 * use. Anything else is rejected rather than escaped — there is no legitimate
 * field name that needs it, and a permissive escape here would be an injection
 * point into the query document.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(name: string, kind: string): string {
	if (!IDENTIFIER.test(name)) {
		throw new ServiceNowError(`Invalid ${kind} for a GraphQL query: "${name}"`, 400);
	}
	return name;
}

/**
 * Build the leaf selection for one field. `displayValue: 'all'` asks for both
 * halves; otherwise exactly one is requested, which is the per-field control the
 * Table API lacks.
 */
function leafSelection(displayValue: boolean | 'all'): string {
	if (displayValue === 'all') return 'value displayValue';
	return displayValue === true ? 'displayValue' : 'value';
}

/**
 * Build the GlideRecord_Query document for a single table.
 *
 * `queryConditions` takes the same encoded query as the Table API, so no query
 * translation is needed — the operators, dot-walks, and ORDERBY directives carry
 * over unchanged.
 */
export function buildGlideRecordQuery(tableName: string, options: GraphqlQueryOptions): string {
	assertIdentifier(tableName, 'table name');

	const leaf = leafSelection(options.displayValue);
	const expandKeys = new Set(Object.keys(options.expand));

	const selections = options.fields.map((field) => {
		assertIdentifier(field, 'field name');
		const subFields = options.expand[field];
		if (!subFields) return `${field} { ${leaf} }`;

		// An expanded reference always carries its own value AND displayValue: the
		// caller asked to walk it, so both the sys_id handle and the human label are
		// what they came for.
		const nested = subFields
			.map((sub) => `${assertIdentifier(sub, 'field name')} { ${leaf} }`)
			.join(' ');
		return `${field} { value displayValue _reference { ${nested} } }`;
	});

	// A field named only in `expand` is still worth fetching — the caller clearly
	// wants it — so append any that `fields` did not already cover.
	for (const key of expandKeys) {
		if (options.fields.includes(key)) continue;
		assertIdentifier(key, 'field name');
		const nested = options.expand[key]
			.map((sub) => `${assertIdentifier(sub, 'field name')} { ${leaf} }`)
			.join(' ');
		selections.push(`${key} { value displayValue _reference { ${nested} } }`);
	}

	const args: string[] = [];
	if (options.query) {
		// JSON.stringify gives correct GraphQL string escaping for quotes and
		// backslashes, which encoded queries containing javascript: expressions do
		// carry.
		args.push(`queryConditions: ${JSON.stringify(options.query)}`);
	}
	args.push(`pagination: {limit: ${options.limit}, offset: ${options.offset}}`);

	return (
		`{ GlideRecord_Query { ${tableName}(${args.join(', ')}) ` +
		`{ _rowCount _results { ${selections.join(' ')} } } } }`
	);
}

/** The 7 fields `_table_metadata` exposes — verified by probing; there are no others. */
const TABLE_METADATA_SELECTION = 'label plural canRead canWrite canCreate canDelete auditWanted';

/**
 * Field-level metadata are FLAT SCALARS on the field leaf, not a nested
 * `_metadata` object — `_metadata`, `_columns`, `_field_metadata` and friends are
 * all undefined on this schema.
 */
const FIELD_METADATA_SELECTION = 'label internalType isMandatory canRead canWrite';

/**
 * Build the document that asks ServiceNow what the CALLING USER may do here.
 *
 * `_table_metadata` needs no arguments and no row. Field verdicts do need a row,
 * because they live on the field leaves inside `_results` — hence the limit-1
 * page, and hence `recordQuery` when the verdicts should describe one specific
 * record rather than an arbitrary one.
 */
export function buildEffectiveAccessQuery(
	tableName: string,
	options: EffectiveAccessOptions = {},
): string {
	assertIdentifier(tableName, 'table name');

	const fields = options.fields ?? [];
	const selections = [`_table_metadata { ${TABLE_METADATA_SELECTION} }`];
	const args: string[] = [];
	if (options.recordQuery) {
		args.push(`queryConditions: ${JSON.stringify(options.recordQuery)}`);
	}
	if (fields.length > 0) {
		args.push('pagination: {limit: 1, offset: 0}');
		const leaves = fields
			.map((field) => `${assertIdentifier(field, 'field name')} { ${FIELD_METADATA_SELECTION} }`)
			.join(' ');
		selections.push(`_results { ${leaves} }`);
	}

	const argList = args.length > 0 ? `(${args.join(', ')})` : '';
	return `{ GlideRecord_Query { ${tableName}${argList} { ${selections.join(' ')} } } }`;
}

/**
 * Flatten one GraphQL row into the Table-API-shaped record the tools already
 * emit, so `expand` changes what is fetched without changing the result contract
 * for every other field.
 *
 * Key naming follows the Table API (`display_value`, not GraphQL's
 * `displayValue`) for the same reason.
 */
function flattenRow(
	row: Record<string, unknown>,
	displayValue: boolean | 'all',
	expand: Record<string, string[]>,
): ServiceNowRecord {
	const out: Record<string, unknown> = {};

	const scalarOf = (leaf: FieldLeaf | null | undefined): unknown => {
		if (!leaf) return '';
		if (displayValue === 'all') {
			return { value: leaf.value ?? '', display_value: leaf.displayValue ?? '' };
		}
		return (displayValue === true ? leaf.displayValue : leaf.value) ?? '';
	};

	for (const [field, raw] of Object.entries(row)) {
		const leaf = raw as FieldLeaf | null;
		if (!expand[field]) {
			out[field] = scalarOf(leaf);
			continue;
		}

		const nested: Record<string, unknown> = {
			value: leaf?.value ?? '',
			display_value: leaf?.displayValue ?? '',
		};
		for (const [sub, subLeaf] of Object.entries(leaf?._reference ?? {})) {
			nested[sub] = scalarOf(subLeaf as FieldLeaf | null);
		}
		out[field] = nested;
	}

	return out as ServiceNowRecord;
}

/**
 * Does this error mean the GlideRecord GraphQL namespace is unusable here (so
 * fall back), as opposed to this particular query being wrong?
 */
function meansUnavailable(messages: string[]): boolean {
	return messages.some((m) => /GlideRecord_Query|Unknown type|not enabled/i.test(m));
}

export class GraphqlService {
	constructor(private instanceManager: InstanceManager) {}

	/**
	 * Run a single-table GlideRecord query.
	 *
	 * @throws GraphqlUnavailableError when the instance can't serve GraphQL at all
	 * @throws ServiceNowError when the query itself was rejected
	 */
	/**
	 * POST one document and return the `GlideRecord_Query` map, converting both
	 * transport and in-band failures into the two error types callers switch on.
	 */
	private async run(
		document: string,
		instance?: string,
	): Promise<Record<string, GlideRecordResult | null>> {
		const client = this.instanceManager.getClient(instance);

		let envelope: GraphqlEnvelope;
		try {
			envelope = await client.post<GraphqlEnvelope>(API_ENDPOINTS.GRAPHQL, {
				query: document,
			});
		} catch (error) {
			const status = (error as { statusCode?: number } | undefined)?.statusCode;
			if (status === 404 || status === 405) {
				throw new GraphqlUnavailableError('This instance does not expose /api/now/graphql.');
			}
			throw error;
		}

		// GraphQL reports failures in-band with HTTP 200, so the errors array — not
		// the status code — is the only signal that anything went wrong.
		if (envelope.errors && envelope.errors.length > 0) {
			const messages = envelope.errors.map((e) => e.message ?? 'unknown GraphQL error');
			if (meansUnavailable(messages)) {
				throw new GraphqlUnavailableError(
					`GraphQL GlideRecord namespace unavailable: ${messages.join('; ')}`,
				);
			}
			throw new ServiceNowError(`GraphQL query failed: ${messages.join('; ')}`, 400);
		}

		return envelope.data?.GlideRecord_Query ?? {};
	}

	async queryRecords(
		tableName: string,
		options: GraphqlQueryOptions,
		instance?: string,
	): Promise<GraphqlQueryResult> {
		const document = buildGlideRecordQuery(tableName, options);

		logger.debug(`GraphQL query on ${tableName}`, { instance: instance || 'default' });

		const result = (await this.run(document, instance))[tableName];
		if (!result) {
			throw new GraphqlUnavailableError(
				`GraphQL returned no GlideRecord result for table '${tableName}'.`,
			);
		}

		const rows = result._results ?? [];
		return {
			records: rows.map((row) => flattenRow(row, options.displayValue, options.expand)),
			totalCount: typeof result._rowCount === 'number' ? result._rowCount : null,
		};
	}

	/**
	 * Ask ServiceNow what the authenticated caller may actually do on this table.
	 *
	 * This is the platform's own verdict, evaluated on the credentials this MCP
	 * connects with — not an inference from ACL rows, and not the more-privileged
	 * background-script identity `sn_diagnose_mutation` reports on.
	 *
	 * @throws GraphqlUnavailableError when the instance can't serve GraphQL at all
	 * @throws ServiceNowError when the table itself resolved to null
	 */
	async fetchEffectiveAccess(
		tableName: string,
		options: EffectiveAccessOptions = {},
		instance?: string,
	): Promise<EffectiveAccessResult> {
		const document = buildEffectiveAccessQuery(tableName, options);

		logger.debug(`GraphQL effective-access probe on ${tableName}`, {
			instance: instance || 'default',
		});

		const map = await this.run(document, instance);
		if (!(tableName in map)) {
			throw new GraphqlUnavailableError(
				`GraphQL returned no GlideRecord result for table '${tableName}'.`,
			);
		}
		const result = map[tableName];
		// A table that does not exist resolves to null with NO error — the same
		// silent shape an unknown field takes. Say so, rather than let a missing
		// verdict be read as a denial.
		if (!result) {
			throw new ServiceNowError(
				`GraphQL resolved table '${tableName}' to null — the table does not exist or is not exposed to this caller.`,
				404,
			);
		}

		const metadata = result._table_metadata ?? {};
		const table: TableAccessVerdict = {
			label: textOf(metadata.label),
			plural: textOf(metadata.plural),
			canRead: boolOf(metadata.canRead),
			canWrite: boolOf(metadata.canWrite),
			canCreate: boolOf(metadata.canCreate),
			canDelete: boolOf(metadata.canDelete),
			auditWanted: boolOf(metadata.auditWanted),
		};

		const requested = options.fields ?? [];
		if (requested.length === 0) {
			return { table, fields: [], fieldVerdicts: 'not_requested', unresolvedFields: [] };
		}

		const row = result._results?.[0];
		if (!row) {
			return { table, fields: [], fieldVerdicts: 'no_sample_row', unresolvedFields: [] };
		}

		const fields: FieldAccessVerdict[] = [];
		const unresolvedFields: string[] = [];
		for (const field of requested) {
			const leaf = row[field] as Record<string, unknown> | null | undefined;
			if (!leaf) {
				unresolvedFields.push(field);
				continue;
			}
			fields.push({
				field,
				label: textOf(leaf.label),
				internalType: textOf(leaf.internalType),
				isMandatory: boolOf(leaf.isMandatory),
				canRead: boolOf(leaf.canRead),
				canWrite: boolOf(leaf.canWrite),
			});
		}

		return { table, fields, fieldVerdicts: 'resolved', unresolvedFields };
	}
}

/** A metadata scalar, or null when GraphQL omitted it (never coerced to false). */
function boolOf(value: unknown): boolean | null {
	if (typeof value === 'boolean') return value;
	if (value === 'true') return true;
	if (value === 'false') return false;
	return null;
}

function textOf(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}
