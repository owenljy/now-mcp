/**
 * Field-name extraction from a ServiceNow encoded query.
 *
 * Why this exists: GlideRecord SILENTLY DROPS a condition whose field name it
 * doesn't recognize. Verified on a live instance (incident, 67 rows total):
 *
 *     priority=1    -> X-Total-Count: 27
 *     priorityy=1   -> X-Total-Count: 67   (whole table, HTTP 200, no error)
 *
 * So a single typo turns a filtered read into an unfiltered one that reports
 * success. The same happens on the GraphQL GlideRecord namespace (an unknown
 * field resolves to null with an empty `errors` array), so it is a GlideRecord
 * behaviour, not a Table-API one — no transport change fixes it.
 *
 * Nothing downstream can catch this: the zero-result hints only fire on an
 * EMPTY result, and this failure mode produces TOO MANY rows. The only defence
 * is to check the field names before the query is sent, which is what this
 * parser feeds.
 *
 * Design stance: parse conservatively and SKIP anything ambiguous. A missed
 * typo costs us nothing (status quo); a mis-parsed clause reported as a typo
 * would block a legitimate query, so silence beats a guess.
 */

/**
 * Encoded-query operators, longest-first so that a prefix never shadows a
 * longer operator (LIKE must be tried before nothing, NOTLIKE before LIKE,
 * ISNOTEMPTY before ISEMPTY).
 *
 * Word operators are matched case-SENSITIVELY as upper case: encoded-query
 * operators are upper case by convention while field names are lower case, and
 * that asymmetry is what lets us find the field/operator boundary in a run of
 * characters like `commentsISNOTEMPTY`.
 */
const WORD_OPERATORS = [
	'ISNOTEMPTY',
	'ISEMPTY',
	'ANYTHING',
	'EMPTYSTRING',
	'STARTSWITH',
	'ENDSWITH',
	'NOTLIKE',
	'LIKE',
	'NOT IN',
	'IN',
	'BETWEEN',
	'INSTANCEOF',
	'VALCHANGES',
	'CHANGESFROM',
	'CHANGESTO',
	'NSAMEAS',
	'SAMEAS',
	'DYNAMIC',
	'RELATIVEGE',
	'RELATIVELE',
	'RELATIVEGT',
	'RELATIVELT',
	'NOTON',
	'ON',
];

/** Symbol operators, longest-first (>= before >, != before =). */
const SYMBOL_OPERATORS = ['>=', '<=', '!=', '=', '>', '<'];

/**
 * Clause prefixes that are followed by a bare field name rather than a
 * condition. Longest-first: ORDERBYDESC must win over ORDERBY.
 */
const FIELD_DIRECTIVES = ['ORDERBYDESC', 'ORDERBY', 'GROUPBY'];

/**
 * Clause prefixes carrying no plain field reference we can check. Related-list
 * and join queries embed their own sub-syntax; treating their operands as field
 * names on THIS table would produce false positives.
 */
const OPAQUE_DIRECTIVES = ['RLQUERY', 'ENDRLQUERY', 'JOIN', 'ENDJOIN', 'GOTO'];

/** A plain field reference, optionally dot-walked (caller_id.department.name). */
const FIELD_SHAPE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/i;

/**
 * Locate the earliest operator in a clause and return the text before it.
 * Returns null when no operator is present (the clause is not a condition we
 * can read), so the caller skips it rather than guessing.
 */
function fieldBeforeOperator(clause: string): string | null {
	let best = -1;

	for (const op of [...WORD_OPERATORS, ...SYMBOL_OPERATORS]) {
		const idx = clause.indexOf(op);
		// idx must be > 0: an operator at position 0 means there is no field name.
		if (idx > 0 && (best === -1 || idx < best)) best = idx;
	}

	if (best === -1) return null;
	return clause.slice(0, best);
}

/**
 * Extract the field names referenced by an encoded query.
 *
 * Handles the `^` / `^OR` / `^NQ` / `^EQ` clause separators, the ORDERBY /
 * ORDERBYDESC / GROUPBY directives, and dot-walked references (returned whole —
 * the caller validates the first segment, since the rest resolves on another
 * table).
 *
 * Separator handling: matching the `OR` marker greedily reads `^ORoriginal_field=2`
 * as an OR-join on `original_field` and `^origin_table=x` as an AND-join on
 * `origin_table`, which are both the intended readings. The one case greed gets
 * wrong is `^ORDERBY…`, where the `OR` belongs to the directive rather than being
 * a join marker — hence the `(?!DERBY)` guard, without which `ORDERBYDESCsys_updated_on`
 * degrades to the unparseable `DERBYDESCsys_updated_on` and the ordering field is
 * silently skipped. The guard is case-sensitive because directives are upper case
 * while field names are lower case, so a column named `derby_x` still parses.
 */
export function extractQueryFields(query: string | undefined): string[] {
	if (!query) return [];

	const found: string[] = [];
	const seen = new Set<string>();

	for (const rawClause of query.split(/\^(?:OR(?!DERBY)|NQ|EQ)?/)) {
		const clause = rawClause.trim();
		if (!clause) continue;

		if (OPAQUE_DIRECTIVES.some((d) => clause.startsWith(d))) continue;

		// ORDERBY / ORDERBYDESC / GROUPBY are followed by a bare field name.
		const directive = FIELD_DIRECTIVES.find((d) => clause.startsWith(d));
		const candidate = directive ? clause.slice(directive.length) : fieldBeforeOperator(clause);

		if (!candidate) continue;
		if (!FIELD_SHAPE.test(candidate)) continue;
		if (seen.has(candidate)) continue;

		seen.add(candidate);
		found.push(candidate);
	}

	return found;
}
