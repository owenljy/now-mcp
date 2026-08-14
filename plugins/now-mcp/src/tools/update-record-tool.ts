/**
 * MCP tool for updating ServiceNow records
 */

import { UpdateRecordOutputSchema } from '../schemas/output-schemas.js';
import { UpdateRecordSchema } from '../schemas/table-schemas.js';
import type { SchemaService } from '../services/schema-service.js';
import type { TableService } from '../services/table-service.js';
import { type EffectiveAccessReader, preflightEffectiveAccess } from '../utils/access-preflight.js';
import { formatErrorForTool } from '../utils/error-handler.js';
import { failureHints, renderHints } from '../utils/failure-enrichment.js';
import { preflightFieldValidation } from '../utils/field-validation.js';
import { logger } from '../utils/logger.js';
import { toolResult } from '../utils/tool-response.js';

export const UPDATE_RECORD_TOOL = {
	name: 'sn_update_record',
	title: 'Update record',
	description: `What: Modify an existing record (PATCH partial or PUT full) by sys_id.
When to use: To change field values on a known record. For app metadata, use the Fluent SDK instead.
Preconditions: Write-enabled instance (readOnly: false); valid sys_id; field names valid for the table (validated automatically).
Produces: sys_id plus the fields you changed (not the whole row).
Optional: preflightAccess: true asks ServiceNow for the API user's effective canWrite verdict on THIS record and on each requested field first, and refuses locally if any is false.`,
	inputSchema: UpdateRecordSchema,
	outputSchema: UpdateRecordOutputSchema,
};

export function createUpdateRecordTool(
	tableService: TableService,
	schemaService?: SchemaService,
	accessReader?: EffectiveAccessReader,
) {
	return {
		...UPDATE_RECORD_TOOL,
		handler: async (params: unknown) => {
			try {
				// Validate input
				const validated = UpdateRecordSchema.parse(params);

				logger.info(`Updating record ${validated.sysId} in ${validated.tableName}`, {
					fields: Object.keys(validated.fields),
					updateType: validated.updateType,
				});

				// Pre-flight: catch typo'd field names that the Table API would silently drop.
				const message = await preflightFieldValidation(
					schemaService,
					validated.tableName,
					Object.keys(validated.fields),
					{ skip: validated.skipFieldValidation, instance: validated.instance },
				);
				if (message) {
					return { content: [{ type: 'text' as const, text: message }], isError: true as const };
				}

				// Opt-in pre-flight. Pinning the row by sys_id matters: field verdicts are
				// evaluated against a specific record, so an ACL condition that depends on
				// the row's own data is reflected rather than approximated.
				const accessDenial = await preflightEffectiveAccess(accessReader, {
					operation: 'update',
					tableName: validated.tableName,
					fields: Object.keys(validated.fields),
					recordQuery: `sys_id=${validated.sysId}`,
					instance: validated.instance,
					enabled: validated.preflightAccess,
				});
				if (accessDenial) {
					return {
						content: [{ type: 'text' as const, text: accessDenial }],
						isError: true as const,
					};
				}

				// Update record
				const record = await tableService.updateRecord(
					validated.tableName,
					validated.sysId,
					validated.fields,
					validated.updateType === 'full',
					validated.instance,
				);
				let verification: Record<string, unknown> = { performed: false };
				if (validated.verify) {
					const reread = await tableService.getRecord(
						validated.tableName,
						validated.sysId,
						['sys_id', 'sys_updated_on', 'sys_mod_count', ...Object.keys(validated.fields)],
						validated.instance,
					);
					const normalize = (v: unknown): unknown => {
						if (typeof v === 'object' && v !== null && 'value' in v)
							return (v as { value: unknown }).value;
						if (v === true) return 'true';
						if (v === false) return 'false';
						if (v === null || v === undefined) return '';
						return String(v);
					};
					const mismatches = Object.entries(validated.fields)
						.filter(([field, expected]) => normalize(reread[field]) !== normalize(expected))
						.map(([field, expected]) => ({ field, expected, actual: reread[field] }));
					verification = {
						performed: true,
						persisted: mismatches.length === 0,
						...(mismatches.length ? { mismatches } : {}),
					};
					if (mismatches.length > 0) {
						return {
							content: [
								{
									type: 'text' as const,
									text: `Update API returned, but read-after-write verification failed: ${JSON.stringify(mismatches)}`,
								},
							],
							structuredContent: {
								success: false,
								table: validated.tableName,
								sys_id: validated.sysId,
								updateType: validated.updateType,
								record: reread,
								failureType: 'mutation_not_persisted',
								likelyCauses: ['table_or_field_acl', 'business_rule_abort'],
								recommendedTool: 'sn_diagnose_mutation',
								verification,
							},
							isError: true as const,
						};
					}
				}

				// Lean echo: sys_id + the fields the caller changed, not the whole row.
				const changed: Record<string, unknown> = { sys_id: record.sys_id };
				for (const k of Object.keys(validated.fields)) {
					if (k in record) changed[k] = record[k];
				}
				const response = {
					success: true,
					table: validated.tableName,
					sys_id: typeof record.sys_id === 'string' ? record.sys_id : undefined,
					updateType: validated.updateType,
					record: changed,
					verification,
				};

				return toolResult(response, `updated ${validated.tableName} ${validated.sysId}`);
			} catch (error) {
				logger.error('Error updating record', error);

				const table = (params as { tableName?: string })?.tableName;
				const hints = renderHints(failureHints(String(error), { table, operation: 'update' }));
				return {
					content: [
						{ type: 'text' as const, text: formatErrorForTool(error) },
						...(hints ? [{ type: 'text' as const, text: hints }] : []),
					],
					isError: true as const,
				};
			}
		},
	};
}
