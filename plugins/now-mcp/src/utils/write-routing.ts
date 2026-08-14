/**
 * Write routing: tables whose rows must NOT be created with a plain Table API
 * insert, because a mandatory platform engine sits in front of them.
 *
 * The Table API will happily accept the insert and return 201. That is the
 * problem — the row lands without the processing that makes it meaningful, and
 * nothing reports an error. This is the one place where "the MCP writes data
 * rows" is too coarse a rule: a few tables are the OUTPUT of an engine, not an
 * input surface.
 *
 * Scope note: this guards INSERTS only. Updating or deleting an existing row by
 * sys_id (closing an incident's request item, correcting a CI's description) is
 * ordinary data maintenance and is left alone.
 *
 * Endpoints below were verified present on a live instance (Zurich-era PDI):
 * `/api/now/identifyreconcile` responds 405 to GET (registered, POST-only),
 * `/api/now/cmdb/instance/{class}` and `/api/sn_sc/servicecatalog/*` both 200.
 */

export interface WriteRoute {
	/** Human label for the engine being bypassed. */
	engine: string;
	/** What goes wrong if the insert happens anyway. */
	consequence: string;
	/** The API that should be used instead. */
	useInstead: string;
}

interface RouteRule {
	/** Cheap name-based candidate test. */
	matches: (table: string) => boolean;
	/**
	 * When set, the candidate is only routed if the table actually descends from
	 * this table. A name prefix is not proof of membership in a hierarchy — on a
	 * stock instance `cmdb_ci_outage`, `cmdb_ci_model_entry` and the
	 * `cmdb_ci_m2m_*` join tables all start with `cmdb_ci_` and none of them
	 * extend `cmdb_ci`. Blocking an outage insert would break correct work, so
	 * the prefix only nominates and inheritance decides.
	 */
	requiresAncestor?: string;
	route: WriteRoute;
}

const CATALOG_TABLES = new Set(['sc_request', 'sc_req_item', 'sc_task', 'sc_cart', 'sc_cart_item']);

const RULES: RouteRule[] = [
	{
		matches: (t) => t === 'cmdb_ci' || t.startsWith('cmdb_ci_') || t === 'cmdb_rel_ci',
		// cmdb_rel_ci does not extend cmdb_ci, so it is matched by exact name above
		// and exempted from the ancestor test by the check in resolveWriteRoute.
		requiresAncestor: 'cmdb_ci',
		route: {
			engine: 'Identification and Reconciliation Engine (IRE)',
			consequence:
				'A direct insert skips identification, so a CI that already exists is created a ' +
				'second time instead of being matched and updated. Duplicate CIs corrupt ' +
				'relationships, service maps, and every downstream report, and they are painful ' +
				'to merge afterwards.',
			useInstead:
				'POST /api/now/identifyreconcile (payload keyed by CI class with identification ' +
				'rules applied), or /api/now/cmdb/instance/{className} for single-CI writes. ' +
				'Server-side, sn_cmdb.IdentificationEngineScriptableApi via ' +
				'sn_execute_background_script is equivalent.',
		},
	},
	{
		matches: (t) => CATALOG_TABLES.has(t),
		route: {
			engine: 'Service Catalog ordering (cart / order-now)',
			consequence:
				'A request row inserted directly has no catalog item pricing, no variable ' +
				'answers, and no workflow or approval attached — nothing ever picks it up, so ' +
				'it sits as a dead record that looks like a real request.',
			useInstead:
				'POST /api/sn_sc/servicecatalog/items/{sys_id}/order_now (or the cart endpoints ' +
				'for a multi-item request), which runs the catalog workflow.',
		},
	},
];

/** Tables routed by exact name, which therefore skip the inheritance test. */
const EXACT_NAME_ROUTED = new Set(['cmdb_ci', 'cmdb_rel_ci']);

/** Resolves whether a table descends from another. Satisfied by SchemaService. */
export interface AncestryResolver {
	extendsFrom(tableName: string, ancestor: string, instance?: string): Promise<boolean | null>;
}

/**
 * Name-based candidate lookup. Exposed for the exact-name cases and for tests;
 * prefer resolveWriteRoute, which also confirms hierarchy membership.
 */
export function lookupWriteRoute(tableName: string): WriteRoute | null {
	const table = tableName.toLowerCase();
	return RULES.find((r) => r.matches(table))?.route ?? null;
}

/**
 * Resolve the routing rule that actually applies to a table.
 *
 * Fails OPEN when the hierarchy cannot be resolved (no dictionary access): a
 * schema read failure is unrelated to the caller's insert, and blocking on it
 * would turn a degraded permission into a hard stop on legitimate writes.
 */
export async function resolveWriteRoute(
	tableName: string,
	resolver?: AncestryResolver,
	instance?: string,
): Promise<WriteRoute | null> {
	const table = tableName.toLowerCase();
	const rule = RULES.find((r) => r.matches(table));
	if (!rule) return null;
	if (!rule.requiresAncestor || EXACT_NAME_ROUTED.has(table)) return rule.route;
	// Without a resolver we cannot tell a CI class from cmdb_ci_outage, so the
	// only safe default is to let the insert through.
	if (!resolver) return null;

	const descends = await resolver.extendsFrom(table, rule.requiresAncestor, instance);
	return descends === true ? rule.route : null;
}

/**
 * Build the blocking message for a routed insert. Names the engine, the
 * concrete consequence, and the replacement call, then the escape hatch — the
 * caller may have a legitimate reason (seeding test data, importing a snapshot
 * where duplicates are acceptable).
 */
export function formatWriteRoutingError(tableName: string, route: WriteRoute): string {
	return (
		`Insert into '${tableName}' was blocked: it bypasses the ${route.engine}.\n\n` +
		`${route.consequence}\n\n` +
		`Use instead: ${route.useInstead}\n\n` +
		`ServiceNow would have returned 201 for the direct insert without flagging any of ` +
		`this, which is why the check happens here. If a direct insert is genuinely what you ` +
		`want, pass acknowledgeRoutingRisk: true.`
	);
}

/**
 * Pre-flight for the insert tools: returns the blocking message, or null when
 * the insert may proceed (table not routed, or the caller acknowledged the risk).
 */
export async function checkWriteRouting(
	tableName: string,
	acknowledged: boolean | undefined,
	resolver?: AncestryResolver,
	instance?: string,
): Promise<string | null> {
	if (acknowledged) return null;
	const route = await resolveWriteRoute(tableName, resolver, instance);
	return route ? formatWriteRoutingError(tableName, route) : null;
}
