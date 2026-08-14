/**
 * MCP tool for deleting one or many ServiceNow records.
 *
 * Replaces the former sn_delete_record / sn_batch_delete pair. The split forced
 * the caller to choose a tool by cardinality, which carries no meaning: the
 * underlying Table API call is the same, and "how many records" is data, not a
 * different operation. One record is an array of length one.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { DeleteRecordsOutputSchema } from '../schemas/output-schemas.js';
import { DeleteRecordsSchema } from '../schemas/table-schemas.js';
import type { BatchService } from '../services/batch-service.js';
import { elicitConfirmation, toolAborted } from '../utils/elicitation.js';
import { toolError } from '../utils/error-handler.js';
import { logger } from '../utils/logger.js';
import { toolResult } from '../utils/tool-response.js';

export const DELETE_RECORDS_TOOL = {
	name: 'sn_delete_records',
	title: 'Delete records',
	description: `What: Permanently delete one or many records by sys_id (destructive). Pass a single sys_id or a list — same tool either way.
When to use: The FIRST and preferred tool for removing data records. Use it before reaching for GlideRecord.deleteRecord() in sn_execute_background_script; the dedicated Table API path is simpler, auditable, and verified by a read-after-delete by default.
Preconditions: Write-enabled instance (readOnly: false); valid sys_ids. This tool does not run a query — resolve the sys_ids with sn_query_records first and confirm the matches. Default max 50 per call (configurable via SERVICENOW_MAX_BATCH_SIZE).
Produces: Per-record success/failure with sys_ids, plus counts. Not atomic: already-deleted records are NOT restored if a later one fails — inspect results[].

WARNING: permanent hard delete. There is no trash/undo — recovery is only possible via a rollback context on audited tables or a database backup, so do not assume it's reversible. Verify the sys_ids first; consider deactivating (active=false) instead of deleting. This deletes DATA records — app config/metadata is managed via the Fluent SDK. Business rules or missing permissions may block a delete. If API deletion fails while UI deletion succeeds, compare the actual API and UI users, roles, domain/scope, ACLs, and transaction-specific logic; do not infer an undocumented "UI-only" restriction without evidence.

verify (default true) reads each record back to confirm it is gone, batched into one extra request — so a record the API claimed to delete but which still exists is reported as a failure, not a success.`,
	inputSchema: DeleteRecordsSchema,
	outputSchema: DeleteRecordsOutputSchema,
};

export function createDeleteRecordsTool(batchService: BatchService) {
	return {
		...DELETE_RECORDS_TOOL,
		handler: async (params: unknown, server?: Server) => {
			let tableName: string | undefined;
			try {
				const validated = DeleteRecordsSchema.parse(params);
				tableName = validated.tableName;
				const count = validated.sysIds.length;

				logger.info(`Deleting ${count} record(s) from ${validated.tableName}`, {
					instance: validated.instance || 'default',
					continueOnError: validated.continueOnError,
					verify: validated.verify,
				});

				// One confirmation for the whole call, whether it's one record or fifty.
				if (server) {
					const subject = count === 1 ? `record ${validated.sysIds[0]}` : `${count} records`;
					const confirmed = await elicitConfirmation(
						server,
						`Permanently delete ${subject} from '${validated.tableName}'? This cannot be undone.`,
					);
					if (!confirmed) return toolAborted('Delete cancelled by user.');
				}

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
						total: count,
						successCount: result.successCount,
						failureCount: result.failureCount,
					},
					results: result.results,
					warning: 'Deleted records are permanently gone',
				};

				return toolResult(
					response,
					`delete ${validated.tableName}: ${result.successCount} ok, ${result.failureCount} failed`,
				);
			} catch (error) {
				logger.error('Error deleting records', error);
				return toolError(error, {
					table: tableName,
					operation: 'delete',
					requiredRoles: ['admin', 'itil'],
				});
			}
		},
	};
}
