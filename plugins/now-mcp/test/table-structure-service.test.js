import assert from 'node:assert/strict';
import { test } from 'node:test';

import { analyzeTableStructure } from '../build/services/table-structure-service.js';

test('populatedRatio alone carries always/never-populated — no separate top-level lists', () => {
	const records = [
		{ always: 'a', sometimes: 'x', never: '' },
		{ always: 'b', sometimes: '', never: '' },
	];
	const analysis = analyzeTableStructure(records);
	assert.equal(analysis.alwaysPopulated, undefined);
	assert.equal(analysis.neverPopulated, undefined);
	assert.equal(analysis.referenceFields, undefined);

	const byName = Object.fromEntries(analysis.fields.map((f) => [f.name, f]));
	assert.equal(byName.always.populatedRatio, '2/2');
	assert.equal(byName.sometimes.populatedRatio, '1/2');
	assert.equal(byName.never.populatedRatio, '0/2');
});

test('reference is folded onto the field entry instead of a separate referenceFields array', () => {
	const records = [
		{
			caller_id: {
				value: 'a'.repeat(32),
				display_value: 'Abel Tuter',
				link: 'https://x.service-now.com/api/now/table/sys_user/' + 'a'.repeat(32),
			},
		},
	];
	const analysis = analyzeTableStructure(records);
	const field = analysis.fields.find((f) => f.name === 'caller_id');
	assert.equal(field.isReference, true);
	assert.equal(field.reference, 'sys_user');
});

test('reference is omitted (not null) when the referenced table cannot be derived', () => {
	const records = [{ caller_id: { value: 'a'.repeat(32), display_value: 'Abel Tuter' } }];
	const analysis = analyzeTableStructure(records);
	const field = analysis.fields.find((f) => f.name === 'caller_id');
	assert.equal(field.isReference, true);
	assert.equal('reference' in field, false);
});

test('sampleValues is capped at 2 entries, each at most 80 chars', () => {
	const longValue = 'x'.repeat(500);
	const records = [
		{ description: longValue },
		{ description: 'second value also quite long '.repeat(5) },
		{ description: 'third value should not appear' },
	];
	const analysis = analyzeTableStructure(records);
	const field = analysis.fields.find((f) => f.name === 'description');
	assert.equal(field.sampleValues.length, 2);
	for (const v of field.sampleValues) {
		assert.ok(v.length <= 80, `sample value exceeds 80 chars: ${v.length}`);
	}
});

test('empty input yields zero sampled records and no fields', () => {
	const analysis = analyzeTableStructure([]);
	assert.equal(analysis.recordsSampled, 0);
	assert.deepEqual(analysis.fields, []);
});
