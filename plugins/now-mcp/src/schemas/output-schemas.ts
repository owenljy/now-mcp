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
 * Shared columnar shape: `columns` names each cell position, `rows` is an
 * array of arrays positionally aligned with `columns` — `rows[i][j]` is the
 * value of `columns[j]` for row `i`. Removes the cost of repeating every
 * field name once per row (43.5% of the payload on the case that motivated
 * this). `null` means the column was not returned for that row (e.g.
 * field-level ACL stripped it, or it's the fields-omitted union-of-keys case
 * and a later row introduced a key this row never had); `""` means the value
 * itself is an empty string — the two are never coerced into each other. A
 * cell may itself be an object/array (e.g. under `expand` or
 * `displayValue:"all"`).
 */
function columnarShape(itemNoun: string) {
	return {
		columns: z
			.array(z.string())
			.describe(
				'Column names, in order. Every array in `rows` has exactly this many entries, positionally aligned: rows[i][j] is the value of columns[j].',
			),
		rows: z
			.array(z.array(z.unknown()))
			.describe(
				`Each entry is one ${itemNoun}, as an array of cell values aligned 1:1 with \`columns\` (rows[i][j] corresponds to columns[j]). A cell is null when that column was not returned for this row (e.g. field-level ACL stripped it); it is "" when the value itself is an empty string. A cell may itself be an object/array under expand or displayValue:"all".`,
			),
	};
}

/**
 * sn_query_records
 *
 * `rows` is the array actually returned to the caller, which may be a
 * truncated view of what the query matched (render guardrail — see the tool).
 * When truncation kicks in, `truncated` is true and `truncationReason` /
 * `fetchedRows` describe the cut so the caller can narrow the query.
 */
export const QueryRecordsOutputSchema = z.object({
	success: z.boolean(),
	table: z.string(),
	// Rows returned in this page (after the render cap) — equals rows.length.
	count: z.number(),
	...columnarShape('matching record'),
	// Requested columns absent from every returned row — the previously-silent
	// field-level-ACL-strip case, now loud.
	columnsNotReturned: z.array(z.string()).optional(),
	// Render guardrail: true when `rows` was capped below the fetched result,
	// or when a field value within a returned row was truncated.
	truncated: z.boolean().optional(),
	// Which cap fired: row-count, byte-size, or a per-cell character cap.
	truncationReason: z.enum(['row_count', 'row_bytes', 'cell_chars']).optional(),
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
	// A single, ready-to-run steering string — never an array (R1: no room to
	// accumulate). Present only when the call was not already optimal.
	costHint: z.string().optional(),
	// Attached only when the costHint's rule computed one (≤3 columns, ≤12
	// distinct values each) — the hint text itself carries the mandatory
	// "this page only" disclaimer, so this is never read without that context.
	distributions: z.record(z.record(z.number())).optional(),
	// Conditions that make the returned rows misleading rather than wrong — e.g.
	// journal fields read without displayValue, or an `expand` that had to fall
	// back to dot-walking. Present only when something needs saying.
	warnings: z.array(z.string()).optional(),
	// Which transport served the read: 'table-api' or 'graphql' (set when expand
	// was used).
	transport: z.string().optional(),
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
	// Present when topGroups sliced the result — the true pre-slice group count.
	totalGroups: z.number().optional(),
});

/**
 * One envelope for every write tool — sn_create_records, sn_update_records,
 * sn_delete_records — so the caller reads the same shape whether it wrote one
 * record or fifty, and whichever transport served the call.
 *
 * `results` holds one entry per requested record: `index`, `success`, `sysId`,
 * and — on a single-record write — the lean `record` echo (sys_id plus the fields
 * the caller set). `verified` / `mismatches` appear when a read-after-write check
 * ran: a record the API reported success for but which did not persist is
 * reported as a FAILURE carrying the fields that disagreed, never as a success
 * with a flag on it.
 */
export const WriteRecordsOutputSchema = z.object({
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
	// Present when verification found a write that reported success but did not
	// persist — a silent-failure diagnosis, not a transport error.
	failureType: z.string().optional(),
	likelyCauses: z.array(z.string()).optional(),
	recommendedTool: z.string().optional(),
	warning: z.string().optional(),
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

/**
 * sn_get_table_schema
 *
 * `fields`' columns are fixed and always fully materialized — `mandatory`/
 * `readOnly` are explicit `false` rather than omitted-and-implied, because
 * columnar `null` already means something else (column not returned for this
 * row) and reusing it for "false" would make an absent flag look like an
 * unknown one, which is silently wrong about which fields are mandatory.
 */
export const GetTableSchemaOutputSchema = z.object({
	success: z.boolean(),
	table: z.string(),
	label: z.string().optional(),
	extends: z.preprocess(normalizeSNRef, z.string().optional()),
	fieldCount: z.number(),
	columns: z
		.array(z.string())
		.describe(
			"Fixed order: ['name','type','mandatory','readOnly','maxLength','reference']. mandatory/readOnly are always explicit booleans (never null); maxLength/reference are null when not applicable.",
		),
	rows: z.array(z.array(z.unknown())),
	// True when a very wide table's fields were capped at a row boundary.
	fieldsTruncated: z.boolean().optional(),
	instance: z.string(),
});

/** sn_list_tables */
export const ListTablesOutputSchema = z.object({
	success: z.boolean(),
	count: z.number(),
	filter: z.string().optional(),
	instance: z.string(),
	...columnarShape('table'),
	truncated: z.boolean().optional(),
	truncationReason: z.enum(['row_count', 'row_bytes']).optional(),
});

/** sn_get_choice_list */
export const GetChoiceListOutputSchema = z.object({
	success: z.boolean(),
	table: z.string(),
	field: z.string(),
	choiceCount: z.number(),
	instance: z.string(),
	...columnarShape('choice'),
	truncated: z.boolean().optional(),
	truncationReason: z.enum(['row_count', 'row_bytes']).optional(),
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
	truncationReason: z.enum(['mailbox_limit', 'render_cap']).optional(),
	queueDelayMs: z.number().optional(),
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
	// Slimmed to just the observed identity — identityNote/writeResultContract
	// were static prose, moved into the tool description. Omitted entirely when
	// the transport didn't report an identity.
	runtimeContext: z
		.object({
			observedIdentity: z.object({
				userName: z.string().optional(),
				userId: z.string().optional(),
				roles: z.string().optional(),
				isInteractive: z.boolean().optional(),
			}),
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
