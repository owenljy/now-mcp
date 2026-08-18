import assert from 'node:assert/strict';
import { test } from 'node:test';

import { capRendered } from '../build/utils/render-cap.js';

test('capRendered leaves a small array untouched', () => {
	const items = [{ a: 1 }, { a: 2 }];
	const out = capRendered(items, { maxRows: 10, maxBytes: 10_000 });
	assert.deepEqual(out.rows, items);
	assert.equal(out.truncated, false);
	assert.equal(out.fetched, 2);
	assert.equal(out.truncationReason, undefined);
});

test('capRendered caps by row count', () => {
	const items = Array.from({ length: 10 }, (_, i) => ({ i }));
	const out = capRendered(items, { maxRows: 3, maxBytes: 10_000 });
	assert.equal(out.rows.length, 3);
	assert.deepEqual(out.rows, items.slice(0, 3));
	assert.equal(out.truncated, true);
	assert.equal(out.fetched, 10);
	assert.equal(out.truncationReason, 'row_count');
});

test('capRendered caps by byte size when row count is within budget', () => {
	const items = Array.from({ length: 100 }, (_, i) => ({ value: 'x'.repeat(50), i }));
	const out = capRendered(items, { maxRows: 1000, maxBytes: 500 });
	assert.ok(out.rows.length < items.length);
	assert.ok(out.rows.length > 0);
	assert.equal(out.truncated, true);
	assert.equal(out.fetched, 100);
	assert.equal(out.truncationReason, 'row_bytes');
	assert.ok(Buffer.byteLength(JSON.stringify(out.rows)) <= 500);
});

test('capRendered applies the row-count cap first, byte cap second, and reports row_bytes when the byte cap does the final cutting', () => {
	const items = Array.from({ length: 50 }, (_, i) => ({ value: 'y'.repeat(100), i }));
	const out = capRendered(items, { maxRows: 20, maxBytes: 800 });
	assert.ok(out.rows.length < 20);
	assert.equal(out.truncationReason, 'row_bytes');
});

test('capRendered subtracts reservedBytes from the byte budget', () => {
	const items = Array.from({ length: 20 }, (_, i) => ({ value: 'z'.repeat(20), i }));
	const unreserved = capRendered(items, { maxRows: 1000, maxBytes: 400 });
	const reserved = capRendered(items, { maxRows: 1000, maxBytes: 400, reservedBytes: 300 });
	assert.ok(reserved.rows.length <= unreserved.rows.length);
});

test('capRendered clamps a pathological reservedBytes >= maxBytes to a zero byte budget without looping', () => {
	const items = [{ a: 1 }, { a: 2 }, { a: 3 }];
	const out = capRendered(items, { maxRows: 1000, maxBytes: 100, reservedBytes: 100 });
	// Zero available bytes would drive the binary search to an empty prefix;
	// the one-row floor below overrides that back to a single row.
	assert.equal(out.rows.length, 1);
	assert.equal(out.truncated, true);
	assert.equal(out.fetched, 3);
});

test('capRendered floors at one row rather than returning an empty array for a nonzero fetch', () => {
	const items = [{ big: 'x'.repeat(1000) }];
	const out = capRendered(items, { maxRows: 1000, maxBytes: 10 });
	assert.equal(out.rows.length, 1, 'never rows:[] when items was non-empty');
	assert.equal(out.truncated, true);
	assert.equal(out.fetched, 1);
});

test('capRendered returns an empty array for empty input, not a floored row', () => {
	const out = capRendered([], { maxRows: 10, maxBytes: 10_000 });
	assert.deepEqual(out.rows, []);
	assert.equal(out.truncated, false);
	assert.equal(out.fetched, 0);
	assert.equal(out.truncationReason, undefined);
});

test('capRendered supports a byte-only cap via maxRows: Infinity', () => {
	const items = Array.from({ length: 500 }, (_, i) => ({ name: `field_${i}`, type: 'string' }));
	const out = capRendered(items, { maxRows: Number.POSITIVE_INFINITY, maxBytes: 2000 });
	assert.ok(out.rows.length < 500);
	assert.equal(out.truncationReason, 'row_bytes');
});

test('capRendered fetched always reflects the pre-cap length', () => {
	const items = Array.from({ length: 7 }, (_, i) => ({ i }));
	const out = capRendered(items, { maxRows: 3, maxBytes: 10 });
	assert.equal(out.fetched, 7);
});
