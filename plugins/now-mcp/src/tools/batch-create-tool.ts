/**
 * MCP tool for batch creating multiple ServiceNow records
 */

import { BatchCreateSchema } from '../schemas/batch-schemas.js';
import { BatchOutputSchema } from '../schemas/output-schemas.js';
import type { BatchService } from '../services/batch-service.js';
import type { SchemaService } from '../services/schema-service.js';
import { type EffectiveAccessReader, preflightEffectiveAccess } from '../utils/access-preflight.js';
import { toolError } from '../utils/error-handler.js';
import { collectFieldNames, preflightFieldValidation } from '../utils/field-validation.js';
import { logger } from '../utils/logger.js';
import { toolResult } from '../utils/tool-response.js';
import { checkWriteRouting } from '../utils/write-routing.js';

export const BATCH_CREATE_TOOL = {
	name: 'sn_batch_create',
	title: 'Batch create records',
	description: `What: Create many records in one table via the Table Batch API — one request per wave of 25, NOT transactional.
When to use: To insert several records at once. For a single record use sn_create_record.
When NOT to use: cmdb_ci* (bypasses the Identification and Reconciliation Engine → duplicate CIs) and sc_request / sc_req_item / sc_task (bypasses the catalog workflow). Both are blocked with the correct API named in the error.
Preconditions: Write-enabled instance (readOnly: false); valid field names (validated automatically). Default max 50 records per call (configurable via SERVICENOW_MAX_BATCH_SIZE).
Produces: Per-record success/failure with sys_ids, plus success/failure counts. Not atomic: on failure, already-created rows are NOT rolled back — inspect results[] to see what landed.
Optional: preflightAccess: true checks the API user's effective canCreate verdict on the table once before dispatching any wave.`,
	inputSchema: BatchCreateSchema,
	outputSchema: BatchOutputSchema,
};

export function createBatchCreateTool(
	batchService: BatchService,
	schemaService?: SchemaService,
	accessReader?: EffectiveAccessReader,
) {
	return {
		...BATCH_CREATE_TOOL,
		handler: async (params: unknown) => {
			let tableName: string | undefined;
			try {
				// Validate input
				const validated = BatchCreateSchema.parse(params);
				tableName = validated.tableName;

				logger.info(
					`Batch creating ${validated.records.length} records in ${validated.tableName}`,
					{
						instance: validated.instance || 'default',
						continueOnError: validated.continueOnError,
					},
				);

				// Pre-flight: a routed table would take 50 broken inserts just as happily
				// as one, so this check matters more here than on the single-record path.
				const routingError = await checkWriteRouting(
					validated.tableName,
					validated.acknowledgeRoutingRisk,
					schemaService,
					validated.instance,
				);
				if (routingError) {
					return {
						content: [{ type: 'text' as const, text: routingError }],
						isError: true as const,
					};
				}

				// Pre-flight: validate the union of field names across the whole batch.
				// A typo'd field would otherwise be silently dropped on up to 50 records.
				const message = await preflightFieldValidation(
					schemaService,
					validated.tableName,
					collectFieldNames(validated.records),
					{ skip: validated.skipFieldValidation, instance: validated.instance },
				);
				if (message) {
					return { content: [{ type: 'text' as const, text: message }], isError: true as const };
				}

				// Opt-in pre-flight, table-level: one verdict covers the whole batch, since
				// every record here is an insert into the same table.
				const accessDenial = await preflightEffectiveAccess(accessReader, {
					operation: 'create',
					tableName: validated.tableName,
					instance: validated.instance,
					enabled: validated.preflightAccess,
				});
				if (accessDenial) {
					return {
						content: [{ type: 'text' as const, text: accessDenial }],
						isError: true as const,
					};
				}

				// Perform batch create
				const result = await batchService.batchCreate(
					validated.tableName,
					validated.records,
					validated.continueOnError,
					validated.instance,
				);

				const response = {
					success: result.success,
					table: validated.tableName,
					instance: validated.instance || 'default',
					summary: {
						total: validated.records.length,
						successCount: result.successCount,
						failureCount: result.failureCount,
					},
					results: result.results,
				};

				return toolResult(
					response,
					`batch create ${validated.tableName}: ${result.successCount} ok, ${result.failureCount} failed`,
				);
			} catch (error) {
				logger.error('Error in batch create operation', error);
				return toolError(error, { table: tableName, operation: 'create' });
			}
		},
	};
}
