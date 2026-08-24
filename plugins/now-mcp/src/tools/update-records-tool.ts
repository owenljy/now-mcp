/**
 * MCP tool for updating one or many ServiceNow records.
 *
 * Replaces the former sn_update_record / sn_batch_update pair — see
 * create-records-tool.ts for why cardinality is data rather than a separate tool,
 * and why the transports still differ internally (one record over the plain Table
 * API, two or more over the Table Batch API).
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WriteRecordsOutputSchema } from '../schemas/output-schemas.js';
import { UpdateRecordsSchema } from '../schemas/table-schemas.js';
import type { BatchService } from '../services/batch-service.js';
import type { SchemaService } from '../services/schema-service.js';
import type { TableService } from '../services/table-service.js';
import { type EffectiveAccessReader, preflightEffectiveAccess } from '../utils/access-preflight.js';
import { elicitConfirmation, toolAborted } from '../utils/elicitation.js';
import { toolError } from '../utils/error-handler.js';
import { resultsFailureHints } from '../utils/failure-enrichment.js';
import { collectFieldNames, preflightFieldValidation } from '../utils/field-validation.js';
import { logger } from '../utils/logger.js';
import { writeResult } from '../utils/tool-response.js';
import {
	fieldMismatches,
	NOT_PERSISTED_DIAGNOSIS,
	NOT_PERSISTED_MESSAGE,
	VERIFICATION_EVIDENCE_FIELDS,
} from '../utils/write-verification.js';

export const UPDATE_RECORDS_TOOL = {
	name: 'sn_update_records',
	title: 'Update records',
	description: `What: Modify one or many existing records by sys_id (PATCH partial or PUT full). Pass a single update or a list — same tool either way. Two or more go over the Table Batch API (one request per wave of 25, NOT transactional).
When to use: To change field values on known records. Pass every update in ONE call — do not loop this tool per record. For app metadata, use the Fluent SDK instead.
Preconditions: Write-enabled instance (readOnly: false); valid sys_ids; field names valid for the table (validated automatically across every update). Default max 50 updates per call (configurable via SERVICENOW_MAX_BATCH_SIZE). Updating more than one record asks the user to confirm first.
Produces: Per-record success/failure with sys_ids, plus counts; a single-record call also echoes the fields it changed. Multi-record calls are not atomic: already-applied updates are NOT rolled back — inspect results[].
verify (default true) reads every record back and compares the requested values, batched into one extra request — so an update ServiceNow answered 200 to but which did not persist is reported as a FAILURE naming the fields that disagreed, not as a success.
Scope: when tableName belongs to a scoped app (sys_db_object.sys_scope), the write automatically runs in that app's transaction scope (sysparm_transaction_scope) — no extra input needed, and global tables are unaffected.
Optional: preflightAccess: true asks ServiceNow for the API user's effective canWrite verdict before sending: table-level plus each requested field, evaluated against the target row (the FIRST row when several are updated, not every one).`,
	inputSchema: UpdateRecordsSchema,
	outputSchema: WriteRecordsOutputSchema,
};

export function createUpdateRecordsTool(
	tableService: TableService,
	batchService: BatchService,
	schemaService?: SchemaService,
	accessReader?: EffectiveAccessReader,
) {
	return {
		...UPDATE_RECORDS_TOOL,
		handler: async (params: unknown, server?: Server) => {
			try {
				// Validate input
				const validated = UpdateRecordsSchema.parse(params);
				const { tableName, updates, updateType, instance } = validated;
				const fields = collectFieldNames(updates.map((u) => u.fields));

				logger.info(`Updating ${updates.length} record(s) in ${tableName}`, {
					instance: instance || 'default',
					fields,
					updateType,
					continueOnError: validated.continueOnError,
					verify: validated.verify,
				});

				// Confirm a MULTI-record write, which is the case a caller cannot easily
				// eyeball. A single update stays unprompted, exactly as before the merge —
				// one targeted field change is ordinary work, and prompting for it would
				// train the user to accept without reading.
				if (server && updates.length > 1) {
					const confirmed = await elicitConfirmation(
						server,
						`Update ${updates.length} records in '${tableName}'? This modifies live data and is not transactional.`,
					);
					if (!confirmed) return toolAborted('Update cancelled by user.');
				}

				// Pre-flight: catch typo'd field names that the Table API would silently
				// drop. Validated as the union across every update, in one call.
				const message = await preflightFieldValidation(schemaService, tableName, fields, {
					skip: validated.skipFieldValidation,
					instance,
				});
				if (message) {
					return { content: [{ type: 'text' as const, text: message }], isError: true as const };
				}

				// Opt-in pre-flight. Pinning a row by sys_id matters: field verdicts are
				// evaluated against a specific record, so an ACL condition that depends on
				// the row's own data is reflected rather than approximated. With several
				// rows the first is sampled rather than paying a probe per sys_id — the
				// table verdict applies to all of them either way.
				const accessDenial = await preflightEffectiveAccess(accessReader, {
					operation: 'update',
					tableName,
					fields,
					recordQuery: `sys_id=${updates[0].sysId}`,
					instance,
					enabled: validated.preflightAccess,
				});
				if (accessDenial) {
					return {
						content: [{ type: 'text' as const, text: accessDenial }],
						isError: true as const,
					};
				}

				if (updates.length === 1) {
					const { sysId, fields: requested } = updates[0];
					const record = await tableService.updateRecord(
						tableName,
						sysId,
						requested,
						updateType === 'full',
						instance,
					);

					if (validated.verify) {
						const reread = await tableService.getRecord(
							tableName,
							sysId,
							[...VERIFICATION_EVIDENCE_FIELDS, ...Object.keys(requested)],
							instance,
						);
						const mismatches = fieldMismatches(requested, reread);
						if (mismatches.length > 0) {
							return writeResult(
								{
									success: false,
									table: tableName,
									instance: instance || 'default',
									updateType,
									summary: { total: 1, successCount: 0, failureCount: 1 },
									results: [
										{
											index: 0,
											success: false,
											sysId,
											verified: false,
											mismatches,
											record: reread,
											error: NOT_PERSISTED_MESSAGE,
										},
									],
									...NOT_PERSISTED_DIAGNOSIS,
								},
								`update ${tableName} ${sysId} did NOT persist: ${mismatches.map((m) => m.field).join(', ')}`,
							);
						}
					}

					// Lean echo: sys_id + the fields the caller changed, not the whole row.
					const changed: Record<string, unknown> = { sys_id: record.sys_id };
					for (const k of Object.keys(requested)) {
						if (k in record) changed[k] = record[k];
					}
					return writeResult(
						{
							success: true,
							table: tableName,
							instance: instance || 'default',
							updateType,
							summary: { total: 1, successCount: 1, failureCount: 0 },
							results: [
								{
									index: 0,
									success: true,
									sysId,
									...(validated.verify ? { verified: true } : {}),
									record: changed,
								},
							],
						},
						`updated ${tableName} ${sysId}`,
					);
				}

				const result = await batchService.batchUpdate(
					tableName,
					updates,
					updateType,
					validated.continueOnError,
					validated.verify,
					instance,
				);

				// A batch reports failures inside results[] rather than throwing, so the
				// recovery guidance a thrown error would have carried rides in the body.
				const hints = resultsFailureHints(result.results, {
					table: tableName,
					operation: 'update',
				});
				// A write that reported success but did not persist is a different problem
				// from a rejected write, and it has its own follow-up tool.
				const notPersisted = result.results.some((r) => r?.mismatches?.length);

				return writeResult(
					{
						success: result.success,
						table: tableName,
						instance: instance || 'default',
						updateType,
						summary: {
							total: updates.length,
							successCount: result.successCount,
							failureCount: result.failureCount,
						},
						results: result.results,
						...(notPersisted ? NOT_PERSISTED_DIAGNOSIS : {}),
						...(hints.length > 0 ? { hints } : {}),
					},
					`update ${tableName}: ${result.successCount} ok, ${result.failureCount} failed`,
				);
			} catch (error) {
				logger.error('Error updating record(s)', error);
				return toolError(error, {
					table: (params as { tableName?: string })?.tableName,
					operation: 'update',
				});
			}
		},
	};
}
