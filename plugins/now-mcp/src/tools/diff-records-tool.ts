/**
 * MCP tool for comparing two ServiceNow records field-by-field.
 */

import { DiffRecordsOutputSchema, DiffRecordsSchema } from '../schemas/diff-schemas.js';
import type { TableService } from '../services/table-service.js';
import { toolError } from '../utils/error-handler.js';
import { logger } from '../utils/logger.js';
import { toolResult } from '../utils/tool-response.js';
import { truncateValue } from '../utils/value-truncation.js';

/** Same rationale as query-records-tool: a single huge field (a script body, an
 * XML payload) diffed on both sides can double its size in the response. */
const MAX_DIFF_VALUE_CHARS = 3000;

export const DIFF_RECORDS_TOOL = {
	name: 'sn_diff_records',
	title: 'Diff records',
	description: `What: Compare two records on the same table field-by-field and report only the fields that differ.
When to use: To see what changed between two records (e.g. a record and its clone, or two similar incidents) without fetching both and diffing by hand.
Preconditions: Read access; both sys_ids must exist on the given table.
Produces: fieldsCompared (union of field names inspected), fieldsChanged, and diffs — a map of each changed field to its two values {a (record A), b (record B)}. Restrict the comparison with the optional fields[] argument.`,
	inputSchema: DiffRecordsSchema,
	outputSchema: DiffRecordsOutputSchema,
};

export function createDiffRecordsTool(tableService: TableService) {
	return {
		...DIFF_RECORDS_TOOL,
		handler: async (params: unknown) => {
			let tableName: string | undefined;
			try {
				// Validate input
				const validated = DiffRecordsSchema.parse(params);
				tableName = validated.tableName;

				logger.info(
					`Diffing records ${validated.sysIdA} vs ${validated.sysIdB} on ${validated.tableName}`,
					{ instance: validated.instance || 'default' },
				);

				// Fetch both records in parallel. getRecord throws NotFoundError on a
				// missing sys_id — the catch below routes that to toolError.
				const [recordA, recordB] = await Promise.all([
					tableService.getRecord(
						validated.tableName,
						validated.sysIdA,
						validated.fields,
						validated.instance,
					),
					tableService.getRecord(
						validated.tableName,
						validated.sysIdB,
						validated.fields,
						validated.instance,
					),
				]);

				// Compare over the union of keys present on either record. JSON.stringify
				// gives a stable structural comparison for both scalar and reference
				// (object) field values.
				const keys = new Set<string>([...Object.keys(recordA), ...Object.keys(recordB)]);
				const diffs: Record<string, { a: unknown; b: unknown }> = {};
				let valuesTruncated = false;
				for (const key of keys) {
					const a = (recordA as Record<string, unknown>)[key];
					const b = (recordB as Record<string, unknown>)[key];
					if (JSON.stringify(a) !== JSON.stringify(b)) {
						const ta = truncateValue(a, MAX_DIFF_VALUE_CHARS);
						const tb = truncateValue(b, MAX_DIFF_VALUE_CHARS);
						if (ta.truncated || tb.truncated) valuesTruncated = true;
						diffs[key] = { a: ta.value, b: tb.value };
					}
				}

				const response: Record<string, unknown> = {
					success: true,
					table: validated.tableName,
					fieldsCompared: keys.size,
					fieldsChanged: Object.keys(diffs).length,
					diffs,
				};
				if (valuesTruncated) {
					response.valuesTruncated = true;
				}

				if (valuesTruncated) {
					response.hints = [
						`One or more diffed values exceeded ${MAX_DIFF_VALUE_CHARS} chars and were truncated ` +
							`(marked "…[truncated N chars]"). Use the fields[] argument to restrict the comparison, or ` +
							`fetch the full value directly if you need it in full.`,
					];
				}

				return toolResult(
					response,
					`${Object.keys(diffs).length} field(s) differ of ${keys.size} on ${validated.tableName}${
						valuesTruncated ? ' (some values truncated)' : ''
					}`,
				);
			} catch (error) {
				logger.error('Error diffing records', error);
				return toolError(error, { table: tableName, operation: 'diff records' });
			}
		},
	};
}
