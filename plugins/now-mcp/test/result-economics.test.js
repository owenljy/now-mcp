import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeCostHint, createCostHintDecayState } from '../build/utils/result-economics.js';
import { WASTEFUL_CALLS, WELL_FORMED_CALLS } from './eval/cost-hint-fixtures.mjs';

/**
 * computeCostHint: fires at most one steering hint on an already-successful
 * sn_query_records result. Stated bias — a missed hint costs the status quo,
 * a false hint costs tokens and teaches the caller to skip hints — so this
 * corpus is weighted toward proving silence on well-formed calls.
 */

function baseInput(overrides = {}) {
	return {
		table: 'incident',
		fields: ['sys_id', 'number', 'priority'],
		query: 'active=true',
		limit: 10,
		fetchedCount: 3,
		totalMatching: 3,
		truncated: false,
		expandUsed: false,
		queryPolicy: 'safe',
		columns: ['sys_id', 'number', 'priority'],
		rows: [
			['a'.repeat(32), 'INC1', '1'],
			['b'.repeat(32), 'INC2', '2'],
			['c'.repeat(32), 'INC3', '1'],
		],
		...overrides,
	};
}

test('WELL_FORMED_CALLS never fire a hint (zero tolerance)', () => {
	for (const c of WELL_FORMED_CALLS) {
		const out = computeCostHint(c.input, createCostHintDecayState());
		assert.equal(out.costHint, undefined, `expected silence for "${c.label}", got: ${out.costHint}`);
	}
});

test('WASTEFUL_CALLS all fire a hint', () => {
	for (const c of WASTEFUL_CALLS) {
		const out = computeCostHint(c.input, createCostHintDecayState());
		assert.ok(out.costHint, `expected a hint for "${c.label}"`);
	}
});

test('R3: fire rate over the combined fixture corpus lands in [0.15, 0.35]', () => {
	const all = [...WELL_FORMED_CALLS, ...WASTEFUL_CALLS];
	const fired = all.filter((c) => computeCostHint(c.input, createCostHintDecayState()).costHint).length;
	const rate = fired / all.length;
	assert.ok(rate >= 0.15 && rate <= 0.35, `fire rate ${rate.toFixed(3)} (${fired}/${all.length}) outside [0.15, 0.35]`);
});

test('R4: every hint stays within the 160-byte budget (the mandatory per-page-only disclaimer on rule A is exempt — it describes attached distributions, not padding)', () => {
	const DISCLAIMER_MARKER = ' Counts below are over';
	for (const c of [...WELL_FORMED_CALLS, ...WASTEFUL_CALLS]) {
		const out = computeCostHint(c.input, createCostHintDecayState());
		if (!out.costHint) continue;
		const idx = out.costHint.indexOf(DISCLAIMER_MARKER);
		const budgeted = idx === -1 ? out.costHint : out.costHint.slice(0, idx);
		assert.ok(
			Buffer.byteLength(budgeted) <= 160,
			`"${c.label}" hint's budgeted portion is ${Buffer.byteLength(budgeted)} bytes: ${budgeted}`,
		);
	}
});

test('at most one hint per call, even when multiple rule conditions could plausibly match', () => {
	// Every returned column is categorical/identifier AND the page is full with
	// no totalMatching AND fields were omitted — a fixture engineered to make
	// rules A, D, and C all plausible at once.
	const input = baseInput({
		fields: undefined,
		limit: 25,
		fetchedCount: 25,
		totalMatching: null,
		columns: Array.from({ length: 25 }, (_, i) => `cat_${i}`),
		rows: Array.from({ length: 25 }, (_, i) => Array.from({ length: 25 }, (_, j) => String((i + j) % 3))),
	});
	const out = computeCostHint(input, createCostHintDecayState());
	assert.equal(typeof out.costHint, 'string');
	assert.equal(Array.isArray(out.costHint), false, 'costHint is a single string, never an array');
});

test('R6: a rule stops firing after 3 hits for the same decay state, and falls through rather than going silent entirely', () => {
	const decay = createCostHintDecayState();
	// Rule E: no query, fetchedCount >= 15.
	// A free-text column (>12 distinct values across the full 20 rows) keeps
	// rule A (higher priority) from matching, so this exercises rule E
	// specifically: no query, fetchedCount >= 15.
	const input = baseInput({
		query: undefined,
		fetchedCount: 20,
		totalMatching: null,
		fields: undefined,
		columns: ['sys_id', 'short_description'],
		rows: Array.from({ length: 20 }, (_, i) => [i.toString(16).padStart(32, '0'), `free text varies per row ${i}`]),
	});
	let fires = 0;
	for (let i = 0; i < 4; i++) {
		const out = computeCostHint(input, decay);
		if (out.costHint) fires++;
	}
	assert.equal(fires, 3, 'rule E should fire exactly 3 times before decaying');
});

test('R6: decay state is per-instance — a fresh state does not inherit another call site\'s count', () => {
	const decayA = createCostHintDecayState();
	const decayB = createCostHintDecayState();
	// A free-text column (>12 distinct values across the full 20 rows) keeps
	// rule A (higher priority) from matching, so this exercises rule E
	// specifically: no query, fetchedCount >= 15.
	const input = baseInput({
		query: undefined,
		fetchedCount: 20,
		totalMatching: null,
		fields: undefined,
		columns: ['sys_id', 'short_description'],
		rows: Array.from({ length: 20 }, (_, i) => [i.toString(16).padStart(32, '0'), `free text varies per row ${i}`]),
	});
	for (let i = 0; i < 3; i++) computeCostHint(input, decayA);
	const outA = computeCostHint(input, decayA);
	const outB = computeCostHint(input, decayB);
	assert.equal(outA.costHint, undefined, 'decayA has exhausted rule E');
	assert.equal(typeof outB.costHint, 'string', 'decayB is fresh and still fires');
});

test('rule A attaches distributions gated to <=3 columns and <=12 values each, with the mandatory per-page disclaimer', () => {
	const wasteful = WASTEFUL_CALLS.find((c) => c.label === 'triggering 67x7 case');
	const out = computeCostHint(wasteful.input, createCostHintDecayState());
	assert.ok(out.distributions, 'rule A should attach distributions');
	assert.ok(Object.keys(out.distributions).length <= 3);
	for (const counts of Object.values(out.distributions)) {
		assert.ok(Object.keys(counts).length <= 12);
	}
	assert.match(out.costHint, /over these \d+ rows only/, 'the disclaimer sentence must be present');
});

test('exemptions: limit<=5, narrow fields at modest scale, empty result, expand, and allow_expensive never hint', () => {
	const cases = [
		baseInput({ limit: 5, fetchedCount: 5, totalMatching: null, fields: undefined, columns: [], rows: [] }),
		baseInput({ fetchedCount: 0, columns: [], rows: [] }),
		baseInput({ expandUsed: true, fetchedCount: 50, totalMatching: null, fields: undefined }),
		baseInput({ queryPolicy: 'allow_expensive', fetchedCount: 50, totalMatching: null, fields: undefined }),
	];
	for (const input of cases) {
		const out = computeCostHint(input, createCostHintDecayState());
		assert.equal(out.costHint, undefined);
	}
});
