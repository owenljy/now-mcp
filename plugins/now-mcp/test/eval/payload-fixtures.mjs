/**
 * Deterministic payload fixtures for the CI byte-measurement harness
 * (test/payload-size.test.js). No network, no randomness — every fixture is a
 * plain records array so both the row-form byte count and the columnar-form
 * byte count can be computed from the exact same source data.
 */

const PAD7 = ['sys_id', 'number', 'short_description', 'priority', 'state', 'assignment_group', 'sys_updated_on'];

function incidentRow(i) {
	return {
		sys_id: i.toString(16).padStart(32, '0'),
		number: `INC00${1000 + i}`,
		short_description: `Sample incident short description number ${i}`,
		priority: String((i % 4) + 1),
		state: String((i % 6) + 1),
		assignment_group: i % 3 === 0 ? 'Network' : i % 3 === 1 ? 'Service Desk' : 'App Support',
		sys_updated_on: `2026-08-${String((i % 28) + 1).padStart(2, '0')} 12:00:00`,
	};
}

/** Deterministic N-row x 7-field incident-shaped generator, for tests that need an arbitrary N (e.g. the 1000-row budget-reachability check). */
export function buildIncidentRows(n) {
	return Array.from({ length: n }, (_, i) => incidentRow(i));
}

/** The triggering shape: 67 rows x 7 fields, the exact case that motivated this work. */
export const INCIDENT_67x7 = Array.from({ length: 67 }, (_, i) => incidentRow(i));

/** N=1 boundary — the fixture the "columnar never costs more than 1 byte at N=1" decision rests on. */
export const INCIDENT_1x7 = [incidentRow(0)];

/**
 * Same 67 rows, but one field is a nested object (a journal field's
 * display_value shape under displayValue:"all") carrying a large string a
 * level down — exercises the recursive truncateValue fix (bug #2's root
 * cause), since a naive typeof==='string' check would let this sail through
 * uncapped.
 */
export const INCIDENT_67x7_DISPLAY_ALL = INCIDENT_67x7.map((row, i) => ({
	...row,
	work_notes: {
		value: '',
		display_value:
			i === 0
				? Array.from({ length: 40 }, (_, j) => `[2026-08-01 12:0${j % 10}:00] admin: ${'note text '.repeat(150)}`).join('\n')
				: `[2026-08-01 12:00:00] admin: initial triage note ${i}`,
	},
}));

/** A row with a nested object cell from an `expand` (e.g. expand={"caller_id":["name","email"]}). */
export const INCIDENT_EXPAND = INCIDENT_67x7.slice(0, 10).map((row, i) => ({
	...row,
	caller_id: { name: `User ${i}`, email: `user${i}@example.com` },
}));

/** 400 sparse field definitions — most booleans false, matching the omit-if-false idiom. */
export const WIDE_SCHEMA_400 = Array.from({ length: 400 }, (_, i) => {
	const f = { name: `u_field_${i}`, type: i % 5 === 0 ? 'reference' : i % 3 === 0 ? 'integer' : 'string' };
	if (i % 11 === 0) f.mandatory = true;
	if (i % 13 === 0) f.readOnly = true;
	if (f.type === 'string') f.maxLength = 40 + (i % 200);
	if (f.type === 'reference') f.reference = i % 2 === 0 ? 'sys_user' : 'cmn_location';
	return f;
});

/** 100 tables, as sn_list_tables would return them. */
export const TABLES_100 = Array.from({ length: 100 }, (_, i) => ({
	name: `u_table_${i}`,
	label: `Table ${i}`,
	parent: i % 4 === 0 ? 'task' : undefined,
}));

/** 20 choices, as sn_get_choice_list would return them. */
export const CHOICES_20 = Array.from({ length: 20 }, (_, i) => ({
	value: String(i + 1),
	label: `Choice ${i + 1}`,
	sequence: i,
	inactive: i % 7 === 0,
}));

/**
 * 67 rows, each missing a different subset of PAD7's keys — simulates a
 * field-level-ACL strip, where the per-row key *set* varies within one page.
 * Exercises the "columns constructed, not inherited" contract: every row must
 * still produce `columns.length` cells once transposed.
 */
export const RAGGED_67 = INCIDENT_67x7.map((row, i) => {
	const copy = { ...row };
	const dropCount = i % 3;
	for (let k = 0; k < dropCount; k++) {
		delete copy[PAD7[(i + k) % PAD7.length]];
	}
	return copy;
});

/** One row, one field a 60 KB string — the render-floor test that catches the 45k cliff. */
export const HUGE_JOURNAL_1 = [
	{
		sys_id: 'a'.repeat(32),
		number: 'INC001000',
		work_notes: 'x'.repeat(60_000),
	},
];
