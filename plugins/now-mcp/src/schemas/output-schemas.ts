/**
 * Output schemas for MCP tools (structured output).
 *
 * Each tool advertises an `outputSchema` and returns `structuredContent` that
 * conforms to it. Per the design (D2), records are modeled OPEN
 * (`z.record(z.unknown())`) and envelopes are NOT `.strict()` — extra keys must
 * pass (Zod object default strips unknown keys, it does not fail). The
 * top-level value is always a JSON object.
 *
 * These schemas are intentionally permissive: they describe the *shape* the
 * agent can rely on, not an exhaustive contract. Align each to what the
 * matching handler actually returns.
 */

import { z } from 'zod';

/** An arbitrary ServiceNow record / nested object: open by design. */
export const OpenRecord = z.record(z.unknown());

/**
 * sn_query_records
 *
 * `records` is the array actually returned to the caller, which may be a
 * truncated view of what the query matched (render guardrail — see the tool).
 * When truncation kicks in, `truncated` is true and `returnedRows` /
 * `fetchedRows` describe the cut so the caller can narrow the query.
 */
export const QueryRecordsOutputSchema = z.object({
	success: z.boolean(),
	table: z.string(),
	// Rows returned in this page (after the render cap).
	count: z.number(),
	records: z.array(OpenRecord),
	// Render guardrail: true when `records` was capped below the fetched result,
	// or when a field value within a returned row was truncated.
	truncated: z.boolean().optional(),
	// Rows actually included in `records` after the render cap.
	returnedRows: z.number().optional(),
	// Rows fetched in this page before the render cap was applied.
	fetchedRows: z.number().optional(),
	// True when one or more field values were shortened (row count untouched).
	fieldsTruncated: z.boolean().optional(),
	pagination: z.object({
		limit: z.number(),
		offset: z.number(),
		hasMore: z.boolean(),
		// Total rows matching the query across all pages (from X-Total-Count);
		// omitted when the instance did not return the header.
		totalMatching: z.number().optional(),
	}),
	hints: z.unknown().optional(),
});

/** sn_aggregate_records */
export const AggregateRecordsOutputSchema = z.object({
	success: z.boolean(),
	table: z.string(),
	grouped: z.boolean(),
	result: z.unknown(),
	// Render guardrail: true when a grouped `result` array was capped (high-cardinality groupBy).
	truncated: z.boolean().optional(),
	returnedGroups: z.number().optional(),
	fetchedGroups: z.number().optional(),
});

/** sn_create_record — lean echo: sys_id + the fields the caller set. */
export const CreateRecordOutputSchema = z.object({
	success: z.boolean(),
	table: z.string(),
	sys_id: z.string().optional(),
	record: OpenRecord,
});

/** sn_update_record — lean echo: sys_id + the fields the caller changed. */
export const UpdateRecordOutputSchema = z.object({
	success: z.boolean(),
	table: z.string(),
	sys_id: z.string().optional(),
	updateType: z.string().optional(),
	record: OpenRecord,
	failureType: z.string().optional(),
	likelyCauses: z.array(z.string()).optional(),
	recommendedTool: z.string().optional(),
	verification: z
		.object({
			performed: z.boolean(),
			persisted: z.boolean().optional(),
			mismatches: z.array(OpenRecord).optional(),
		})
		.optional(),
});

/** sn_delete_record */
export const DeleteRecordOutputSchema = z.object({
	success: z.boolean(),
	message: z.string().optional(),
	tableName: z.string(),
	sysId: z.string(),
	instance: z.string(),
	warning: z.string().optional(),
	verification: z.object({ performed: z.boolean(), deleted: z.boolean().optional() }).optional(),
});

/** Shared batch result envelope (create + update). */
export const BatchOutputSchema = z.object({
	success: z.boolean(),
	table: z.string(),
	instance: z.string(),
	updateType: z.string().optional(),
	summary: z.object({
		total: z.number(),
		successCount: z.number(),
		failureCount: z.number(),
	}),
	results: z.array(OpenRecord),
});

// ServiceNow reference fields can arrive as a plain string or as a
// {value, display_value, link} object depending on instance/version.
function normalizeSNRef(val: unknown): string | undefined {
	if (!val) return undefined;
	if (typeof val === 'string') return val || undefined;
	if (typeof val === 'object' && val !== null) {
		const o = val as { display_value?: unknown; value?: unknown };
		const s = o.display_value || o.value;
		return typeof s === 'string' ? s || undefined : undefined;
	}
	return undefined;
}

/** sn_get_table_schema */
export const GetTableSchemaOutputSchema = z.object({
	success: z.boolean(),
	table: z.string(),
	label: z.string().optional(),
	extends: z.preprocess(normalizeSNRef, z.string().optional()),
	fieldCount: z.number(),
	fields: z.array(OpenRecord),
	// True when a very wide table's fields were capped at a field boundary.
	fieldsTruncated: z.boolean().optional(),
	instance: z.string(),
	instanceUrl: z.string().url(),
});

/** sn_list_tables */
export const ListTablesOutputSchema = z.object({
	success: z.boolean(),
	count: z.number(),
	filter: z.string().optional(),
	instance: z.string(),
	instanceUrl: z.string().url(),
	tables: z.array(OpenRecord),
});

/** sn_get_choice_list */
export const GetChoiceListOutputSchema = z.object({
	success: z.boolean(),
	table: z.string(),
	field: z.string(),
	choiceCount: z.number(),
	choices: z.array(OpenRecord),
	instance: z.string(),
	instanceUrl: z.string().url(),
});

/** sn_execute_background_script */
export const ExecuteScriptOutputSchema = z.object({
	success: z.boolean(),
	transportSuccess: z.boolean().optional(),
	applicationSuccess: z.boolean().optional(),
	applicationResult: z.unknown().optional(),
	executionTime: z.number().optional(),
	output: z.string().nullable().optional(),
	// True when `output` was shortened to stay under the MCP host's per-call size ceiling.
	outputTruncated: z.boolean().optional(),
	outputOriginalChars: z.number().optional(),
	outputReturnedChars: z.number().optional(),
	truncationReason: z.literal('mailbox_limit').optional(),
	queueDelayMs: z.number().optional(),
	timingNote: z.string().optional(),
	error: z.string().nullable().optional(),
	instance: z.string(),
	transportConfiguration: z
		.object({
			transport: z.enum(['scripted_rest', 'sys_trigger']),
			configuredPath: z.string().nullable(),
			usesCompanionEndpoint: z.boolean(),
			fallbackOnFailure: z.literal(false),
			privilegeModel: z.enum(['configured_endpoint_context', 'scheduled_job_context']),
			diagnostic: z.string(),
		})
		.optional(),
	executionPath: z.enum(['scripted-rest', 'sys_trigger']).optional(),
	outcome: z.enum(['completed', 'script_failed', 'timed_out']).optional(),
	runtimeContext: z
		.object({
			serverRuntime: z.literal('ServiceNow Rhino'),
			transport: z.string(),
			observedIdentity: z
				.object({
					userName: z.string().optional(),
					userId: z.string().optional(),
					roles: z.string().optional(),
					isInteractive: z.boolean().optional(),
				})
				.optional(),
			identityNote: z.string(),
			writeResultContract: z.string(),
		})
		.optional(),
	schemaCheck: z.array(OpenRecord).optional(),
	// Present when allowWrites:true and writes were detected — echoes the approved
	// write calls (and a warning if any hit metadata/config tables).
	writeApproved: z
		.object({
			calls: z.array(z.string()),
			metadataWarning: z.string().optional(),
			lowConfidenceWarning: z.string().optional(),
			metadataWritesApproved: z.boolean().optional(),
		})
		.optional(),
	warning: z.string().optional(),
});

/** sn_upload_attachment */
export const UploadAttachmentOutputSchema = z.object({
	success: z.boolean(),
	message: z.string(),
	bytesRead: z.number().optional(),
	verification: z.enum(['verified', 'not_requested', 'not_supported']).optional(),
	attachment: OpenRecord,
});

/** sn_download_attachment */
export const DownloadAttachmentOutputSchema = z.object({
	success: z.boolean(),
	message: z.string(),
	attachment: OpenRecord,
});

/** sn_sdk_status */
export const SdkStatusOutputSchema = z.object({
	success: z.boolean(),
	nowSdkVersion: z.string().nullable().optional(),
	// Version parsed to its components (null when now-sdk is absent/unparseable).
	nowSdkSemver: z
		.object({ major: z.number(), minor: z.number(), patch: z.number() })
		.nullable()
		.optional(),
	// Capability → available? resolved against the detected version, so callers
	// stop assuming now-sdk can do something the installed CLI can't.
	features: z.record(z.boolean()).optional(),
	// Constraint each feature flag was resolved from (e.g. query: ">=4.8.0").
	featureConstraints: z.record(z.string()).optional(),
	// False when the detected version is one whose `auth --list` text format the
	// parser has NOT been verified against (newer major / unknown version).
	authListFormatVerified: z.boolean().optional(),
	profiles: z.array(OpenRecord),
	alignment: z.array(OpenRecord),
	nowSdkDefaultProfile: z.string().nullable().optional(),
	nowSdkDefaultHost: z.string().nullable().optional(),
	mcpDefaultInstance: z.string().nullable().optional(),
	defaultAligned: z.boolean(),
	recommendedDefaultInstance: z.string().nullable().optional(),
	defaultNote: z.string(),
	note: z.string(),
});
