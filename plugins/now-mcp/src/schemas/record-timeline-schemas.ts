import { z } from 'zod';
import { instanceField, sysIdField, tableNameField } from './common.js';
import { OpenRecord } from './output-schemas.js';

export const GetRecordTimelineSchema = z
	.object({
		instance: instanceField,
		tableName: tableNameField(),
		recordSysId: sysIdField('record sys_id'),
		since: z.string().datetime({ offset: true }).optional().describe('ISO-8601 lower time bound.'),
		lookbackMinutes: z.number().int().min(1).max(10_080).optional(),
		include: z
			.array(z.enum(['audit', 'journal', 'flow', 'runtime']))
			.min(1)
			.default(['audit', 'journal', 'flow', 'runtime']),
		runtimeKinds: z
			.array(z.enum(['logs', 'events']))
			.min(1)
			.default(['logs', 'events'])
			.describe('Runtime evidence to correlate when include contains runtime.'),
		limit: z.number().int().min(1).max(200).default(100),
		order: z.enum(['oldest_first', 'newest_first']).default('oldest_first'),
	})
	.refine((v) => Number(v.since !== undefined) + Number(v.lookbackMinutes !== undefined) === 1, {
		message: 'Provide exactly one of since or lookbackMinutes.',
		path: ['since'],
	});

const TimelineSourceDiagnosticSchema = z.object({
	status: z.enum(['ok', 'unavailable']),
	rows: z.number(),
	queries: z.number(),
	error: z.string().optional(),
});

export const GetRecordTimelineOutputSchema = z.object({
	success: z.boolean(),
	table: z.string(),
	recordSysId: z.string(),
	since: z.string(),
	record: OpenRecord,
	columns: z
		.array(z.string())
		.describe(
			"Fixed order: ['timestamp','kind','source','actor','field','oldValue','newValue','message','sysId','confidence'].",
		),
	rows: z.array(z.array(z.unknown())),
	totalEvents: z.number(),
	truncated: z.boolean().optional(),
	truncationReason: z.enum(['row_count', 'row_bytes']).optional(),
	diagnostics: z.record(TimelineSourceDiagnosticSchema),
	warnings: z.array(z.string()).optional(),
});

export type GetRecordTimelineInput = z.infer<typeof GetRecordTimelineSchema>;
