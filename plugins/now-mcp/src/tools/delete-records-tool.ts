/**
 * MCP tool for deleting one or many ServiceNow records.
 *
 * Replaces the former sn_delete_record / sn_batch_delete pair. The split forced
 * the caller to choose a tool by cardinality, which carries no meaning: the
 * underlying Table API call is the same, and "how many records" is data, not a
 * different operation. One record is an array of length one. sn_create_records
 * and sn_update_records followed for the same reason.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WriteRecordsOutputSchema } from '../schemas/output-schemas.js';
import { DeleteRecordsSchema } from '../schemas/table-schemas.js';
import type { BatchService } from '../services/batch-service.js';
import type { SchemaService } from '../services/schema-service.js';
import type { TableService } from '../services/table-service.js';
import { CASCADE_COLUMNS, isConsequential, scanCascadeImpact } from '../utils/cascade-scan.js';
import { elicitConfirmation, toolAborted } from '../utils/elicitation.js';
import { toolError } from '../utils/error-handler.js';
import { resultsFailureHints } from '../utils/failure-enrichment.js';
import { logger } from '../utils/logger.js';
import { toolResult, writeResult } from '../utils/tool-response.js';

export const DELETE_RECORDS_TOOL = {
	name: 'sn_delete_records',
	title: 'Delete records',
	description: `What: Permanently delete one or many records by sys_id (destructive). Pass a single sys_id or a list — same tool either way.
When to use: The FIRST and preferred tool for removing data records. Use it before reaching for GlideRecord.deleteRecord() in sn_execute_background_script; the dedicated Table API path is simpler, auditable, and verified by a read-after-delete by default.
Preconditions: Write-enabled instance (readOnly: false); valid sys_ids. This tool does not run a query — resolve the sys_ids with sn_query_records first and confirm the matches. Default max 50 per call (configurable via SERVICENOW_MAX_BATCH_SIZE).
Produces: Per-record success/failure with sys_ids, plus counts. Not atomic: already-deleted records are NOT restored if a later one fails — inspect results[].

Cascade pre-flight (default on): counts rows pointing AT these records via reference columns with a live cascade rule, ancestors included. If the delete would destroy other rows or be refused by the platform, NOTHING is deleted — the result carries cascadeImpact per column; show the caller, then re-run with acknowledgeCascade:true. Default-on because a cascade/delete rule is silent: the delete succeeds, taking every referencing row with it, no undo. Columns with no rule are skipped, so dangling references are NOT reported.

WARNING: permanent hard delete. There is no trash/undo — recovery is only possible via a rollback context on audited tables or a database backup, so do not assume it's reversible. Verify the sys_ids first; consider deactivating (active=false) instead of deleting. This deletes DATA records — app config/metadata is managed via the Fluent SDK. Business rules or missing permissions may block a delete. If API deletion fails while UI deletion succeeds, compare the actual API and UI users, roles, domain/scope, ACLs, and transaction-specific logic; do not infer an undocumented "UI-only" restriction without evidence.

verify (default true, see its own field doc) means a record the API claimed to delete but which still exists is reported as a failure, not a success.`,
	inputSchema: DeleteRecordsSchema,
	outputSchema: WriteRecordsOutputSchema,
};

export function createDeleteRecordsTool(
	batchService: BatchService,
	tableService: Pick<TableService, 'queryRecords' | 'aggregateRecords'>,
	schemaService: Pick<SchemaService, 'tableChain'>,
) {
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

				// Cascade pre-flight. Skipped entirely once acknowledged — that both
				// honours the caller's decision and gives them a way to opt out of the
				// requests. A scan that could not run (`scanned: false`) fails OPEN:
				// an unreadable sys_dictionary is not grounds to refuse a delete the
				// user asked for.
				if (!validated.acknowledgeCascade) {
					const impact = await scanCascadeImpact(tableService, schemaService, {
						tableName: validated.tableName,
						sysIds: validated.sysIds,
						instance: validated.instance,
					});
					if (impact.scanned && isConsequential(impact)) {
						const subject = count === 1 ? 'this record' : `these ${count} records`;
						const parts = [
							impact.cascadeRowCount > 0
								? `${impact.cascadeRowCount} row(s) would be DELETED along with ${subject}`
								: '',
							impact.blockedBy.length > 0
								? `the platform will REFUSE the delete while ${impact.blockedBy.join(', ')} still reference ${subject}`
								: '',
						].filter(Boolean);
						const blocked = {
							success: false,
							table: validated.tableName,
							instance: validated.instance || 'default',
							// Nothing was attempted, so every count is zero — `deleted`
							// and `reason` are what separate that from "attempted, all
							// failed", which carries the same zeros.
							summary: { total: count, successCount: 0, failureCount: 0 },
							results: [],
							deleted: false,
							reason: 'cascade_impact',
							message: `Nothing was deleted. ${parts.join('; ')}.`,
							cascadeImpact: { ...impact, columns: CASCADE_COLUMNS },
							hints: [
								'Show the caller the cascadeImpact rows before going further — the referencing rows are gone for good too.',
								'To proceed anyway, re-run the same call with acknowledgeCascade:true.',
								...(impact.blockedBy.length > 0
									? [
											`acknowledgeCascade will NOT get past ${impact.blockedBy.join(', ')} — that rule is enforced by the platform. Clear or delete those rows first.`,
										]
									: []),
								...(impact.notProbedCount
									? [
											`${impact.notProbedCount} rule-carrying column(s) were not counted, so the impact above is a floor, not a total.`,
										]
									: []),
							],
						};
						return {
							...toolResult(
								blocked,
								`delete ${validated.tableName}: refused — ${impact.cascadeRowCount} row(s) would cascade${
									impact.blockedBy.length > 0 ? `, ${impact.blockedBy.length} blocking rule(s)` : ''
								}`,
							),
							isError: true as const,
						};
					}
				}

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

				const response: Record<string, unknown> & {
					summary: { total: number; successCount: number; failureCount: number };
				} = {
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

				// Per-record failures never throw, so the recovery guidance a thrown
				// error would have carried rides in the body, taken from the first one.
				const hints = resultsFailureHints(result.results, {
					table: validated.tableName,
					operation: 'delete',
					requiredRoles: ['admin', 'itil'],
				});
				if (hints.length > 0) response.hints = hints;

				return writeResult(
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
