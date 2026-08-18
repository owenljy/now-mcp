/**
 * Cost hints for sn_query_records: a detector that judges a SUCCESSFUL
 * result for wastefulness and steers the caller toward the cheaper call.
 * Deliberately separate from failure-enrichment.ts, which classifies
 * failures (HTTP status, ACL remediation) — a different input shape and a
 * different tuning problem.
 *
 * Stated bias: a missed hint costs the status quo; a false hint costs
 * tokens AND teaches the caller to skip hints. Every rule here is
 * calibrated toward silence over a false positive.
 *
 * Pure and synchronous over rows already in memory (bounded by the render
 * cap) — no schema call, no second query, no session state beyond the
 * injectable decay counter.
 */

export interface CostHintInput {
	table: string;
	fields?: string[];
	query?: string;
	limit: number;
	fetchedCount: number;
	totalMatching: number | null;
	truncated: boolean;
	expandUsed: boolean;
	queryPolicy: 'safe' | 'allow_expensive';
	columns: string[];
	rows: unknown[][];
}

export interface CostHintOutput {
	costHint?: string;
	distributions?: Record<string, Record<string, number>>;
}

type RuleId = 'A' | 'B' | 'C' | 'D' | 'E';

/** Per-process decay: after a rule fires 3x, it stops firing. Injectable so tests get a fresh counter. */
export interface CostHintDecayState {
	counts: Map<RuleId, number>;
}

export function createCostHintDecayState(): CostHintDecayState {
	return { counts: new Map() };
}

const DECAY_LIMIT = 3;
const MAX_CATEGORICAL_DISTINCT = 12;
const IDENTIFIER_NAME_RE = /^sys_id$|_id$|^number$|^guid$/i;
const SYS_ID_SHAPE_RE = /^[0-9a-f]{32}$/i;

function columnValues(input: CostHintInput, colIndex: number): unknown[] {
	return input.rows.map((row) => row[colIndex]);
}

function isIdentifierColumn(name: string, values: unknown[]): boolean {
	if (IDENTIFIER_NAME_RE.test(name)) return true;
	const nonNull = values.filter((v) => v !== null && v !== undefined);
	return (
		nonNull.length > 0 && nonNull.every((v) => typeof v === 'string' && SYS_ID_SHAPE_RE.test(v))
	);
}

function isCategoricalColumn(values: unknown[]): { categorical: boolean; distinct: string[] } {
	const nonNull = values.filter((v) => v !== null && v !== undefined && typeof v !== 'object');
	if (nonNull.length === 0) return { categorical: false, distinct: [] };
	const distinct = Array.from(new Set(nonNull.map((v) => String(v))));
	return { categorical: distinct.length <= MAX_CATEGORICAL_DISTINCT, distinct };
}

function classifyColumns(input: CostHintInput) {
	return input.columns.map((name, i) => {
		const values = columnValues(input, i);
		const identifier = isIdentifierColumn(name, values);
		const { categorical, distinct } = isCategoricalColumn(values);
		return { name, identifier, categorical: !identifier && categorical, distinct };
	});
}

function byteLen(x: string): number {
	return Buffer.byteLength(x);
}

function formatKB(bytes: number): string {
	return `${(bytes / 1000).toFixed(1)} KB`;
}

/** R2: mechanical exemptions, evaluated before any rule. */
function isExempt(input: CostHintInput): boolean {
	if (input.limit <= 5) return true;
	// A narrow 1-2 field selection is presumptively a deliberate, well-scoped
	// read — UNLESS it's also fetching at scale (>=100 rows), which is exactly
	// the "sys_id harvest with no bound" shape rule D/B exist to catch. A
	// literal, unconditional fields.length<=2 exemption would silence that
	// case entirely; feature.md's own worked example (fields:["sys_id"] at
	// limit:1000) is exactly the call this scoping preserves a hint for.
	if (input.fields && input.fields.length <= 2 && input.fetchedCount < 100) return true;
	if (input.fetchedCount === 0) return true;
	if (input.expandUsed) return true;
	if (input.queryPolicy === 'allow_expensive') return true;
	return false;
}

interface RuleMatch {
	ruleId: RuleId;
	costHint: string;
	distributions?: Record<string, Record<string, number>>;
}

function tryRuleA(input: CostHintInput): RuleMatch | undefined {
	// A small page (even an all-categorical one) is plausibly a direct,
	// deliberate read — the redundancy this rule targets only becomes real
	// waste once there's enough repetition to actually be worth aggregating.
	if (input.fetchedCount < 15) return undefined;
	const classified = classifyColumns(input);
	const categoricalCols = classified.filter((c) => c.categorical);
	if (categoricalCols.length === 0) return undefined;
	if (!classified.every((c) => c.identifier || c.categorical)) return undefined;

	const groupCol = categoricalCols[0].name;
	const bytes = byteLen(JSON.stringify({ columns: input.columns, rows: input.rows }));
	const distributions: Record<string, Record<string, number>> = {};
	for (const col of categoricalCols.slice(0, 3)) {
		const counts: Record<string, number> = {};
		for (const v of col.distinct.slice(0, MAX_CATEGORICAL_DISTINCT)) counts[v] = 0;
		const colIndex = input.columns.indexOf(col.name);
		for (const row of input.rows) {
			const v = String(row[colIndex]);
			if (v in counts) counts[v] = (counts[v] ?? 0) + 1;
		}
		distributions[col.name] = counts;
	}

	return {
		ruleId: 'A',
		costHint:
			`${input.fetchedCount} rows × ${input.columns.length} fields = ${formatKB(bytes)}. ` +
			`sn_aggregate_records with groupBy:["${groupCol}"] answers counts in ~110 B. ` +
			`Counts below are over these ${input.fetchedCount} rows only — use sn_aggregate_records for the whole table.`,
		distributions,
	};
}

function tryRuleE(input: CostHintInput): RuleMatch | undefined {
	if (input.query) return undefined;
	if (input.fetchedCount < 15) return undefined;
	return {
		ruleId: 'E',
		costHint:
			`No query filtered ${input.table} — this is an unfiltered page of ${input.fetchedCount} rows. ` +
			`Add a query, or use sn_aggregate_records for a table-wide summary.`,
	};
}

function tryRuleB(input: CostHintInput): RuleMatch | undefined {
	const classified = classifyColumns(input);
	if (!classified.every((c) => c.identifier)) return undefined;
	return {
		ruleId: 'B',
		costHint:
			`${input.fetchedCount} identifier row(s) on ${input.table} — this payload answers "how many" and ` +
			`nothing else. Use sn_aggregate_records (count:true) for the number. Ignore this if you fetched ` +
			`sys_ids to write to those records.`,
	};
}

function tryRuleD(input: CostHintInput): RuleMatch | undefined {
	// limit<=20 is the schema's own sanctioned "peek" ceiling (see the pre-call
	// payload gate) — never flag blind pagination at or under it.
	const fullPage = input.rows.length === input.limit;
	if (!fullPage || input.totalMatching !== null || input.limit <= 20) return undefined;
	return {
		ruleId: 'D',
		costHint:
			`Got exactly ${input.limit} rows with no totalMatching reported — you may be paginating blind. ` +
			`Check pagination.hasMore, or narrow with a query.`,
	};
}

function tryRuleC(input: CostHintInput): RuleMatch | undefined {
	if (input.fields && input.fields.length > 0) return undefined;
	if (input.columns.length < 20) return undefined;
	return {
		ruleId: 'C',
		costHint: `fields was omitted — ${input.columns.length} columns came back. Pass fields:[...] with just what you need.`,
	};
}

const RULES: Array<(input: CostHintInput) => RuleMatch | undefined> = [
	tryRuleA,
	tryRuleE,
	tryRuleB,
	tryRuleD,
	tryRuleC,
];

/**
 * Compute at most one cost hint for a successful sn_query_records result.
 * Pure — no I/O. `decay` persists fire counts across calls within a process;
 * pass a fresh `createCostHintDecayState()` per test for isolation.
 */
export function computeCostHint(input: CostHintInput, decay: CostHintDecayState): CostHintOutput {
	if (isExempt(input)) return {};

	for (const rule of RULES) {
		const match = rule(input);
		if (!match) continue;
		// Decay is per rule-class: a decayed higher-priority rule falls through
		// to the next rule rather than suppressing hints entirely for this call.
		const fired = decay.counts.get(match.ruleId) ?? 0;
		if (fired >= DECAY_LIMIT) continue;
		decay.counts.set(match.ruleId, fired + 1);
		return match.distributions
			? { costHint: match.costHint, distributions: match.distributions }
			: { costHint: match.costHint };
	}
	return {};
}
