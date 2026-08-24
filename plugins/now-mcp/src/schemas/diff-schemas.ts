/**
 * Zod schemas for the diff-records tool (compare two records field-by-field).
 */

import { z } from 'zod';
import { instanceField, sysIdField, tableNameField } from './common.js';

/**
 * Schema for comparing two records on the same table.
 */
export const DiffRecordsSchema = z.object({
	tableName: tableNameField(),
	sysIdA: sysIdField('sysIdA'),
	sysIdB: sysIdField('sysIdB'),
	fields: z
		.array(z.string())
		.optional()
		.describe('Optional subset of fields to compare (defaults to all fields on both records)'),
	instance: instanceField,
});

export type DiffRecordsInput = z.infer<typeof DiffRecordsSchema>;

/**
 * Output schema for sn_diff_records.
 *
 * `diffs` maps each changed field name to the two differing values (a from
 * record A, b from record B). Values are open (`z.unknown()`) because a
 * ServiceNow field value may be a string or a reference object.
 */
export const DiffRecordsOutputSchema = z.object({
	success: z.boolean(),
	table: z.string(),
	fieldsCompared: z.number(),
	fieldsChanged: z.number(),
	diffs: z.record(
		z.object({
			a: z.unknown(),
			b: z.unknown(),
		}),
	),
	// True when a diffed value exceeded the per-value char cap and was shortened.
	valuesTruncated: z.boolean().optional(),
	hints: z.array(z.string()).optional(),
});
