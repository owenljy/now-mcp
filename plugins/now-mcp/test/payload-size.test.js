import assert from 'node:assert/strict';
import { test } from 'node:test';

import { capRendered } from '../build/utils/render-cap.js';
import { truncateRecordFields } from '../build/utils/value-truncation.js';
import {
	CHOICES_20,
	HUGE_JOURNAL_1,
	INCIDENT_1x7,
	INCIDENT_67x7,
	INCIDENT_67x7_DISPLAY_ALL,
	RAGGED_67,
	TABLES_100,
	WIDE_SCHEMA_400,
} from './eval/payload-fixtures.mjs';

/**
 * CI byte-measurement harness (PR1 of the token-economy overhaul). This file
 * establishes the "before" numbers as enforceable assertions rather than a
 * one-off notebook measurement. The columnar-form assertions (ratio,
 * N=1 non-regression, columns.length invariant) land in PR3 once
 * src/utils/columnar.ts exists — this file only measures the row-form
 * fixtures and the render-cap primitives that already exist in PR1.
 *
 * The "1000x7 rows under 45,000 bytes must still return >=300 rows"
 * budget-reachability check also moves to PR3: measured directly (see PR1
 * verification), row form's ~230 bytes/row (43.5% of it is repeated field
 * names, exactly the columnar motivation) only fits ~194 rows in that budget —
 * the >=300 floor is only reachable once columnar removes the repeated-key
 * overhead. Recording that as a deliberate deferral, not a dropped check.
 */

function byteLen(x) {
	return Buffer.byteLength(JSON.stringify(x));
}

// Per-fixture ledger, matching the console.log idiom at test/tool-eval.test.js:58-76.
test('payload-size ledger (row form)', () => {
	/* eslint-disable no-console */
	const fixtures = { INCIDENT_67x7, INCIDENT_1x7, WIDE_SCHEMA_400, TABLES_100, CHOICES_20, RAGGED_67 };
	console.log('\n[payload-size] fixture, rowBytes');
	for (const [name, fixture] of Object.entries(fixtures)) {
		console.log(`[payload-size] ${name}, ${byteLen(fixture)}`);
	}
});

test('INCIDENT_67x7 row form clears the floor that catches a fixture silently dropping columns', () => {
	assert.ok(byteLen(INCIDENT_67x7) >= 3_000, 'fixture should not be trivially small');
});

test('HUGE_JOURNAL_1 never renders as an empty result — the render floor that catches the 45k cliff (bug #2)', () => {
	// Deliberately skips the truncateRecordFields pass: this fixture stands in
	// for the pre-fix state (a single field's value never got capped, because
	// today's real hazard is a nested display_value object one level down,
	// which this synthetic top-level 60KB string mimics at the capRendered
	// layer). capRendered has no visibility into cell contents — its one-row
	// floor is the last line of defense regardless of whether the per-field
	// cap upstream did its job.
	const { rows, truncated } = capRendered(HUGE_JOURNAL_1, { maxRows: 1_000, maxBytes: 45_000 });
	assert.ok(rows.length >= 1, 'a real result must never render as rows:[]');
	assert.equal(truncated, true);
});

test('WIDE_SCHEMA_400 (sparse omit-if-false fields) fits comfortably under the eventual 60,000-byte schema budget', () => {
	const pinnedBytes = byteLen(WIDE_SCHEMA_400);
	// Pinned rather than an inequality: a change to WIDE_SCHEMA_400 that grows
	// this number should force a conscious edit here, not slide by silently.
	assert.equal(pinnedBytes, 22_307, 'WIDE_SCHEMA_400 byte size changed — update this pin deliberately if intended');

	const { truncated } = capRendered(WIDE_SCHEMA_400, { maxRows: Number.POSITIVE_INFINITY, maxBytes: 60_000 });
	assert.equal(truncated, false, '400 fields must fit 60,000 bytes, or the schema cut is too aggressive for a table like `task`');
});

test('truncateValue recurses into a nested display_value object (bug #2 root cause)', () => {
	const { records, truncated } = truncateRecordFields(INCIDENT_67x7_DISPLAY_ALL, 3_000);
	assert.equal(truncated, true, 'the 40-entry work_notes.display_value blob must be caught, not just top-level strings');
	const hugeRow = records[0];
	assert.equal(typeof hugeRow.work_notes, 'object');
	assert.match(String(hugeRow.work_notes.display_value), /truncated \d+ chars/);
});
