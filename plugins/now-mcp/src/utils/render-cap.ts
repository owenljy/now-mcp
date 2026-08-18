/**
 * Shared render guardrail for every tool that returns an array of rows.
 *
 * Row-count and serialized-byte caps were previously hand-rolled (and slightly
 * duplicated) in query-records-tool, aggregate-records-tool,
 * get-table-schema-tool, and get-table-structure-from-data-tool. This is the
 * one implementation all four call into.
 */

export type TruncationReason = 'row_count' | 'row_bytes';

export interface CapRenderedOptions {
	/** Row-count cap. Pass `Number.POSITIVE_INFINITY` for byte-only callers
	 * (e.g. a field list, which has no natural row-count concept). */
	maxRows: number;
	maxBytes: number;
	/** Bytes to deduct from `maxBytes` before the byte cap runs — e.g. a
	 * columnar header/envelope the caller will add back around `rows`. */
	reservedBytes?: number;
}

export interface CapRenderedResult<T> {
	rows: T[];
	truncated: boolean;
	/** Row count before either cap ran. */
	fetched: number;
	truncationReason?: TruncationReason;
}

/**
 * Cap `items` by row count, then by serialized byte size. Pure — no side
 * effects. Never returns an empty array when `items` was non-empty (a floor
 * of one row, cells uncapped here — cell-level shrinking is the caller's job,
 * upstream of this function): an empty `rows` with a nonzero `fetched` count
 * would read as "no matching records" to a caller that only checks length.
 */
export function capRendered<T>(items: T[], opts: CapRenderedOptions): CapRenderedResult<T> {
	const fetched = items.length;

	let rows = items.length > opts.maxRows ? items.slice(0, opts.maxRows) : items;
	let truncated = rows.length < items.length;
	let truncationReason: TruncationReason | undefined = truncated ? 'row_count' : undefined;

	const availableBytes = Math.max(0, opts.maxBytes - (opts.reservedBytes ?? 0));
	if (Buffer.byteLength(JSON.stringify(rows)) > availableBytes) {
		// Binary search for the largest prefix that fits the byte budget.
		let lo = 0;
		let hi = rows.length;
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2);
			if (Buffer.byteLength(JSON.stringify(rows.slice(0, mid))) <= availableBytes) {
				lo = mid;
			} else {
				hi = mid - 1;
			}
		}
		rows = rows.slice(0, lo);
		truncated = true;
		truncationReason = 'row_bytes';
	}

	if (rows.length === 0 && items.length > 0) {
		rows = items.slice(0, 1);
	}

	return { rows, truncated, fetched, truncationReason };
}
