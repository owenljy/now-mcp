import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toColumnar } from '../build/utils/columnar.js';

test('constructed order: fields supplied drives column order, caller order, deduped', () => {
	const records = [
		{ number: 'INC1', short_description: 'a', sys_id: 'x' },
		{ number: 'INC2', short_description: 'b', sys_id: 'y' },
	];
	const out = toColumnar(records, ['sys_id', 'number', 'sys_id', 'short_description']);
	assert.deepEqual(out.columns, ['sys_id', 'number', 'short_description']);
	assert.deepEqual(out.rows, [
		['x', 'INC1', 'a'],
		['y', 'INC2', 'b'],
	]);
});

test('an unrequested row key (e.g. an expand column) is appended defensively', () => {
	const records = [{ number: 'INC1', 'caller_id.name': 'Abel' }];
	const out = toColumnar(records, ['number']);
	assert.deepEqual(out.columns, ['number', 'caller_id.name']);
	assert.deepEqual(out.rows, [['INC1', 'Abel']]);
});

test('fields omitted: union of keys across all rows, first-seen order', () => {
	const records = [
		{ a: 1, b: 2 },
		{ b: 3, c: 4 },
	];
	const out = toColumnar(records);
	assert.deepEqual(out.columns, ['a', 'b', 'c']);
	assert.deepEqual(out.rows, [
		[1, 2, null],
		[null, 3, 4],
	]);
});

test('ragged rows: every row produces columns.length cells regardless of which keys it actually had', () => {
	const records = [
		{ a: 1, b: 2, c: 3 },
		{ a: 4, c: 6 }, // missing b — simulates a field-level ACL strip on this row
		{ b: 8 }, // missing a and c
	];
	const out = toColumnar(records, ['a', 'b', 'c']);
	for (const row of out.rows) {
		assert.equal(row.length, out.columns.length);
	}
	assert.deepEqual(out.rows[1], [4, null, 6]);
	assert.deepEqual(out.rows[2], [null, 8, null]);
});

test('"" (present, empty) and null (absent) are never coerced into each other', () => {
	const records = [{ a: '', b: 1 }, { b: 2 }];
	const out = toColumnar(records, ['a', 'b']);
	assert.equal(out.rows[0][0], '', 'key present with empty string stays ""');
	assert.equal(out.rows[1][0], null, 'key absent becomes null, not ""');
});

test('nested object/array cells pass through unchanged — columnar only transposes, never truncates', () => {
	const nested = { name: 'Abel', email: 'abel@example.com' };
	const records = [{ caller_id: nested, tags: ['a', 'b'] }];
	const out = toColumnar(records, ['caller_id', 'tags']);
	assert.equal(out.rows[0][0], nested);
	assert.deepEqual(out.rows[0][1], ['a', 'b']);
});

test('empty input: fields supplied yields those columns and zero rows', () => {
	const out = toColumnar([], ['a', 'b']);
	assert.deepEqual(out.columns, ['a', 'b']);
	assert.deepEqual(out.rows, []);
	assert.equal(out.columnsNotReturned, undefined, 'a zero-result is not an ACL strip');
});

test('empty input: fields omitted yields zero columns and zero rows', () => {
	const out = toColumnar([]);
	assert.deepEqual(out.columns, []);
	assert.deepEqual(out.rows, []);
});

test('columnsNotReturned fires only when a requested column is absent from EVERY row', () => {
	const records = [
		{ a: 1, b: 2 },
		{ a: 3 }, // b absent here, but present on the other row
	];
	const out = toColumnar(records, ['a', 'b', 'c']);
	assert.deepEqual(out.columnsNotReturned, ['c'], 'b appeared on at least one row, so it is not "not returned"');
});

test('columnsNotReturned is omitted entirely when every requested column appeared somewhere', () => {
	const records = [{ a: 1, b: 2 }];
	const out = toColumnar(records, ['a', 'b']);
	assert.equal('columnsNotReturned' in out, false);
});
