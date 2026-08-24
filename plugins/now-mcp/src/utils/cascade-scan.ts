/**
 * What a delete would take with it.
 *
 * ServiceNow answers "what does this record reference" trivially — the values
 * are on the record. The reverse has no single API, and it is the direction
 * that matters before a delete: the only record of what happens to the rows
 * pointing AT the target is `sys_dictionary.reference_cascade_rule`, one
 * setting per reference column.
 *
 * A `restrict` rule is self-announcing — delete anyway and the platform refuses
 * with an error. The dangerous one is `delete`/`cascade`: it succeeds, silently
 * removing every referencing row, with no undo. That asymmetry is why this
 * scan exists and why it only looks at columns whose rule actually does
 * something. Inert columns (`none`, or no rule at all) leave dangling
 * references — a data-quality problem, not a destructive one — and probing them
 * would multiply the cost by an order of magnitude: on a stock instance 463
 * reference columns target incident/task, of which 37 carry a live rule.
 */

import type { SchemaService } from '../services/schema-service.js';
import type { TableService } from '../services/table-service.js';
import { logger } from './logger.js';
import { isTableAllowed, parseTableList } from './table-access.js';

/** Dictionary rows read before filtering. Bounds the read, not the probe. */
const MAX_CANDIDATES_FETCHED = 1000;

/**
 * Columns counted per scan. Only rule-carrying columns get here, so this is
 * generous in practice (incident/task: 37) while still bounding a pathological
 * table. Exceeding it is reported, never silently truncated.
 */
const MAX_PROBES = 60;

/** Concurrent Stats calls. Enough to hide latency, low enough to stay polite. */
const PROBE_CONCURRENCY = 8;

/** Named individually in `notProbed` before it collapses to a count. */
const MAX_NOT_PROBED_NAMED = 30;

export type DeleteEffect = 'blocks_delete' | 'deletes_referencing_rows' | 'clears_field';

/**
 * sys_dictionary.reference_cascade_rule → what happens to the referencing row
 * when the target is deleted. `undefined` for the inert rules (`none`, empty),
 * which is also how a column is filtered out of the scan.
 */
export function deleteEffect(cascadeRule: string | undefined): DeleteEffect | undefined {
	switch ((cascadeRule ?? '').trim()) {
		case 'restrict':
		case 'restrain':
			return 'blocks_delete';
		case 'delete':
		case 'cascade':
		case 'delete_no_workflow':
			return 'deletes_referencing_rows';
		case 'clear':
			return 'clears_field';
		default:
			return undefined;
	}
}

/** Probe order: the consequence a caller must not miss goes first. */
const EFFECT_RANK: Record<DeleteEffect, number> = {
	deletes_referencing_rows: 0,
	blocks_delete: 1,
	clears_field: 2,
};

export const CASCADE_COLUMNS = ['table', 'field', 'count', 'cascadeRule', 'onDelete'];

export interface CascadeImpact {
	/** False when the scan could not run; `skipReason` says why. Callers must
	 * fail OPEN on this — an unreadable dictionary is not grounds to refuse a
	 * delete the user asked for. */
	scanned: boolean;
	skipReason?: string;
	/** The target table and its ancestors — a column declared against `task`
	 * holds incident sys_ids too. */
	chain: string[];
	/** Reference columns carrying a live cascade rule, before the probe cap. */
	candidates: number;
	probed: number;
	/** One row per column that MATCHED, in CASCADE_COLUMNS order. */
	rows: unknown[][];
	/** "table.field" whose rule will make the platform refuse the delete. */
	blockedBy: string[];
	/** Rows that would be deleted along with the target(s). */
	cascadeRowCount: number;
	/** Rows whose reference would be nulled, the row itself surviving. */
	clearedRowCount: number;
	/** Rule-carrying columns left unprobed by the cap, named. */
	notProbed?: string[];
	notProbedCount?: number;
	/** Probed but uncountable — no read access, or not a queryable table. */
	unreadable?: string[];
}

interface Candidate {
	table: string;
	field: string;
	cascadeRule: string;
	effect: DeleteEffect;
}

/** Run `worker` over `items` with a fixed number of in-flight calls. */
async function pooled<T, R>(
	items: T[],
	limit: number,
	worker: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (true) {
				const i = next++;
				if (i >= items.length) return;
				results[i] = await worker(items[i]);
			}
		}),
	);
	return results;
}

/** Pull the count out of a Stats API `{stats:{count:"N"}}` result. */
function statsCount(result: unknown): number | null {
	const stats = (result as { stats?: { count?: string | number } } | undefined)?.stats;
	if (stats?.count === undefined) return null;
	const n = typeof stats.count === 'number' ? stats.count : parseInt(stats.count, 10);
	return Number.isFinite(n) ? n : null;
}

const EMPTY = (skipReason: string): CascadeImpact => ({
	scanned: false,
	skipReason,
	chain: [],
	candidates: 0,
	probed: 0,
	rows: [],
	blockedBy: [],
	cascadeRowCount: 0,
	clearedRowCount: 0,
});

/**
 * Count the rows that a delete of `sysIds` would destroy, block on, or orphan.
 *
 * Cost is independent of how many sys_ids are passed: each column is counted
 * once with an IN over the whole set, so deleting fifty records costs the same
 * scan as deleting one.
 *
 * Never throws. Any failure — unreadable dictionary, network, a blocked table —
 * returns `scanned: false` so the caller can proceed rather than have a
 * diagnostic become a gate it cannot clear.
 */
export async function scanCascadeImpact(
	tableService: Pick<TableService, 'queryRecords' | 'aggregateRecords'>,
	schemaService: Pick<SchemaService, 'tableChain'>,
	opts: { tableName: string; sysIds: string[]; instance?: string },
): Promise<CascadeImpact> {
	const { tableName, sysIds, instance } = opts;
	if (sysIds.length === 0) return EMPTY('no sys_ids');

	let candidates: Candidate[];
	let chain: string[];
	try {
		chain = await schemaService.tableChain(tableName, instance);
		if (chain.length === 0) chain = [tableName];

		const dictRows = (await tableService.queryRecords(
			'sys_dictionary',
			{
				query: `internal_type=reference^referenceIN${chain.join(',')}^elementISNOTEMPTY^ORDERBYname`,
				fields: ['name', 'element', 'reference_cascade_rule'],
				limit: MAX_CANDIDATES_FETCHED,
			},
			instance,
		)) as unknown as Array<{ name?: string; element?: string; reference_cascade_rule?: string }>;

		const blockedTables = parseTableList(process.env.SERVICENOW_BLOCKED_TABLES);
		const allowedTables = parseTableList(process.env.SERVICENOW_ALLOWED_TABLES);

		candidates = dictRows.flatMap((r) => {
			const table = r.name;
			const field = r.element;
			if (!table || !field) return [];
			if (!isTableAllowed(table, { blocked: blockedTables, allowed: allowedTables })) return [];
			const cascadeRule = (r.reference_cascade_rule ?? '').trim();
			const effect = deleteEffect(cascadeRule);
			// Inert rules are dropped here — see the file header for why.
			if (!effect) return [];
			return [{ table, field, cascadeRule, effect }];
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		logger.debug(`Cascade scan skipped for ${tableName}`, { error: reason });
		return EMPTY(`candidate discovery failed: ${reason}`);
	}

	candidates.sort(
		(a, b) =>
			EFFECT_RANK[a.effect] - EFFECT_RANK[b.effect] ||
			a.table.localeCompare(b.table) ||
			a.field.localeCompare(b.field),
	);

	const toProbe = candidates.slice(0, MAX_PROBES);
	const skipped = candidates.slice(MAX_PROBES);
	// One count per column covers every target at once, so a fifty-record
	// delete costs the same scan as a one-record delete.
	const idClause = sysIds.join(',');

	const probed = await pooled(toProbe, PROBE_CONCURRENCY, async (c) => {
		try {
			const result = await tableService.aggregateRecords(
				c.table,
				{ query: `${c.field}IN${idClause}`, count: true },
				instance,
			);
			return { ...c, count: statsCount(result) };
		} catch (error) {
			// One unreadable table must not sink the scan — an ACL on some
			// unrelated table is not an answer to the question asked.
			logger.debug(`Cascade probe failed on ${c.table}.${c.field}`, {
				error: error instanceof Error ? error.message : String(error),
			});
			return { ...c, count: null };
		}
	});

	const hits = probed.filter((p) => (p.count ?? 0) > 0);
	hits.sort(
		(a, b) => EFFECT_RANK[a.effect] - EFFECT_RANK[b.effect] || (b.count ?? 0) - (a.count ?? 0),
	);
	const sumWhere = (effect: DeleteEffect) =>
		hits.filter((h) => h.effect === effect).reduce((n, h) => n + (h.count ?? 0), 0);

	const unreadable = probed.filter((p) => p.count === null).map((c) => `${c.table}.${c.field}`);

	const impact: CascadeImpact = {
		scanned: true,
		chain,
		candidates: candidates.length,
		probed: toProbe.length,
		rows: hits.map((h) => [h.table, h.field, h.count, h.cascadeRule, h.effect]),
		blockedBy: hits.filter((h) => h.effect === 'blocks_delete').map((h) => `${h.table}.${h.field}`),
		cascadeRowCount: sumWhere('deletes_referencing_rows'),
		clearedRowCount: sumWhere('clears_field'),
	};
	if (skipped.length > 0) {
		impact.notProbed = skipped.slice(0, MAX_NOT_PROBED_NAMED).map((c) => `${c.table}.${c.field}`);
		impact.notProbedCount = skipped.length;
	}
	if (unreadable.length > 0) impact.unreadable = unreadable;
	return impact;
}

/** True when the delete would destroy other rows or be refused outright. */
export function isConsequential(impact: CascadeImpact): boolean {
	return impact.cascadeRowCount > 0 || impact.blockedBy.length > 0;
}
