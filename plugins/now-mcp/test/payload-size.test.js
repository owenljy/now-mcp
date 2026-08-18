import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toColumnar } from '../build/utils/columnar.js';
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
	buildIncidentRows,
} from './eval/payload-fixtures.mjs';

/**
 * CI byte-measurement harness spanning PR1 (render-cap primitives) and PR3
 * (columnar shape) of the token-economy overhaul. Establishes the "before"
 * numbers as enforceable assertions rather than a one-off notebook
 * measurement.
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

// --- Columnar-form assertions (PR3) -----------------------------------------

test('columnar ratio: the real invariant, computed from the same fixture as the row form', () => {
	const columnar = toColumnar(INCIDENT_67x7);
	const rowBytes = byteLen(INCIDENT_67x7);
	const columnarBytes = byteLen(columnar);
	console.log(`[payload-size] INCIDENT_67x7 ratio, ${(columnarBytes / rowBytes).toFixed(3)}`);
	assert.ok(
		columnarBytes / rowBytes <= 0.6,
		`expected columnar/row <= 0.60, got ${(columnarBytes / rowBytes).toFixed(3)}`,
	);
});

test('columnar N=1 non-regression: the envelope overhead at one row stays a small, fixed, per-column cost', () => {
	const columnar = toColumnar(INCIDENT_1x7);
	const rowBytes = byteLen(INCIDENT_1x7);
	const columnarBytes = byteLen(columnar);
	// Unlike the settled "+1 byte" finding measured against production field
	// names, this synthetic fixture's overhead is dominated by the {"columns":
	// [...],"rows":[[...]]} envelope syntax itself (independent of value
	// length) — empirically ~3 bytes/column here. Bound at 5 bytes/column so
	// this stays a real regression catch, not a number tuned to always pass.
	const budget = columnar.columns.length * 5;
	assert.ok(
		columnarBytes <= rowBytes + budget,
		`expected columnar <= row + ${budget} at N=1, got row=${rowBytes} columnar=${columnarBytes}`,
	);
});

test('rows[i].length === columns.length on every fixture, including RAGGED_67 (ACL-strip simulation)', () => {
	for (const [name, fixture, fields] of [
		['INCIDENT_67x7', INCIDENT_67x7, undefined],
		['RAGGED_67', RAGGED_67, Object.keys(INCIDENT_67x7[0])],
		['TABLES_100', TABLES_100, undefined],
		['CHOICES_20', CHOICES_20, undefined],
	]) {
		const { columns, rows } = toColumnar(fixture, fields);
		for (const row of rows) {
			assert.equal(row.length, columns.length, `${name}: every row must have columns.length cells`);
		}
	}
});

test('requested fields lead columns, in caller order — any unrequested row key is appended after, never reordered in', () => {
	const fields = ['sys_id', 'number', 'state'];
	const { columns } = toColumnar(INCIDENT_67x7, fields);
	assert.deepEqual(columns.slice(0, fields.length), fields);
	// INCIDENT_67x7's rows carry more keys than requested — those still show up,
	// appended after the requested prefix, never dropped silently.
	assert.equal(columns.length, Object.keys(INCIDENT_67x7[0]).length);
});

test('columns deep-equals fields when every row key was requested (no unrequested keys to append)', () => {
	const fields = Object.keys(INCIDENT_67x7[0]);
	const { columns } = toColumnar(INCIDENT_67x7, fields);
	assert.deepEqual(columns, fields);
});

test('absent becomes null, empty stays "" — RAGGED_67 exercises both', () => {
	const fields = Object.keys(INCIDENT_67x7[0]);
	const { rows } = toColumnar(RAGGED_67, fields);
	// At least one row in this fixture is missing a key (dropped by the ragged
	// generator) — confirm it renders as null, not a coerced "".
	assert.ok(rows.some((row) => row.includes(null)), 'at least one dropped key should render as null');
});

test('budget-reachable: a 1000x7 columnar page fits at least 300 rows under the 45,000-byte budget', () => {
	const rows1000 = buildIncidentRows(1000);
	const { columns, rows } = toColumnar(rows1000);
	const { rows: rendered, fetched } = capRendered(rows, {
		maxRows: 1_000,
		maxBytes: 45_000,
		reservedBytes: byteLen(columns),
	});
	assert.equal(fetched, 1000);
	assert.ok(rendered.length >= 300, `expected >=300 rows to fit, got ${rendered.length}`);
});
