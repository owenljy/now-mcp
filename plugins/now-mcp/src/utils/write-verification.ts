/**
 * Read-after-write comparison, shared by the single-record and batch update paths.
 *
 * ServiceNow answers a write that an ACL or a business rule refused with HTTP
 * 200 and an echoed row, so the only reliable persistence signal is reading the
 * record back and comparing it against what was asked for. Both write paths must
 * judge "did it persist?" identically — a value that counts as persisted for one
 * record has to count for fifty — which is why the normalizer lives here rather
 * than inline in a tool.
 */

export interface FieldMismatch {
	field: string;
	expected: unknown;
	actual: unknown;
}

/**
 * Collapse a field value to the form the Table API round-trips, so equivalent
 * representations don't read as a mismatch: a reference field may come back as
 * `{value, display_value}`, booleans return as "true"/"false", and an unset
 * field reads as "".
 */
export function normalizeFieldValue(value: unknown): unknown {
	if (typeof value === 'object' && value !== null && 'value' in value) {
		return (value as { value: unknown }).value;
	}
	if (value === true) return 'true';
	if (value === false) return 'false';
	if (value === null || value === undefined) return '';
	return String(value);
}

/** The requested fields whose re-read value differs from what was written. */
export function fieldMismatches(
	expected: Record<string, unknown>,
	actual: Record<string, unknown>,
): FieldMismatch[] {
	return Object.entries(expected)
		.filter(([field, want]) => normalizeFieldValue(actual[field]) !== normalizeFieldValue(want))
		.map(([field, want]) => ({ field, expected: want, actual: actual[field] }));
}

/**
 * Reported for a write ServiceNow answered 200 to whose read-back disagreed.
 * Shared so the single-record and batch paths say the same thing.
 */
export const NOT_PERSISTED_MESSAGE =
	'Update returned success, but the requested values did not persist.';

/** Extra fields worth reading back with a verification probe as evidence. */
export const VERIFICATION_EVIDENCE_FIELDS = ['sys_id', 'sys_updated_on', 'sys_mod_count'];

/**
 * Diagnosis attached to a write the API reported success for but which did not
 * persist. Kept in one place so the single-record and batch paths point the
 * caller at the same follow-up tool.
 */
export const NOT_PERSISTED_DIAGNOSIS = {
	failureType: 'mutation_not_persisted',
	likelyCauses: ['table_or_field_acl', 'business_rule_abort'],
	recommendedTool: 'sn_diagnose_mutation',
} as const;
