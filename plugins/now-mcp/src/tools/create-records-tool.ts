/**
 * MCP tool for creating one or many ServiceNow records.
 *
 * Replaces the former sn_create_record / sn_batch_create pair. The split made the
 * caller choose a tool by cardinality, which carries no meaning — one record is a
 * list of length one — and it cost more than the equivalent delete split did: an
 * agent looking at two tools loops the single-record one, paying fifty round
 * trips for work the batch endpoint does in two.
 *
 * The two TRANSPORTS still differ, so the tool routes internally: one record goes
 * over the plain Table API, where a refusal arrives as a real HTTP status (with
 * recovery hints) and the response can echo the fields that were set; two or more
 * go over the Table Batch API in waves.
 */

import { WriteRecordsOutputSchema } from '../schemas/output-schemas.js';
import { CreateRecordsSchema } from '../schemas/table-schemas.js';
import type { BatchService } from '../services/batch-service.js';
import type { SchemaService } from '../services/schema-service.js';
import type { TableService } from '../services/table-service.js';
import { type EffectiveAccessReader, preflightEffectiveAccess } from '../utils/access-preflight.js';
import { toolError } from '../utils/error-handler.js';
import { renderHints, resultsFailureHints } from '../utils/failure-enrichment.js';
import { collectFieldNames, preflightFieldValidation } from '../utils/field-validation.js';
import { logger } from '../utils/logger.js';
import { writeResult } from '../utils/tool-response.js';
import { checkWriteRouting } from '../utils/write-routing.js';

export const CREATE_RECORDS_TOOL = {
	name: 'sn_create_records',
	title: 'Create records',
	description: `What: Insert one or many records into a ServiceNow table. Pass a single record or a list — same tool either way. Two or more go over the Table Batch API (one request per wave of 25, NOT transactional).
When to use: To create data records (incident, sys_user, etc.). Pass every record in ONE call — do not loop this tool per record. Do NOT use it to author app metadata (business rules, ACLs, UI policies) — that belongs in the Fluent SDK.
When NOT to use: cmdb_ci* — a direct insert bypasses the Identification and Reconciliation Engine and creates duplicate CIs; use /api/now/identifyreconcile. sc_request / sc_req_item / sc_task — a direct insert produces a request no workflow ever picks up; use the Service Catalog order API. Both are blocked here with the correct call named in the error.
Preconditions: Write-enabled instance (readOnly: false); field names valid for the table (validated automatically across every record). Default max 50 records per call (configurable via SERVICENOW_MAX_BATCH_SIZE).
Produces: Per-record success/failure with sys_ids, plus counts; a single-record call also echoes the fields it set. Multi-record calls are not atomic: on failure, already-created rows are NOT rolled back — inspect results[] to see what landed.
Scope: when tableName belongs to a scoped app (sys_db_object.sys_scope), the write automatically runs in that app's transaction scope (sysparm_transaction_scope) — no extra input needed, and global tables are unaffected.
Optional: preflightAccess: true asks ServiceNow for the API user's effective canCreate verdict once before sending anything and refuses locally if it is false — useful on tables where an ACL with admin_overrides=false denies even admin.`,
	inputSchema: CreateRecordsSchema,
	outputSchema: WriteRecordsOutputSchema,
};

export function createCreateRecordsTool(
	tableService: TableService,
	batchService: BatchService,
	schemaService?: SchemaService,
	accessReader?: EffectiveAccessReader,
) {
	return {
		...CREATE_RECORDS_TOOL,
		handler: async (params: unknown) => {
			try {
				// Validate input
				const validated = CreateRecordsSchema.parse(params);
				const { tableName, records, instance } = validated;

				logger.info(`Creating ${records.length} record(s) in ${tableName}`, {
					instance: instance || 'default',
					fields: collectFieldNames(records),
					continueOnError: validated.continueOnError,
				});

				// Pre-flight: some tables are the OUTPUT of a platform engine, and a
				// direct insert produces a broken row that ServiceNow still answers 201
				// to — fifty of them just as happily as one.
				const routingError = await checkWriteRouting(
					tableName,
					validated.acknowledgeRoutingRisk,
					schemaService,
					instance,
				);
				if (routingError) {
					return {
						content: [{ type: 'text' as const, text: routingError }],
						isError: true as const,
					};
				}

				// Pre-flight: catch typo'd field names that the Table API would silently
				// drop. Validated as the union across every record, in one call.
				const message = await preflightFieldValidation(
					schemaService,
					tableName,
					collectFieldNames(records),
					{ skip: validated.skipFieldValidation, instance },
				);
				if (message) {
					return { content: [{ type: 'text' as const, text: message }], isError: true as const };
				}

				// Opt-in pre-flight: ask the platform whether this caller may insert here
				// at all, so a denial is explained before the request instead of arriving
				// as a 403 (or a 200 that persisted nothing). One verdict covers the whole
				// call — every record is an insert into the same table.
				const accessDenial = await preflightEffectiveAccess(accessReader, {
					operation: 'create',
					tableName,
					instance,
					enabled: validated.preflightAccess,
				});
				if (accessDenial) {
					return {
						content: [{ type: 'text' as const, text: accessDenial }],
						isError: true as const,
					};
				}

				if (records.length === 1) {
					const record = await tableService.createRecord(tableName, records[0], instance);
					const sysId = typeof record.sys_id === 'string' ? record.sys_id : undefined;
					// Lean echo: sys_id + the fields the caller set, not the whole freshly
					// created row (dozens of system defaults it can re-query if needed).
					const created: Record<string, unknown> = { sys_id: record.sys_id };
					for (const k of Object.keys(records[0])) {
						if (k in record) created[k] = record[k];
					}
					return writeResult(
						{
							success: true,
							table: tableName,
							instance: instance || 'default',
							summary: { total: 1, successCount: 1, failureCount: 0 },
							results: [{ index: 0, success: true, ...(sysId ? { sysId } : {}), record: created }],
						},
						`created ${tableName} ${sysId ?? ''}`.trim(),
					);
				}

				const result = await batchService.batchCreate(
					tableName,
					records,
					validated.continueOnError,
					instance,
				);

				// A batch reports failures inside results[] rather than throwing, so the
				// recovery guidance a thrown error would have carried is attached here.
				const hints = renderHints(
					resultsFailureHints(result.results, { table: tableName, operation: 'create' }),
				);

				return writeResult(
					{
						success: result.success,
						table: tableName,
						instance: instance || 'default',
						summary: {
							total: records.length,
							successCount: result.successCount,
							failureCount: result.failureCount,
						},
						results: result.results,
					},
					`create ${tableName}: ${result.successCount} ok, ${result.failureCount} failed`,
					{ extraText: hints ? [hints] : [] },
				);
			} catch (error) {
				logger.error('Error creating record(s)', error);
				return toolError(error, {
					table: (params as { tableName?: string })?.tableName,
					operation: 'create',
				});
			}
		},
	};
}
