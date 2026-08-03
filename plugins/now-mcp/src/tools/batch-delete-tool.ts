/**
 * MCP tool for batch deleting multiple ServiceNow records
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { BatchDeleteSchema } from '../schemas/batch-schemas.js';
import { BatchOutputSchema } from '../schemas/output-schemas.js';
import type { BatchService } from '../services/batch-service.js';
import { elicitConfirmation, toolAborted } from '../utils/elicitation.js';
import { toolError } from '../utils/error-handler.js';
import { logger } from '../utils/logger.js';
import { toolResult } from '../utils/tool-response.js';

export const BATCH_DELETE_TOOL = {
	name: 'sn_batch_delete',
	title: 'Batch delete records',
	description: `What: Permanently delete many already-identified records (by sys_id) in one table via looped Table API calls (25 concurrent, rate-limited) — not a single bulk request and NOT transactional.
When to use: To delete a batch of records whose sys_ids you already have (e.g. from a prior sn_query_records call). For a single record use sn_delete_record. This tool does not run a query itself — resolve matching sys_ids with sn_query_records first, confirm the matches, then pass them here.
Preconditions: Write-enabled instance (readOnly: false); valid sys_ids. Default max 50 deletes per call (configurable via SERVICENOW_MAX_BATCH_SIZE).
Produces: Per-record success/failure with sys_ids, plus counts. Not atomic: on failure, already-deleted records are NOT restored — inspect results[].

WARNING: permanent hard delete. There is no trash/undo — recovery is only possible via a rollback context on audited tables or a database backup, so do not assume it's reversible. Verify the sys_ids first; consider deactivating (active=false) instead of deleting. This deletes DATA records — app config/metadata is managed via the Fluent SDK.`,
	inputSchema: BatchDeleteSchema,
	outputSchema: BatchOutputSchema,
};

export function createBatchDeleteTool(batchService: BatchService) {
	return {
		...BATCH_DELETE_TOOL,
		handler: async (params: unknown, server?: Server) => {
			let tableName: string | undefined;
			try {
				// Validate input
				const validated = BatchDeleteSchema.parse(params);
				tableName = validated.tableName;

				logger.info(`Batch deleting ${validated.sysIds.length} records in ${validated.tableName}`, {
					instance: validated.instance || 'default',
					continueOnError: validated.continueOnError,
					verify: validated.verify,
				});

				// Require a single explicit user confirmation for the whole batch,
				// rather than one prompt per record.
				if (server && validated.sysIds.length > 0) {
					const confirmed = await elicitConfirmation(
						server,
						`Permanently delete ${validated.sysIds.length} record(s) from '${validated.tableName}'? This cannot be undone.`,
					);
					if (!confirmed) return toolAborted('Batch delete cancelled by user.');
				}

				// Perform batch delete
				const result = await batchService.batchDelete(
					validated.tableName,
					validated.sysIds,
					validated.continueOnError,
					validated.verify,
					validated.instance,
				);

				const response = {
					success: result.success,
					table: validated.tableName,
					instance: validated.instance || 'default',
					summary: {
						total: validated.sysIds.length,
						successCount: result.successCount,
						failureCount: result.failureCount,
					},
					results: result.results,
				};

				return toolResult(
					response,
					`batch delete ${validated.tableName}: ${result.successCount} ok, ${result.failureCount} failed`,
				);
			} catch (error) {
				logger.error('Error in batch delete operation', error);
				return toolError(error, { table: tableName, operation: 'delete' });
			}
		},
	};
}
