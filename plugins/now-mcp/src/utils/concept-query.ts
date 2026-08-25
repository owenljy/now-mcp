/**
 * Shared builder for concept searches over the dictionary tables
 * (`sys_db_object`, `sys_dictionary`).
 *
 * Both of the traps below fail SILENTLY — they produce a plausible-looking
 * result set rather than an error — so they are enforced here instead of being
 * left to each call site:
 *
 * 1. OR-GROUP PLACEMENT. ServiceNow parses `A^B^C^ORD` as `A AND B AND (C OR D)`:
 *    a run of `^OR` terms binds only to the LAST condition, not to the whole
 *    chain. Every AND-ed condition (class filter, name filter, noise exclusions)
 *    must therefore be emitted BEFORE the OR'd keyword terms. Get it backwards
 *    and the exclusion lands inside the OR group and stops filtering, widening
 *    the result with no error. Measured on a live instance:
 *    `column_labelLIKEescalat` matches 166 field rows on its own and 50 with the
 *    `var__m_` exclusion AND-ed in front — misordering silently restores the 116
 *    noise rows. `appendConceptOrGroup` is the only way to add the OR group, and
 *    it always appends, so the ordering cannot be expressed wrongly.
 *
 * 2. OPERATOR INJECTION. A keyword carrying `^`, `=`, `,`, `<`, `>` or `!` would
 *    be parsed as query syntax rather than as text, silently changing the
 *    query's meaning. Those characters are stripped from every keyword.
 */

/** Characters that would be read as encoded-query syntax instead of text. */
const OPERATOR_CHARS = /[\^=,<>!]/g;

/**
 * Strip query operators, drop blanks, and de-duplicate case-insensitively.
 * Keyword variants often overlap ("chat"/"Chat"); querying the same term twice
 * only pays for it twice.
 */
export function sanitizeKeywords(keywords: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of keywords) {
		const kw = raw.replace(OPERATOR_CHARS, '').trim();
		if (!kw) continue;
		const key = kw.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(kw);
	}
	return out;
}

/**
 * Append `(field LIKE kw OR …)` for every field/keyword pair.
 *
 * MUST be called only after every AND-ed condition is already in `base` — see
 * trap 1 above. Returns `base` unchanged when there is nothing to match, so an
 * empty keyword list can never widen the query.
 */
export function appendConceptOrGroup(base: string, fields: string[], keywords: string[]): string {
	const terms: string[] = [];
	for (const kw of keywords) {
		for (const field of fields) terms.push(`${field}LIKE${kw}`);
	}
	if (terms.length === 0) return base;
	return `${base}^${terms.join('^OR')}`;
}

/**
 * Which of `keywords` actually appear in the given text values, so a caller can
 * see which of its guesses paid off and pick better variants next round.
 * Recomputed locally rather than asked of the instance — `LIKE` reports that a
 * row matched, never which term matched it.
 */
export function matchedKeywords(
	haystacks: (string | undefined | null)[],
	keywords: string[],
): string[] {
	const hay = haystacks
		.filter((h): h is string => Boolean(h))
		.join(' ')
		.toLowerCase();
	return keywords.filter((kw) => hay.includes(kw.toLowerCase()));
}
