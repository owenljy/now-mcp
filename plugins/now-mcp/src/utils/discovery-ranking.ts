/**
 * Relevance ranking for the discovery tools (`sn_list_tables`, `sn_find_fields`).
 *
 * ServiceNow returns discovery results in name order, which is not relevance
 * order — a substring match on an obscure staging table sorts ahead of the exact
 * table you asked for whenever its name happens to come first alphabetically.
 * Both tool descriptions previously pushed that work onto the caller ("Ranking
 * is yours to do"), which costs a full result set of context to do badly.
 *
 * Scoring is deterministic and explainable: every rule is a fixed bonus, ties
 * break on name length then name, so the same query always produces the same
 * order and a surprising position can be traced to a rule.
 */

/** Fixed score contributions, highest signal first. */
const SCORE = {
	/** The query IS the table/column name. Nothing outranks this. */
	exactName: 1000,
	/** The query IS the human label. */
	exactLabel: 800,
	/** Name begins with the query — `incident_task` for "incident". */
	prefixName: 400,
	prefixLabel: 300,
	/** A core/global table beats an unrelated store app's table of the same name. */
	coreScope: 120,
	/** Every keyword matched, not just one. */
	allKeywords: 150,
	/** Plain substring hit — the weakest signal, and the default. */
	substring: 50,
} as const;

/**
 * Name fragments marking a table as derived rather than primary.
 *
 * A search for "incident" wants `incident`, not `incident_metric`,
 * `sys_audit_incident`, or an import staging mirror. These are demoted rather
 * than filtered: they are legitimate answers to some questions, just never the
 * best answer to a bare concept search.
 */
const SATELLITE_MARKERS = [
	'_ext_staging',
	'_staging',
	'_import',
	'_history',
	'_metric',
	'_audit',
	'_archive',
	'_snapshot',
	'_m2m_',
	'_list',
	'_index',
];

/** Penalty applied per satellite marker matched (capped by matching only once). */
const SATELLITE_PENALTY = 200;

export interface RankableItem {
	/** Table name or column name — the machine identifier. */
	name: string;
	/** Human label, when the row has one. */
	label?: string;
	/** Scope api_name; absent/"global" counts as core. */
	scope?: string;
	/** Which of the caller's keywords this row matched, as returned by the search. */
	matched?: string;
	/** Optional final deterministic tie-breaker (for fields, table + element). */
	stableKey?: string;
}

export interface ScoredItem<T> {
	item: T;
	score: number;
}

function isCoreScope(scope?: string): boolean {
	return !scope || scope === 'global';
}

function isSatellite(name: string): boolean {
	return SATELLITE_MARKERS.some((marker) => name.includes(marker));
}

/**
 * Relevance score for one row against the caller's search terms.
 *
 * `terms` is the union of what the caller supplied — the `filter` fragment and
 * any `concept` keywords — lowercased. An empty term list means the caller
 * asked for everything, in which case only the structural signals (core scope,
 * not a satellite) apply and the result stays essentially in name order.
 */
export function scoreItem(item: RankableItem, terms: string[]): number {
	const name = item.name.toLowerCase();
	const label = (item.label ?? '').toLowerCase();
	let score = 0;

	for (const term of terms) {
		if (!term) continue;
		if (name === term) score += SCORE.exactName;
		else if (label === term) score += SCORE.exactLabel;
		else if (name.startsWith(term)) score += SCORE.prefixName;
		else if (label.startsWith(term)) score += SCORE.prefixLabel;
		else if (name.includes(term) || label.includes(term)) score += SCORE.substring;
	}

	// A row that hit every keyword is a better answer than one that hit a single
	// generic keyword, even when both technically "matched".
	if (terms.length > 1 && item.matched) {
		const hits = item.matched.split(',').filter(Boolean).length;
		if (hits >= terms.length) score += SCORE.allKeywords;
	}

	if (isCoreScope(item.scope)) score += SCORE.coreScope;
	if (isSatellite(name)) score -= SATELLITE_PENALTY;

	return score;
}

/**
 * Sort rows by relevance, highest first.
 *
 * Ties break on name length (the shorter name is the base table far more often
 * than not — `incident` before `incident_task`) and then alphabetically, so the
 * order is total and stable rather than dependent on input order.
 */
export function rankItems<T extends RankableItem>(items: T[], terms: string[]): ScoredItem<T>[] {
	return items
		.map((item) => ({ item, score: scoreItem(item, terms) }))
		.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			if (a.item.name.length !== b.item.name.length) {
				return a.item.name.length - b.item.name.length;
			}
			const nameOrder = a.item.name.localeCompare(b.item.name);
			if (nameOrder !== 0) return nameOrder;
			return (a.item.stableKey ?? '').localeCompare(b.item.stableKey ?? '');
		});
}

/**
 * The search terms a ranking should use, normalized.
 *
 * A `filter` carries wildcard anchors (`incident*`) that are query syntax, not
 * part of the word being matched — leaving them in would stop every exact-match
 * rule from ever firing.
 */
export function rankingTerms(filter?: string, concept?: string[]): string[] {
	const terms: string[] = [];
	if (filter) {
		const core = filter.replace(/^\*+/, '').replace(/\*+$/, '').trim().toLowerCase();
		if (core) terms.push(core);
	}
	for (const keyword of concept ?? []) {
		const k = keyword.trim().toLowerCase();
		if (k) terms.push(k);
	}
	return terms;
}
