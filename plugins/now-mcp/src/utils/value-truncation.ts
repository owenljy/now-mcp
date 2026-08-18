/**
 * Per-field-value truncation for record-shaped responses.
 *
 * Row/byte-count guardrails (see query-records-tool, get-table-schema-tool) cap
 * the *number* of rows returned, but a single oversized string field (a syslog
 * message, a script body, an XML payload) can blow the whole response budget by
 * itself before the row cap ever kicks in. This truncates individual string
 * values so breadth (more rows/fields visible) wins over depth (one huge blob).
 */

const MAX_RECURSION_DEPTH = 3;

/**
 * Truncate a single value if it's a string longer than `maxChars`, recursing
 * into plain objects/arrays so a nested cell (e.g. a `display_value` object
 * under displayValue:"all") can't carry an unbounded string past the cap by
 * hiding it a level down. Depth-limited so a pathological structure can't
 * make this recurse unboundedly; anything past the depth limit passes through
 * unchanged rather than being truncated as if it were a leaf.
 */
export function truncateValue(
	value: unknown,
	maxChars: number,
	depth = 0,
): { value: unknown; truncated: boolean } {
	if (typeof value === 'string' && value.length > maxChars) {
		return {
			value: `${value.slice(0, maxChars)}…[truncated ${value.length - maxChars} chars]`,
			truncated: true,
		};
	}
	if (depth >= MAX_RECURSION_DEPTH || value === null || typeof value !== 'object') {
		return { value, truncated: false };
	}
	if (Array.isArray(value)) {
		let truncated = false;
		const out = value.map((item) => {
			const t = truncateValue(item, maxChars, depth + 1);
			if (t.truncated) truncated = true;
			return t.value;
		});
		return { value: out, truncated };
	}
	let truncated = false;
	const out: Record<string, unknown> = {};
	for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
		const t = truncateValue(val, maxChars, depth + 1);
		out[key] = t.value;
		if (t.truncated) truncated = true;
	}
	return { value: out, truncated };
}

/** Apply `truncateValue` to every field of every record. Pure — no side effects. */
export function truncateRecordFields(
	records: Record<string, unknown>[],
	maxChars: number,
): { records: Record<string, unknown>[]; truncated: boolean } {
	let truncated = false;
	const out = records.map((record) => {
		const copy: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(record)) {
			const t = truncateValue(val, maxChars);
			copy[key] = t.value;
			if (t.truncated) truncated = true;
		}
		return copy;
	});
	return { records: out, truncated };
}
