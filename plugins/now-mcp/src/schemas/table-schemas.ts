/**
 * Zod schemas for Table API validation
 */

import { z } from 'zod';
import { enforceBatchSize } from './batch-schemas.js';
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
 * Schema for querying records from a ServiceNow table
 */
export const QueryRecordsSchema = z.object({
	instance: instanceField,
	tableName: tableNameField(),
	query: z.string().optional().describe('Encoded query string (e.g., "priority=1^state=2")'),
	queryPolicy: z
		.enum(['safe', 'allow_expensive'])
		.optional()
		.default('safe')
		.describe(
			"Default 'safe' rejects predictably expensive unbounded text scans on high-volume tables. Use allow_expensive only after reviewing scan cost.",
		),
	limit: z
		.number()
		.int()
		.positive()
		// Request cap only. The rows actually returned are additionally capped by a
		// render guardrail in the query-records tool (row-count + serialized-size),
		// which truncates and signals `truncated` when a result would flood context.
		.max(10000, 'Limit cannot exceed 10000')
		.default(100)
		.describe('Maximum number of records to return (large results are truncated in the response)'),
	offset: z
		.number()
		.int()
		.nonnegative()
		.default(0)
		.describe('Number of records to skip for pagination'),
	fields: z
		.array(z.string())
		.optional()
		.describe(
			'Specific fields to retrieve. Strongly prefer listing the fields you need — omitting this returns EVERY column, which on wide tables (e.g. incident) floods context and triggers result truncation.',
		),
	displayValue: z
		.union([z.boolean(), z.literal('all')])
		.optional()
		.default(false)
		.describe('Return display values instead of actual values'),
	excludeReferenceLink: z
		.boolean()
		.optional()
		.default(true)
		.describe(
			'Strip the API URL metadata from reference fields (default true). Keep true unless you specifically need the raw reference links — it removes noise and shrinks the result.',
		),
	expand: z
		.record(z.array(z.string()).min(1))
		.optional()
		.describe(
			'Fetch fields from referenced records in the SAME request, e.g. {"caller_id":["name","email"]}. One level deep. Routed via GraphQL; falls back to dot-walked fields if unavailable.',
		),
	skipFieldValidation: skipFieldValidationField.default(false),
});

export type QueryRecordsInput = z.infer<typeof QueryRecordsSchema>;

/**
 * Schema for aggregating records via the Stats API
 */
export const AggregateRecordsSchema = z.object({
	instance: instanceField,
	tableName: tableNameField(),
	query: z
		.string()
		.optional()
		.describe('Encoded query to filter rows before aggregating (e.g. "active=true^priority=1")'),
	count: z.boolean().optional().default(true).describe('Include a row count (default true)'),
	groupBy: z
		.array(z.string())
		.optional()
		.describe(
			'Fields to group by. Supports dot-walking, e.g. "assignment_group" or "caller_id.department"',
		),
	avgFields: z.array(z.string()).optional().describe('Numeric fields to average'),
	sumFields: z.array(z.string()).optional().describe('Numeric fields to sum'),
	minFields: z.array(z.string()).optional().describe('Fields to take the minimum of'),
	maxFields: z.array(z.string()).optional().describe('Fields to take the maximum of'),
	having: z.string().optional().describe('Post-aggregation filter on an aggregate, e.g. "count>5"'),
	orderBy: z
		.string()
		.optional()
		.describe('Order groups by an aggregate (e.g. "count" or "DESCcount")'),
	displayValue: z
		.union([z.boolean(), z.literal('all')])
		.optional()
		.default(false)
		.describe(
			'Return display values (names) for group-by reference fields — set true when grouping by a reference field to avoid a second sys_id→name lookup.',
		),
	skipFieldValidation: skipFieldValidationField.default(false),
});

export type AggregateRecordsInput = z.infer<typeof AggregateRecordsSchema>;

/**
 * Schema for getting a single record by sys_id
 */
export const GetRecordSchema = z.object({
	instance: instanceField,
	tableName: tableNameField(),
	sysId: sysIdField(),
	fields: z
		.array(z.string())
		.optional()
		.describe('Specific fields to retrieve (leave empty for all fields)'),
});

export type GetRecordInput = z.infer<typeof GetRecordSchema>;

/**
 * Schema for creating a new record
 */
export const CreateRecordSchema = z.object({
	instance: instanceField,
	tableName: tableNameField(),
	fields: z
		.record(z.unknown())
		.refine((data) => Object.keys(data).length > 0, {
			message: 'At least one field must be provided',
		})
		.describe('Field-value pairs for the new record'),
	skipFieldValidation: skipFieldValidationField.default(false),
	acknowledgeRoutingRisk: acknowledgeRoutingRiskField,
});

export type CreateRecordInput = z.infer<typeof CreateRecordSchema>;

/**
 * Schema for updating an existing record
 */
export const UpdateRecordSchema = z.object({
	instance: instanceField,
	tableName: tableNameField(),
	sysId: sysIdField(),
	fields: z
		.record(z.unknown())
		.refine((data) => Object.keys(data).length > 0, {
			message: 'At least one field must be provided',
		})
		.describe('Field-value pairs to update'),
	updateType: updateTypeField,
	skipFieldValidation: skipFieldValidationField.default(false),
	verify: z
		.boolean()
		.optional()
		.default(true)
		.describe('Read the record back and verify requested values persisted (default true).'),
});

export type UpdateRecordInput = z.infer<typeof UpdateRecordSchema>;

/**
 * Schema for deleting one or many records.
 *
 * One schema (and one tool) covers both: the single-record case is just an
 * array of length 1. Splitting them forced the caller to pick a tool based on
 * cardinality — a decision that carries no meaning, since the underlying Table
 * API call is identical either way.
 */
export const DeleteRecordsSchema = z.object({
	instance: instanceField,
	tableName: tableNameField(),
	sysIds: z
		.array(sysIdField())
		.min(1, 'At least one sys_id is required')
		.superRefine(enforceBatchSize)
		.describe('sys_id(s) to delete — one or many.'),
	verify: z
		.boolean()
		.optional()
		.default(true)
		.describe(
			'Read each record back after deleting to confirm it is gone (default true). Batched into one extra request, so the cost does not scale with the number of records.',
		),
	continueOnError: continueOnErrorField,
});

export type DeleteRecordsInput = z.infer<typeof DeleteRecordsSchema>;
