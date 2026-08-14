/**
 * MCP tool for batch updating multiple ServiceNow records
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { BatchUpdateSchema } from '../schemas/batch-schemas.js';
import { BatchOutputSchema } from '../schemas/output-schemas.js';
import type { BatchService } from '../services/batch-service.js';
import type { SchemaService } from '../services/schema-service.js';
import { elicitConfirmation, toolAborted } from '../utils/elicitation.js';
import { toolError } from '../utils/error-handler.js';
import { collectFieldNames, preflightFieldValidation } from '../utils/field-validation.js';
import { logger } from '../utils/logger.js';
import { toolResult } from '../utils/tool-response.js';

export const BATCH_UPDATE_TOOL = {
	name: 'sn_batch_update',
	title: 'Batch update records',
	description: `What: Update many records in one table via the Table Batch API — one request per wave of 25, NOT transactional.
When to use: To change several records at once. For a single record use sn_update_record.
Preconditions: Write-enabled instance (readOnly: false); valid sys_ids and field names. Default max 50 updates per call (configurable via SERVICENOW_MAX_BATCH_SIZE).
Produces: Per-record success/failure with sys_ids, plus counts. Not atomic: on failure, already-applied updates are NOT rolled back — inspect results[].`,
	inputSchema: BatchUpdateSchema,
	outputSchema: BatchOutputSchema,
};

export function createBatchUpdateTool(batchService: BatchService, schemaService?: SchemaService) {
	return {
		...BATCH_UPDATE_TOOL,
		handler: async (params: unknown, server?: Server) => {
			let tableName: string | undefined;
			try {
				// Validate input
				const validated = BatchUpdateSchema.parse(params);
				tableName = validated.tableName;

				logger.info(
					`Batch updating ${validated.updates.length} records in ${validated.tableName}`,
					{
						instance: validated.instance || 'default',
						updateType: validated.updateType,
						continueOnError: validated.continueOnError,
					},
				);

				// Require explicit user confirmation before a multi-record write.
				if (server && validated.updates.length > 0) {
					const confirmed = await elicitConfirmation(
						server,
						`Update ${validated.updates.length} record(s) in '${validated.tableName}'? This modifies live data and is not transactional.`,
					);
					if (!confirmed) return toolAborted('Batch update cancelled by user.');
				}

				// Pre-flight: validate the union of field names across the whole batch.
				// A typo'd field would otherwise be silently dropped on up to 50 records.
				const message = await preflightFieldValidation(
					schemaService,
					validated.tableName,
					collectFieldNames(validated.updates.map((u) => u.fields)),
					{ skip: validated.skipFieldValidation, instance: validated.instance },
				);
				if (message) {
					return { content: [{ type: 'text' as const, text: message }], isError: true as const };
				}

				// Perform batch update
				const result = await batchService.batchUpdate(
					validated.tableName,
					validated.updates,
					validated.updateType,
					validated.continueOnError,
					validated.instance,
				);

				const response = {
					success: result.success,
					table: validated.tableName,
					instance: validated.instance || 'default',
					updateType: validated.updateType,
					summary: {
						total: validated.updates.length,
						successCount: result.successCount,
						failureCount: result.failureCount,
					},
					results: result.results,
				};

				return toolResult(
					response,
					`batch update ${validated.tableName}: ${result.successCount} ok, ${result.failureCount} failed`,
				);
			} catch (error) {
				logger.error('Error in batch update operation', error);
				return toolError(error, { table: tableName, operation: 'update' });
			}
		},
	};
}
