/**
 * Which columns are worth grouping by.
 *
 * Two callers, one rule: `sn_aggregate_records` BLOCKS a groupBy that would
 * produce one group per row, and `zeroResultHints` must not RECOMMEND one. The
 * recommendation path is the one that got this wrong in the wild — it suggested
 * `groupBy:["user_message"]` on an 8000-char free-text column, i.e. precisely
 * the call the block exists to prevent.
 */

/**
 * Columns that are unique (or near-unique) per row by construction. Grouping by
 * any of these is strictly worse than the sn_query_records call it replaced.
 */
export const UNIQUE_COLUMNS = new Set(['sys_id', 'number', 'sys_created_on', 'sys_updated_on']);

/**
 * Dictionary types whose values are drawn from a bounded set regardless of
 * declared length — safe to group by without consulting max_length.
 */
const BOUNDED_TYPES = new Set([
	'boolean',
	'choice',
	'integer',
	'reference',
	'sys_class_name',
	'table_name',
	'domain_id',
	'field_name',
	'workflow',
]);

/**
 * Free-text types. `string` is here rather than in BOUNDED_TYPES because
 * ServiceNow uses it for BOTH a choice-backed 40-char column (incident.category)
 * and an 8000-char message body (sn_aia_message.user_message) — only max_length
 * separates them, so these types fall through to the length test below.
 */
const LENGTH_DEPENDENT_TYPES = new Set([
	'string',
	'string_full_utf8',
	'translated_field',
	'translated_text',
	'char',
	'varchar',
]);

/**
 * Longest declared max_length still treated as a label rather than prose.
 * Calibrated against the stock dictionary: choice-backed strings are 40, the
 * `short_description` convention is 160, and `title`-style columns are 255 —
 * so 100 admits the first and excludes the other two.
 */
export const MAX_GROUPABLE_STRING_LENGTH = 100;

export interface GroupabilityMeta {
	type: string;
	maxLength?: number;
}

/**
 * Is grouping by this column likely to yield a useful distribution?
 *
 * Conservative by design: an UNKNOWN field (no dictionary entry — a dot-walked
 * name, or a table whose schema wouldn't load) returns false. This gates a
 * suggestion, and suggesting nothing costs the status quo while suggesting a
 * context-bomb costs tokens and teaches the caller to ignore hints.
 */
export function isGroupableField(name: string, meta?: GroupabilityMeta): boolean {
	if (UNIQUE_COLUMNS.has(name)) return false;
	if (!meta) return false;
	if (BOUNDED_TYPES.has(meta.type)) return true;
	if (LENGTH_DEPENDENT_TYPES.has(meta.type)) {
		return (meta.maxLength ?? Number.POSITIVE_INFINITY) <= MAX_GROUPABLE_STRING_LENGTH;
	}
	// Everything else — journal, html, script, xml, GUID, document_id, every
	// glide_date* variant, decimal/currency — is either prose, unique, or
	// continuous. None of them group usefully.
	return false;
}
