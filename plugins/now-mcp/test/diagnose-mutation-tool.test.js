import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDiagnoseMutationTool } from '../build/tools/diagnose-mutation-tool.js';

/**
 * Bug #1's fix (guard the outputTruncated/JSON.parse path with a degraded
 * result instead of surfacing a raw SyntaxError as a tool error) plus the
 * compaction that makes the cut rarely happen. See feature.md bug #1/PR2.
 */

test('a truncated instance-side output degrades to a partial diagnosis instead of throwing', async () => {
	const tool = createDiagnoseMutationTool({
		async executeBackgroundScript() {
			return {
				success: true,
				output: '{"recordExists":true,"capabilities":{"canWri', // deliberately cut mid-JSON
				outputTruncated: true,
				outputOriginalChars: 5000,
				outputReturnedChars: 2700,
			};
		},
	});
	const res = await tool.handler({ tableName: 'incident', sysId: 'a'.repeat(32), operation: 'update' });
	assert.equal(res.isError, undefined, 'a degraded diagnosis is not a tool error');
	assert.equal(res.structuredContent.diagnosisDegraded, true);
	assert.match(res.structuredContent.degradedReason, /2700/);
	assert.match(res.structuredContent.degradedReason, /5000/);
});

test('malformed JSON that is not flagged outputTruncated also degrades gracefully, not a SyntaxError', async () => {
	const tool = createDiagnoseMutationTool({
		async executeBackgroundScript() {
			return {
				success: true,
				output: 'this is not json at all',
				outputTruncated: false,
			};
		},
	});
	const res = await tool.handler({ tableName: 'incident', sysId: 'a'.repeat(32), operation: 'update' });
	assert.equal(res.isError, undefined);
	assert.equal(res.structuredContent.diagnosisDegraded, true);
	assert.match(res.structuredContent.degradedReason, /not be parsed as JSON/);
});

test('a well-formed, untruncated diagnosis stays under the 2700-char mailbox transport cap', async () => {
	// Representative fixture: a table with several before-BRs, several ACLs
	// (each with roles), and a couple of reference dependencies — the shape
	// most likely to bump into the cap before the PR2 compaction.
	const activeBusinessRules = Array.from({ length: 8 }, (_, i) => ({
		sys_id: 'b'.repeat(32),
		name: `BR ${i}`,
		order: String(i * 100),
		update: 'true',
		delete: 'false',
		hasAbort: i === 0,
	}));
	const applicableAcls = Array.from({ length: 6 }, (_, i) => ({
		sys_id: 'c'.repeat(32),
		name: i % 2 === 0 ? 'incident' : 'incident.short_description',
		operation: 'write',
		roles: ['admin', 'itil'],
		hasCondition: false,
		hasScript: false,
	}));
	const referenceDependencies = [
		{ table: 'task_sla', field: 'task', count: 3 },
		{ table: 'sys_journal_field', field: 'element_id', count: 101, countCapped: true },
	];
	const output = JSON.stringify({
		identity: { userName: 'system', userId: 'a'.repeat(32), isAdmin: true },
		recordExists: true,
		capabilities: { canRead: true, canWrite: true, canDelete: false, sysClassName: 'incident' },
		fieldCapabilities: [{ field: 'short_description', exists: true, canRead: true, canWrite: true, value: 'x' }],
		activeBusinessRules,
		applicableAcls,
		aclCoverage: {
			metadataReadable: true,
			operation: 'write',
			hierarchy: ['incident', 'task'],
			tableAclCount: 3,
			fieldAclCount: 3,
			inheritedAclCount: 1,
			wildcardAclCount: 0,
			coverage: 'present',
		},
		referenceDependencies,
	});
	const tool = createDiagnoseMutationTool({
		async executeBackgroundScript() {
			return { success: true, output, outputTruncated: false };
		},
	});
	// The 2700-char target is on the RAW instance-side script output (what the
	// mailbox transport hard-caps at) — the tool's own response wrapping
	// (table/sysId/operation) is a separate, unbounded-by-that-cap concern.
	assert.ok(
		output.length < 2700,
		`expected the representative diagnosis fixture to stay under 2700 chars, got ${output.length}`,
	);
	const res = await tool.handler({ tableName: 'incident', sysId: 'a'.repeat(32), operation: 'update' });
	assert.equal(res.isError, undefined);
});

test('omits countCapped when false, condition when empty, and value when unreadable', async () => {
	const output = JSON.stringify({
		recordExists: true,
		capabilities: { canWrite: true },
		fieldCapabilities: [{ field: 'sys_id', exists: true, canRead: false, canWrite: false }],
		activeBusinessRules: [
			{ sys_id: 'b'.repeat(32), name: 'no condition', order: '100', update: 'true', delete: 'false', hasAbort: false },
		],
		applicableAcls: [],
		aclCoverage: { metadataReadable: true, coverage: 'none', operation: 'write' },
		referenceDependencies: [{ table: 'task_sla', field: 'task', count: 3 }],
	});
	const tool = createDiagnoseMutationTool({
		async executeBackgroundScript() {
			return { success: true, output, outputTruncated: false };
		},
	});
	const res = await tool.handler({ tableName: 'incident', sysId: 'a'.repeat(32), operation: 'update' });
	const data = res.structuredContent;

	assert.equal('value' in data.fieldCapabilities[0], false, 'value must be omitted, not null, when unreadable');
	assert.equal('condition' in data.activeBusinessRules[0], false, 'condition must be omitted when filter_condition is empty');
	assert.equal('countCapped' in data.referenceDependencies[0], false, 'countCapped must be omitted when not capped');
	assert.equal('limitations' in data, false, 'limitations moved into the tool description, not the response');
	assert.equal('diagnosis' in data.aclCoverage, false, 'aclCoverage.diagnosis was deleted — static prose moved to the description');
	assert.equal('requestedOperation' in data.aclCoverage, false, 'aclCoverage.requestedOperation was deleted — equals the top-level operation');
});
