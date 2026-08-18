/**
 * Transpose an array of row objects into the columnar {columns, rows} wire
 * shape: `columns` names each cell position once; `rows[i][j]` is the value
 * of `columns[j]` for row `i`. Removes the cost of repeating every field name
 * once per row.
 *
 * Column order is CONSTRUCTED, never inherited — no transport guarantees a
 * stable key order, and a field-level-ACL-stripped field is omitted from the
 * row entirely, so the per-row key *set* varies within one page:
 *  - `requestedFields` supplied: the exact requested array (deduped, caller
 *    order), then any row key not already covered, appended defensively so a
 *    key nobody asked for (but the transport returned anyway) is never lost.
 *  - `requestedFields` omitted: the union of keys across all rows, in
 *    first-seen order.
 *
 * `""` (present, empty string) and `null` (column not returned for this row)
 * are never coerced into each other — that distinction is the whole point of
 * `columnsNotReturned`.
 */

export interface ColumnarResult {
	columns: string[];
	rows: unknown[][];
	/** Requested columns absent from every row — e.g. a field-level ACL strip. Only computed when `requestedFields` was supplied. */
	columnsNotReturned?: string[];
}

export function toColumnar(
	records: Record<string, unknown>[],
	requestedFields?: string[],
): ColumnarResult {
	const columns: string[] = [];
	const seen = new Set<string>();
	const addColumn = (name: string) => {
		if (!seen.has(name)) {
			seen.add(name);
			columns.push(name);
		}
	};

	if (requestedFields && requestedFields.length > 0) {
		for (const f of requestedFields) addColumn(f);
	}
	// Union of keys actually present across all rows, first-seen order — covers
	// both the fields-omitted case and (when fields WAS supplied) any
	// unrequested key the transport returned anyway (e.g. an expand column).
	for (const record of records) {
		for (const key of Object.keys(record)) addColumn(key);
	}

	const rows: unknown[][] = records.map((record) =>
		columns.map((c) => (c in record ? record[c] : null)),
	);

	// Guarded on records.length > 0: with zero rows, every requested field is
	// vacuously "absent from every row" — that's a zero-result, not an ACL
	// strip, and zeroResultHints already owns signaling an empty result.
	let columnsNotReturned: string[] | undefined;
	if (requestedFields && requestedFields.length > 0 && records.length > 0) {
		const missing = requestedFields.filter((f) => !records.some((record) => f in record));
		if (missing.length > 0) columnsNotReturned = missing;
	}

	return columnsNotReturned ? { columns, rows, columnsNotReturned } : { columns, rows };
}
