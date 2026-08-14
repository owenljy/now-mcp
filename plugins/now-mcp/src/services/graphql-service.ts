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
	async queryRecords(
		tableName: string,
		options: GraphqlQueryOptions,
		instance?: string,
	): Promise<GraphqlQueryResult> {
		const client = this.instanceManager.getClient(instance);
		const document = buildGlideRecordQuery(tableName, options);

		logger.debug(`GraphQL query on ${tableName}`, { instance: instance || 'default' });

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

		const result = envelope.data?.GlideRecord_Query?.[tableName];
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
}
