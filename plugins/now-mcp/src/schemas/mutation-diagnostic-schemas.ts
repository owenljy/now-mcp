import { z } from 'zod';
import { instanceField, sysIdField, tableNameField } from './common.js';
import { OpenRecord } from './output-schemas.js';

export const DiagnoseMutationSchema = z.object({
	tableName: tableNameField(),
	sysId: sysIdField(),
	operation: z.enum(['update', 'delete']),
	fields: z
		.array(z.string().regex(/^[a-zA-Z0-9_]+$/))
		.max(50)
		.optional()
		.default([]),
	instance: instanceField,
});

export const DiagnoseMutationOutputSchema = z.object({
	success: z.boolean(),
	table: z.string(),
	sysId: z.string(),
	operation: z.string(),
	/**
	 * Who the diagnostic ran as. Every verdict below is this user's, and the
	 * background-script identity is usually more privileged than the REST user the
	 * write tools authenticate as.
	 */
	identity: OpenRecord.optional(),
	recordExists: z.boolean().optional(),
	capabilities: OpenRecord.optional(),
	fieldCapabilities: z.array(OpenRecord).optional(),
	activeBusinessRules: z.array(OpenRecord).optional(),
	applicableAcls: z.array(OpenRecord).optional(),
	aclCoverage: OpenRecord.optional(),
	probableBlocker: z.string().optional(),
	referenceDependencies: z.array(OpenRecord).optional(),
	// Present when the instance-side output was truncated or unparseable before
	// this tool could read it — a partial diagnosis, not a raised truncation cap.
	diagnosisDegraded: z.boolean().optional(),
	degradedReason: z.string().optional(),
});
