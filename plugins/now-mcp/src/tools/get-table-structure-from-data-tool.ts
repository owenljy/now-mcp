/**
 * MCP tool for inferring a ServiceNow table's structure from sampled data.
 *
 * A fallback for sn_get_table_schema: rather than reading
 * sys_dictionary (which can be thin on legacy/custom tables), this samples real
 * records and infers each field's type, populated ratio, and references.
 */

import {
	GetTableStructureFromDataOutputSchema,
	GetTableStructureFromDataSchema,
} from '../schemas/table-structure-schemas.js';
import type { TableService } from '../services/table-service.js';
import { analyzeTableStructure } from '../services/table-structure-service.js';
import { toolError } from '../utils/error-handler.js';
import { logger } from '../utils/logger.js';
import { capRendered } from '../utils/render-cap.js';
import { toolResult } from '../utils/tool-response.js';

/** ~200 KB of serialized fields before trailing ones are dropped with a note — matches get-table-schema-tool. */
const MAX_FIELDS_BYTES = 200_000;

export const GET_TABLE_STRUCTURE_FROM_DATA_TOOL = {
	name: 'sn_get_table_structure_from_data',
	title: 'Get table structure from data',
	description: `What: Infer a table's structure by sampling actual records — per-field inferred type, how often each field is populated, and which fields are references.
When to use: As a fallback for sn_get_table_schema when the sys_dictionary is thin or misleading (legacy/custom tables), or to see which fields are actually used vs. always empty in practice.
Preconditions: Read access; the table must exist and contain records (an empty table yields no fields).
Produces: recordsSampled and a fields array of {name, inferredType, populatedRatio ("<nonEmpty>/<total>" — always/never-populated read off this directly), isReference, reference (the referenced table, when derivable), sampleValues (up to 2, each capped at 80 chars)}.

Example: tableName="u_legacy_table", sampleSize=20 (sampleSize defaults to 5).`,
	inputSchema: GetTableStructureFromDataSchema,
	outputSchema: GetTableStructureFromDataOutputSchema,
};

export function createGetTableStructureFromDataTool(tableService: TableService) {
	return {
		...GET_TABLE_STRUCTURE_FROM_DATA_TOOL,
		handler: async (params: unknown) => {
			let tableName: string | undefined;
			try {
				const validated = GetTableStructureFromDataSchema.parse(params);
				tableName = validated.tableName;

				logger.info(`Inferring structure for ${validated.tableName} from data`, {
					sampleSize: validated.sampleSize,
					instance: validated.instance || 'default',
				});

				const records = await tableService.queryRecords(
					validated.tableName,
					{ limit: validated.sampleSize },
					validated.instance,
				);

				const analysis = analyzeTableStructure(records as Array<Record<string, unknown>>);

				// Cap the serialized size of `fields` so a very wide table (or fields with
				// long sample values) truncates cleanly at a field boundary instead of
				// mid-JSON at the text-renderer's char cap — matches get-table-schema-tool.
				const { rows: fields, truncated: fieldsTruncated } = capRendered(analysis.fields, {
					maxRows: Number.POSITIVE_INFINITY,
					maxBytes: MAX_FIELDS_BYTES,
				});

				const response: Record<string, unknown> = {
					success: true,
					table: validated.tableName,
					...analysis,
					fields,
				};
				if (fieldsTruncated) response.fieldsTruncated = true;

				const summary = `${analysis.fields.length} field(s) inferred on ${validated.tableName} from ${analysis.recordsSampled} sample(s)${
					fieldsTruncated ? ` (showing ${fields.length})` : ''
				}`;
				return toolResult(response, summary);
			} catch (error) {
				logger.error('Error inferring table structure from data', error);
				return toolError(error, {
					table: tableName,
					operation: 'get table structure from data',
				});
			}
		},
	};
}
