/**
 * Pure, dependency-free logic for inferring a ServiceNow table's structure from
 * sampled record data.
 *
 * This is a fallback for schema discovery via sys_dictionary: legacy or thin
 * dictionaries may not describe fields well, but the actual data reveals which
 * fields are populated, their likely types, and which are references.
 */

/** A field value can arrive as a scalar, or as a ServiceNow reference object. */
type SNValue = unknown;

/** ServiceNow reference values arrive as { value, display_value, link }. */
interface SNReferenceObject {
	link?: unknown;
	value?: unknown;
	display_value?: unknown;
}

function isReferenceObject(value: unknown): value is SNReferenceObject {
	if (typeof value !== 'object' || value === null) return false;
	const o = value as SNReferenceObject;
	return (('link' in o && 'value' in o) || 'display_value' in o) as boolean;
}

/**
 * Infer a ServiceNow-ish field type from a single value.
 * Booleans and numbers are checked first; reference objects next; then a series
 * of string-shape regexes. Null/'' yields 'unknown'.
 */
export function inferFieldType(value: SNValue): string {
	if (value === null || value === undefined || value === '') return 'unknown';

	if (typeof value === 'boolean') return 'boolean';
	if (typeof value === 'number') return 'number';

	if (isReferenceObject(value)) return 'reference';

	if (typeof value === 'string') {
		const s = value;
		if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return 'glide_date_time';
		if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'glide_date';
		if (/^[0-9a-f]{32}$/.test(s)) return 'sys_id';
		if (s === 'true' || s === 'false') return 'boolean';
		if (/^\d+$/.test(s) && s.length < 10) return 'integer';
		if (/^\d+\.\d+$/.test(s)) return 'decimal';
		return 'string';
	}

	return 'string';
}

/** Is a value considered "empty" (not populated) for ratio purposes? */
function isEmptyValue(value: unknown): boolean {
	if (value === null || value === undefined || value === '') return true;
	if (isReferenceObject(value)) {
		const o = value as SNReferenceObject;
		// A reference with neither a value nor a display_value is effectively empty.
		return !o.value && !o.display_value;
	}
	return false;
}

/** Render a value as a short sample string for display. */
function toSampleString(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'boolean' || typeof value === 'number') return String(value);
	if (isReferenceObject(value)) {
		const o = value as SNReferenceObject;
		const disp = o.display_value ?? o.value;
		return typeof disp === 'string' ? disp : JSON.stringify(disp ?? '');
	}
	return JSON.stringify(value);
}

/**
 * Extract the referenced table name from a reference value's link URL, if
 * present. ServiceNow reference links look like:
 *   https://<host>/api/now/table/<referenced_table>/<sys_id>
 */
function extractReferencesTable(value: unknown): string | undefined {
	if (!isReferenceObject(value)) return undefined;
	const link = (value as SNReferenceObject).link;
	if (typeof link !== 'string') return undefined;
	const match = link.match(/\/api\/now\/(?:v\d+\/)?table\/([a-z0-9_]+)\//i);
	return match ? match[1] : undefined;
}

interface FieldAccumulator {
	seenCount: number;
	nonEmptyCount: number;
	types: Set<string>;
	/** Ordered non-unknown types, first-seen order, for choosing the dominant. */
	typeOrder: string[];
	sampleValues: string[];
	isReference: boolean;
	referencesTable?: string;
}

export interface InferredField {
	name: string;
	inferredType: string;
	/** "<nonEmptyCount>/<total>" — always-populated is nonEmptyCount===total, never-populated is nonEmptyCount===0; both are derivable from this, so they aren't carried as separate top-level lists. */
	populatedRatio: string;
	isReference: boolean;
	/** The referenced table, when derivable from the reference link. Only present when isReference is true. */
	reference?: string;
	sampleValues: string[];
}

export interface TableStructureAnalysis {
	recordsSampled: number;
	fields: InferredField[];
}

/**
 * Analyze an array of sampled records and produce an inferred structure.
 * Pure logic — no network, no dependencies.
 */
export function analyzeTableStructure(
	records: Array<Record<string, unknown>>,
): TableStructureAnalysis {
	const total = records.length;
	const acc = new Map<string, FieldAccumulator>();

	for (const record of records) {
		if (!record || typeof record !== 'object') continue;
		for (const [name, value] of Object.entries(record)) {
			let field = acc.get(name);
			if (!field) {
				field = {
					seenCount: 0,
					nonEmptyCount: 0,
					types: new Set<string>(),
					typeOrder: [],
					sampleValues: [],
					isReference: false,
				};
				acc.set(name, field);
			}

			field.seenCount += 1;

			const empty = isEmptyValue(value);
			if (!empty) {
				field.nonEmptyCount += 1;

				const type = inferFieldType(value);
				if (type !== 'unknown' && !field.types.has(type)) {
					field.types.add(type);
					field.typeOrder.push(type);
				}

				if (type === 'reference') {
					field.isReference = true;
					if (!field.referencesTable) {
						const ref = extractReferencesTable(value);
						if (ref) field.referencesTable = ref;
					}
				}

				if (field.sampleValues.length < 2) {
					field.sampleValues.push(toSampleString(value).slice(0, 80));
				}
			}
		}
	}

	const fields: InferredField[] = [];

	for (const [name, field] of acc) {
		const inferredType = field.typeOrder.length > 0 ? field.typeOrder[0] : 'unknown';

		fields.push({
			name,
			inferredType,
			populatedRatio: `${field.nonEmptyCount}/${total}`,
			isReference: field.isReference,
			...(field.isReference && field.referencesTable ? { reference: field.referencesTable } : {}),
			sampleValues: field.sampleValues,
		});
	}

	return {
		recordsSampled: total,
		fields,
	};
}
