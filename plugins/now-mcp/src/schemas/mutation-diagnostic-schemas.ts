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
	identity: OpenRecord,
	recordExists: z.boolean(),
	capabilities: OpenRecord,
	fieldCapabilities: z.array(OpenRecord),
	activeBusinessRules: z.array(OpenRecord),
	applicableAcls: z.array(OpenRecord),
	aclCoverage: OpenRecord,
	probableBlocker: z.string().optional(),
	referenceDependencies: z.array(OpenRecord),
	limitations: z.array(z.string()),
});
