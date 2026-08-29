import { createHash } from 'node:crypto';

const SECRET_KEY =
	/^(?:password|passwd|clientsecret|client_secret|secret|authorization|cookie|access_token|refresh_token|token)$/i;
const BINARY_KEY = /^(?:filecontent|file_content|contentbase64|base64)$/i;
const SCRIPT_KEY = /^(?:script|scriptbody|script_body)$/i;
const MAX_STRING_CHARS = 2_000;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 50;
const MAX_DEPTH = 6;

function digest(value: string): string {
	return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function redactedText(kind: string, value: unknown): string {
	const chars = typeof value === 'string' ? value.length : undefined;
	return chars === undefined ? `<redacted ${kind}>` : `<redacted ${kind}: ${chars} chars>`;
}

/**
 * Last-line defense for every logger sink. It removes conventional secrets,
 * scripts and binary payloads, and bounds unexpectedly large/cyclic structures.
 */
export function sanitizeLogData(value: unknown): unknown {
	const seen = new WeakSet<object>();

	function visit(current: unknown, key: string | undefined, depth: number): unknown {
		if (key && SECRET_KEY.test(key)) return '<redacted secret>';
		if (key && BINARY_KEY.test(key)) return redactedText('binary payload', current);
		if (key && SCRIPT_KEY.test(key)) {
			return typeof current === 'string'
				? `<redacted script: ${current.length} chars, sha256:${digest(current)}>`
				: '<redacted script>';
		}

		if (typeof current === 'string') {
			return current.length <= MAX_STRING_CHARS
				? current
				: `${current.slice(0, MAX_STRING_CHARS)}…<truncated ${current.length - MAX_STRING_CHARS} chars>`;
		}
		if (current === null || typeof current !== 'object') return current;
		if (depth >= MAX_DEPTH) return '<max log depth reached>';
		if (seen.has(current)) return '<circular>';
		seen.add(current);

		if (Array.isArray(current)) {
			const items = current
				.slice(0, MAX_ARRAY_ITEMS)
				.map((item) => visit(item, undefined, depth + 1));
			if (current.length > MAX_ARRAY_ITEMS) {
				items.push(`<${current.length - MAX_ARRAY_ITEMS} more items>`);
			}
			return items;
		}

		const entries = Object.entries(current as Record<string, unknown>);
		const out: Record<string, unknown> = {};
		for (const [childKey, child] of entries.slice(0, MAX_OBJECT_KEYS)) {
			out[childKey] = visit(child, childKey, depth + 1);
		}
		if (entries.length > MAX_OBJECT_KEYS) out._truncatedKeys = entries.length - MAX_OBJECT_KEYS;
		return out;
	}

	return visit(value, undefined, 0);
}

function recordFieldNames(records: unknown[]): string[] {
	const names = new Set<string>();
	for (const record of records) {
		if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
		for (const key of Object.keys(record as Record<string, unknown>)) names.add(key);
	}
	return [...names].sort();
}

/** A value-free summary for a ServiceNow create/update payload. */
export function summarizeRecordPayload(data: Record<string, unknown>): Record<string, unknown> {
	return {
		fieldCount: Object.keys(data).length,
		fieldNames: Object.keys(data).sort(),
		payloadBytes: Buffer.byteLength(JSON.stringify(data)),
	};
}

/**
 * Summarize one MCP call without logging record values, encoded queries, local
 * paths, attachment bytes, or executable source.
 */
export function summarizeToolArguments(args: unknown): Record<string, unknown> {
	if (!args || typeof args !== 'object' || Array.isArray(args)) {
		return { argumentType: args === null ? 'null' : typeof args };
	}
	const input = args as Record<string, unknown>;
	const summary: Record<string, unknown> = { argumentKeys: Object.keys(input).sort() };

	for (const key of ['instance', 'tableName']) {
		if (typeof input[key] === 'string') summary[key] = input[key];
	}
	for (const key of [
		'limit',
		'offset',
		'verify',
		'continueOnError',
		'allowWrites',
		'allowMetadataWrites',
		'preflightAccess',
	]) {
		if (typeof input[key] === 'number' || typeof input[key] === 'boolean')
			summary[key] = input[key];
	}

	if (Array.isArray(input.fields)) summary.fields = input.fields;
	if (Array.isArray(input.records)) {
		summary.recordCount = input.records.length;
		summary.recordFieldNames = recordFieldNames(input.records);
	}
	if (Array.isArray(input.updates)) {
		summary.updateCount = input.updates.length;
		summary.updateFieldNames = recordFieldNames(
			input.updates.map((update) =>
				update && typeof update === 'object'
					? (update as Record<string, unknown>).fields
					: undefined,
			),
		);
	}
	if (Array.isArray(input.sysIds)) summary.sysIdCount = input.sysIds.length;
	if (typeof input.script === 'string') summary.script = input.script;
	if (typeof input.fileContent === 'string') summary.fileContent = input.fileContent;
	if (typeof input.filePath === 'string') summary.filePath = '<redacted local path>';
	if (typeof input.query === 'string') {
		summary.query = `<redacted encoded query: ${input.query.length} chars, sha256:${digest(input.query)}>`;
	}

	return sanitizeLogData(summary) as Record<string, unknown>;
}
