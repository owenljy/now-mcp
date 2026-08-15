/**
 * Batch-size enforcement and the batch result type.
 *
 * The batch INPUT schemas used to live here, back when "many records" was a
 * separate tool from "one record". They are now the ordinary write schemas in
 * table-schemas.ts (cardinality is data, not a different operation), so what
 * remains is the shared cap check they all apply and the result shape
 * BatchService produces.
 */

import { z } from 'zod';
import { maxBatchSize } from '../config/batch-config.js';
import type { FieldMismatch } from '../utils/write-verification.js';

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
 * Response type for batch operations.
 *
 * `verified` / `mismatches` are stamped by the read-after-write checks: a record
 * the API reported success for but which did not persist is flipped to
 * `success: false` and carries the fields that disagreed.
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
		mismatches?: FieldMismatch[];
		error?: string;
	}>;
}
