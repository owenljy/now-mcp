/**
 * Pure field-name validation against a known schema, with typo suggestions.
 *
 * The ServiceNow Table API silently ignores unknown fields on insert/update,
 * so a typo means data loss with no error. Catching it before the write —
 * and suggesting the intended field — prevents that footgun.
 */

import { closestMatch } from './levenshtein.js';

export interface UnknownField {
	field: string;
	suggestion?: string;
}

export interface FieldValidationResult {
	unknown: UnknownField[];
}

/**
 * Compare provided field names against the table's known fields.
 * Dot-walked names (e.g. "caller_id.name") are validated on their first
 * segment only, since the rest traverses another table.
 */
export function validateFieldNames(
	provided: string[],
	knownFields: string[],
): FieldValidationResult {
	const known = new Set(knownFields);
	const unknown: UnknownField[] = [];

	for (const field of provided) {
		const root = field.split('.')[0];
		if (known.has(root)) continue;
		unknown.push({ field, suggestion: closestMatch(root, knownFields) });
	}

	return { unknown };
}

/**
 * Build an actionable error message for unknown fields. Returns null when
 * there is nothing to report.
 */
export function formatFieldValidationError(
	tableName: string,
	result: FieldValidationResult,
): string | null {
	if (result.unknown.length === 0) return null;

	const lines = result.unknown.map((u) =>
		u.suggestion
			? `  - "${u.field}" is not a field on ${tableName}. Did you mean "${u.suggestion}"?`
			: `  - "${u.field}" is not a field on ${tableName}.`,
	);

	return (
		`Unknown field(s) for table ${tableName} — the Table API would silently drop these:\n` +
		lines.join('\n') +
		`\n\nFix the field name(s), or pass skipFieldValidation: true to write anyway ` +
		`(e.g. for a field not present in the cached dictionary).`
	);
}

/**
 * Build an actionable error message for unknown fields on a READ.
 *
 * Deliberately worded differently from the write case above, because the
 * consequence is different and worse: an unknown field in an encoded query is
 * not dropped from a payload, it drops the whole CONDITION — so the read
 * silently widens to the entire table and still reports success. Verified on a
 * live instance: `priority=1` matched 27 incidents, `priorityy=1` matched all
 * 67. Saying so explicitly is what stops the caller trusting the row count.
 */
export function formatReadFieldValidationError(
	tableName: string,
	result: FieldValidationResult,
): string | null {
	if (result.unknown.length === 0) return null;

	const lines = result.unknown.map((u) =>
		u.suggestion
			? `  - "${u.field}" is not a field on ${tableName}. Did you mean "${u.suggestion}"?`
			: `  - "${u.field}" is not a field on ${tableName}.`,
	);

	return (
		`Unknown field(s) for table ${tableName} — this read was BLOCKED because ` +
		`ServiceNow would not have reported the problem:\n` +
		lines.join('\n') +
		`\n\nAn unknown field name in an encoded query is silently ignored, which drops ` +
		`that condition and returns rows the filter was meant to exclude — with HTTP 200 ` +
		`and no error. Fix the field name(s), check them with sn_get_table_schema, or pass ` +
		`skipFieldValidation: true to run the query as written.`
	);
}

/**
 * Read-path counterpart to preflightFieldValidation. Same validate-then-format
 * contract, but emits the read-specific message above.
 */
export async function preflightReadFieldValidation(
	validator: FieldValidator | undefined,
	tableName: string,
	fieldNames: string[],
	options: { skip?: boolean; instance?: string } = {},
): Promise<string | null> {
	if (!validator || options.skip || fieldNames.length === 0) return null;
	const result = await validator.validateFields(tableName, fieldNames, options.instance);
	return result ? formatReadFieldValidationError(tableName, result) : null;
}

/**
 * Collect the de-duplicated union of field names across a batch of records.
 * Batch records are field-value maps; a typo in any one of them would be
 * silently dropped by the Table API, so we validate every name that appears.
 */
export function collectFieldNames(records: Array<Record<string, unknown>>): string[] {
	const seen = new Set<string>();
	for (const record of records) {
		for (const name of Object.keys(record)) {
			seen.add(name);
		}
	}
	return Array.from(seen);
}

/**
 * Minimal shape of the schema validator needed to check field names. Lets the
 * pre-flight helper below stay decoupled from the full SchemaService.
 */
export interface FieldValidator {
	validateFields(
		tableName: string,
		fieldNames: string[],
		instance?: string,
	): Promise<FieldValidationResult | null>;
}

/**
 * Shared "validate-then-format-or-null" pre-flight used by the create, update,
 * and batch write tools. Validates `fieldNames` against the table schema and
 * returns a formatted error string if any are unknown, or null when everything
 * is fine (no validator, validation skipped, schema unavailable, or all valid).
 *
 * Keeping this in one place guarantees the single-record and batch paths catch
 * typo'd field names identically.
 */
export async function preflightFieldValidation(
	validator: FieldValidator | undefined,
	tableName: string,
	fieldNames: string[],
	options: { skip?: boolean; instance?: string } = {},
): Promise<string | null> {
	if (!validator || options.skip) return null;
	const result = await validator.validateFields(tableName, fieldNames, options.instance);
	return result ? formatFieldValidationError(tableName, result) : null;
}
