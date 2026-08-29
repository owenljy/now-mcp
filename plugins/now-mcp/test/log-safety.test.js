import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	sanitizeLogData,
	summarizeRecordPayload,
	summarizeToolArguments,
} from '../build/utils/log-safety.js';

test('sanitizeLogData recursively removes conventional secrets and executable/binary bodies', () => {
	const safe = sanitizeLogData({
		password: 'hunter2',
		auth: { clientSecret: 'top-secret', access_token: 'bearer' },
		script: 'gs.info("private");',
		fileContent: 'QUJDREVGRw==',
	});
	const rendered = JSON.stringify(safe);

	assert.doesNotMatch(rendered, /hunter2|top-secret|bearer|private|QUJDREVGRw/);
	assert.match(rendered, /redacted secret/);
	assert.match(rendered, /redacted script/);
	assert.match(rendered, /redacted binary payload/);
});

test('summarizeToolArguments keeps routing/cardinality but drops record values and queries', () => {
	const safe = summarizeToolArguments({
		instance: 'dev',
		tableName: 'incident',
		query: 'caller_id.email=person@example.com',
		records: [
			{ short_description: 'private outage', caller_id: 'person' },
			{ short_description: 'another private outage' },
		],
		password: 'not-a-tool-field-but-still-secret',
	});
	const rendered = JSON.stringify(safe);

	assert.equal(safe.instance, 'dev');
	assert.equal(safe.tableName, 'incident');
	assert.equal(safe.recordCount, 2);
	assert.deepEqual(safe.recordFieldNames, ['caller_id', 'short_description']);
	assert.match(safe.query, /redacted encoded query/);
	assert.doesNotMatch(rendered, /person@example|private outage|not-a-tool-field/);
});

test('summarizeToolArguments never emits attachment bytes, script source, or local paths', () => {
	const safe = summarizeToolArguments({
		script: 'var secret = "inside";',
		fileContent: 'c2Vuc2l0aXZlLWJ5dGVz',
		filePath: '/Users/alice/private/customer.csv',
	});
	const rendered = JSON.stringify(safe);

	assert.doesNotMatch(rendered, /inside|c2Vuc2l0aXZl|alice|customer\.csv/);
	assert.match(rendered, /redacted script/);
	assert.match(rendered, /redacted binary payload/);
	assert.match(rendered, /redacted local path/);
});

test('summarizeRecordPayload reports shape and size without values', () => {
	const summary = summarizeRecordPayload({ short_description: 'customer secret', active: true });
	assert.deepEqual(summary.fieldNames, ['active', 'short_description']);
	assert.equal(summary.fieldCount, 2);
	assert.equal(typeof summary.payloadBytes, 'number');
	assert.doesNotMatch(JSON.stringify(summary), /customer secret/);
});

test('sanitizeLogData bounds cyclic and oversized values', () => {
	const cyclic = { value: 'x'.repeat(3000) };
	cyclic.self = cyclic;
	const safe = sanitizeLogData(cyclic);
	assert.match(safe.value, /truncated/);
	assert.equal(safe.self, '<circular>');
});
