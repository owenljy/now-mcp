/**
 * Zod schemas for Table API validation
 */

import { z } from 'zod';
import { enforceBatchSize } from './batch-schemas.js';
import {
	acknowledgeRoutingRiskField,
	continueOnErrorField,
	instanceField,
	preflightAccessField,
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

/** A non-empty field-value map for one record. */
const fieldsMap = (label: string) =>
	z.record(z.unknown()).refine((data) => Object.keys(data).length > 0, {
		message: `${label} must have at least one field`,
	});

/**
 * Schema for creating one or many records.
 *
 * One schema (and one tool) covers both, for the reason spelled out on
 * DeleteRecordsSchema below. Create has a second reason the delete split did
 * not: facing a separate batch tool, a caller tends to loop the single-record
 * one, paying fifty round trips for work the batch endpoint does in two. An
 * array-shaped input makes batching the default rather than a decision.
 */
export const CreateRecordsSchema = z.object({
	instance: instanceField,
	tableName: tableNameField(),
	records: z
		.array(fieldsMap('Each record'))
		.min(1, 'At least one record is required')
		.superRefine(enforceBatchSize)
		.describe('Field-value pairs per record to create — one record or many.'),
	continueOnError: continueOnErrorField,
	skipFieldValidation: skipFieldValidationField.default(false),
	acknowledgeRoutingRisk: acknowledgeRoutingRiskField,
	preflightAccess: preflightAccessField,
});

export type CreateRecordsInput = z.infer<typeof CreateRecordsSchema>;

/**
 * Schema for updating one or many records by sys_id. See CreateRecordsSchema for
 * why cardinality is data here rather than a separate tool.
 */
export const UpdateRecordsSchema = z.object({
	instance: instanceField,
	tableName: tableNameField(),
	updates: z
		.array(z.object({ sysId: sysIdField(), fields: fieldsMap('Fields object') }))
		.min(1, 'At least one update is required')
		.superRefine(enforceBatchSize)
		.describe('sysId + the fields to set, per record — one record or many.'),
	updateType: updateTypeField,
	continueOnError: continueOnErrorField,
	skipFieldValidation: skipFieldValidationField.default(false),
	preflightAccess: preflightAccessField,
	verify: z
		.boolean()
		.optional()
		.default(true)
		.describe(
			'Read each record back and verify the requested values persisted (default true). Batched into one extra request, so the cost does not scale with the number of records.',
		),
});

export type UpdateRecordsInput = z.infer<typeof UpdateRecordsSchema>;

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
