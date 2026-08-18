import { z } from 'zod';
import { instanceField, sysIdField } from './common.js';

export const GetRuntimeEventsSchema = z
	.object({
		instance: instanceField,
		since: z.string().datetime({ offset: true }).optional().describe('ISO-8601 lower time bound.'),
		lookbackMinutes: z.number().int().min(1).max(120).optional(),
		include: z
			.array(z.enum(['logs', 'triggers', 'events']))
			.min(1)
			.default(['logs', 'triggers']),
		sources: z.array(z.string().min(1)).max(10).optional(),
		levels: z.array(z.string().min(1)).max(10).optional(),
		messageContains: z.array(z.string().min(1)).max(10).optional(),
		triggerNameContains: z.string().min(1).optional(),
		recordSysId: sysIdField('record sys_id').optional(),
		operationId: z.string().min(1).optional(),
		limitPerSource: z.number().int().min(1).max(50).default(20),
	})
	.refine((v) => Number(v.since !== undefined) + Number(v.lookbackMinutes !== undefined) === 1, {
		message: 'Provide exactly one of since or lookbackMinutes.',
		path: ['since'],
	});

export const GetRuntimeEventsOutputSchema = z.object({
	success: z.boolean(),
	since: z.string(),
	groups: z.record(
		z.object({
			columns: z.array(z.string()),
			rows: z.array(z.array(z.unknown())),
		}),
	),
	diagnostics: z.record(z.object({ rows: z.number(), queries: z.number() })),
});
