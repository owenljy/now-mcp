/**
 * Zod schemas for batch operations validation
 */

import { z } from 'zod';
import { maxBatchSize } from '../config/batch-config.js';
import {
	acknowledgeRoutingRiskField,
	continueOnErrorField,
	instanceField,
	skipFieldValidationField,
	sysIdField,
	tableNameField,
	updateTypeField,
} from './common.js';

/**
 * Enforce the configured max-batch-size cap at parse time, reporting the actual
 * resolved limit (which an operator can raise via SERVICENOW_MAX_BATCH_SIZE)
 * rather than a hardcoded number. Applied via superRefine so the message stays
 * accurate even when the env override changes the cap.
 */
export function enforceBatchSize(items: unknown[], ctx: z.RefinementCtx): void {
	const cap = maxBatchSize();
	if (items.length > cap) {
		ctx.addIssue({
			code: z.ZodIssueCode.too_big,
			maximum: cap,
			type: 'array',
			inclusive: true,
			message: `Cannot process more than ${cap} records at once (set SERVICENOW_MAX_BATCH_SIZE to change this).`,
		});
	}
}

/**
 * Schema for batch creating multiple records
 */
export const BatchCreateSchema = z.object({
	instance: instanceField,
	tableName: tableNameField(),
	records: z
		.array(
			z.record(z.unknown()).refine((data) => Object.keys(data).length > 0, {
				message: 'Each record must have at least one field',
			}),
		)
		.min(1, 'At least one record is required')
		.superRefine(enforceBatchSize)
		.describe('Array of record objects to create'),
	continueOnError: continueOnErrorField,
	skipFieldValidation: skipFieldValidationField,
	acknowledgeRoutingRisk: acknowledgeRoutingRiskField,
});

export type BatchCreateInput = z.infer<typeof BatchCreateSchema>;

/**
 * Schema for batch updating multiple records
 */
export const BatchUpdateSchema = z.object({
	instance: instanceField,
	tableName: tableNameField(),
	updates: z
		.array(
			z.object({
				sysId: sysIdField(),
				fields: z.record(z.unknown()).refine((data) => Object.keys(data).length > 0, {
					message: 'Fields object must have at least one field',
				}),
			}),
		)
		.min(1, 'At least one update is required')
		.superRefine(enforceBatchSize)
		.describe('Array of update objects with sysId and fields'),
	updateType: updateTypeField,
	continueOnError: continueOnErrorField,
	skipFieldValidation: skipFieldValidationField,
});

export type BatchUpdateInput = z.infer<typeof BatchUpdateSchema>;

/**
 * Response type for batch operations
 */
export interface BatchOperationResult {
	success: boolean;
	successCount: number;
	failureCount: number;
	results: Array<{
		index: number;
		success: boolean;
		sysId?: string;
		record?: unknown;
		verified?: boolean;
		error?: string;
	}>;
}
