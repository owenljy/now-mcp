/**
 * MCP tool for executing arbitrary background scripts in ServiceNow
 */

import { ExecuteScriptOutputSchema } from '../schemas/output-schemas.js';
import { ExecuteBackgroundScriptSchema } from '../schemas/script-schemas.js';
import type { SchemaService } from '../services/schema-service.js';
import type { ScriptService } from '../services/script-service.js';
import { toolError } from '../utils/error-handler.js';
import { logger } from '../utils/logger.js';
import {
	detectWriteOperations,
	extractReferencedTables,
	extractTableFieldRefs,
} from '../utils/script-analysis.js';
import { toolResult, toolText } from '../utils/tool-response.js';

/**
 * Output guardrail. The sys_trigger execution path incidentally caps output at
 * ~3900 chars (sys_properties.value column width), but the Scripted REST "fast
 * path" (config.scriptApiPath) returns whatever the instance sends back with NO
 * cap at all — a script that logs a row per record in a loop can produce output
 * far beyond the MCP host's own per-call token ceiling. Apply one explicit cap
 * here so both paths behave the same regardless of which one served the call.
 */
const MAX_OUTPUT_CHARS = 8000;

export const EXECUTE_BACKGROUND_SCRIPT_TOOL = {
	name: 'sn_execute_background_script',
	title: 'Execute background script',
	description: `What: Run server-side JavaScript in ServiceNow using the instance's configured execution transport: scriptApiPath when set, otherwise a temporary sys_trigger, then return logged output.
When to use: Only for logic the dedicated Table/Stats tools can't express. Prefer query_records / aggregate_records for plain reads and the create/update/delete record tools for ordinary CRUD; call sn_delete_records FIRST for known-record deletion rather than GlideRecord.deleteRecord() merely because this tool is more general.
Preconditions: A WRITE-ENABLED instance. For scriptApiPath, the configured Scripted REST resource must be installed, active, and executable by the integration user; without it, the integration user must be able to create/read/delete temporary sys_properties/sys_trigger records. Timeout default 60s, max 2m.

WARNING: executes arbitrary server-side code; all executions are logged. allowWrites is an MCP safety acknowledgement only — it grants no roles, bypasses no ACLs. Runtime identity/privileges come from the configured endpoint or scheduled-job context.

Write policy (writes INSIDE the script body): requires allowWrites:true; metadata/security/config writes additionally require allowMetadataWrites:true (prefer Fluent source control). Detection is heuristic; unresolved targets yield lowConfidenceWarning.

Runtime (ServiceNow Rhino, NOT Node): call log(...) for output (gs.log/info/print are rewritten to it; return values discarded). Prefer gs.info over gs.print in scoped contexts. Synchronous only — no import/require/setTimeout/Promise/await. Use GlideRecordSecure + canWrite() and setLimit(). Referenced table/field names are schema-checked; unknown ones return in "schemaCheck" (advisory only).

runtimeContext.observedIdentity, when present, does not imply ACL bypass. A null/false write result is not proof of persistence — verify by rereading. queueDelayMs (sys_trigger path) includes queue/poll/cleanup time. transportConfiguration is echoed once per instance per process, not every call.`,
	inputSchema: ExecuteBackgroundScriptSchema,
	outputSchema: ExecuteScriptOutputSchema,
};

export function createExecuteBackgroundScriptTool(
	scriptService: ScriptService,
	schemaService?: SchemaService,
) {
	// transportConfiguration is a per-instance constant for the life of this
	// process — echo it once per instance rather than on every call. A fresh
	// Set per createExecuteBackgroundScriptTool() call keeps tests isolated.
	const reportedTransportConfig = new Set<string>();
	return {
		...EXECUTE_BACKGROUND_SCRIPT_TOOL,
		handler: async (params: unknown) => {
			try {
				// Validate input
				const validated = ExecuteBackgroundScriptSchema.parse(params);

				logger.info('Executing background script', {
					scriptLength: validated.script.length,
					timeout: validated.timeout,
					instance: validated.instance || 'default',
				});

				// Write-operation gate: block unless allowWrites is explicitly set.
				const writeDetection = detectWriteOperations(validated.script);
				if (validated.allowMetadataWrites && !validated.allowWrites) {
					return {
						content: [
							{
								type: 'text' as const,
								text: toolText({
									blocked: true,
									reason: 'allowMetadataWrites requires allowWrites:true.',
								}),
							},
						],
						isError: true as const,
					};
				}
				if (writeDetection.hasWrites && !validated.allowWrites) {
					const calls = writeDetection.writeCalls.map((c) =>
						c.table ? `${c.method} on '${c.table}'` : c.method,
					);
					const blocked = {
						blocked: true,
						reason: 'Script contains write operations and allowWrites is not set.',
						detected: calls,
						...(writeDetection.metadataTables.length > 0
							? {
									metadataWarning: `Writes to metadata/config tables detected: ${writeDetection.metadataTables.join(', ')}. These belong in Fluent source control, not ad-hoc scripts.`,
								}
							: {}),
						...(writeDetection.lowConfidence
							? {
									lowConfidenceWarning: `${writeDetection.unresolvedWrites} write(s) target a GlideRecord whose table name could not be resolved (dynamic name, concatenation, or function return). The metadata-table check is incomplete for those — a write to a protected table may be unflagged. Review the script manually before approving.`,
								}
							: {}),
						hint: 'Set allowWrites: true to explicitly approve this script. Only do so after confirming the writes are intentional.',
					};
					return {
						content: [{ type: 'text' as const, text: toolText(blocked) }],
						isError: true as const,
					};
				}
				if (writeDetection.metadataTables.length > 0 && !validated.allowMetadataWrites) {
					const blocked = {
						blocked: true,
						reason:
							'Script writes to metadata/security/config tables and needs a second explicit approval.',
						metadataTables: writeDetection.metadataTables,
						hint: 'Prefer Fluent source control. If this exceptional live-instance mutation is intentional, set both allowWrites:true and allowMetadataWrites:true.',
					};
					return {
						content: [{ type: 'text' as const, text: toolText(blocked) }],
						isError: true as const,
					};
				}

				// Advisory pre-flight: validate any table/field names the script
				// references against the live schema. ADVISORY ONLY — heuristic static
				// analysis must never block a valid script, so we attach findings and
				// still execute. Grounds the model's NEXT script with real field names.
				// Visibility warnings ride alongside: both walk the same extracted table
				// refs and both are advisory, so they share one pre-flight step rather
				// than serializing two round-trip batches.
				const [schemaCheck, visibilityWarnings] = schemaService
					? await Promise.all([
							runSchemaPreflight(schemaService, validated.script, validated.instance),
							collectVisibilityWarnings(schemaService, validated.script, validated.instance),
						])
					: [undefined, undefined];

				// Execute background script
				const result = await scriptService.executeBackgroundScript(
					validated.script,
					validated.timeout,
					validated.instance,
					validated.mirrorOutputToSystemLog,
				);

				let output = result.output ?? null;
				// Two distinct causes, kept distinct: the transport itself may have
				// already truncated (sys_trigger's mailbox column width), or THIS
				// tool's own MAX_OUTPUT_CHARS slice may fire on top (mainly the
				// scripted-REST fast path, which has no transport cap at all). Bug #4
				// was conflating both under one `truncationReason: 'mailbox_limit'`.
				const transportTruncated = result.outputTruncated ?? false;
				let localTruncated = false;
				const outputOriginalChars =
					result.outputOriginalChars ?? (typeof output === 'string' ? output.length : 0);
				if (typeof output === 'string' && output.length > MAX_OUTPUT_CHARS) {
					localTruncated = true;
					output = `${output.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated ${
						output.length - MAX_OUTPUT_CHARS
					} chars — narrow the script's logging (fewer/shorter gs.info calls, or aggregate before logging)]`;
				}
				const outputTruncated = transportTruncated || localTruncated;
				const truncationReason = localTruncated
					? ('render_cap' as const)
					: transportTruncated
						? ('mailbox_limit' as const)
						: undefined;

				let applicationResult: unknown;
				let applicationSuccess: boolean | undefined;
				let resultContractError: string | undefined;
				if (validated.resultMode === 'json' && result.success) {
					try {
						const lastLine = String(result.output ?? '')
							.trim()
							.split(/\r?\n/)
							.filter(Boolean)
							.at(-1);
						if (!lastLine) throw new Error('script produced no output');
						applicationResult = JSON.parse(lastLine);
						if (applicationResult && typeof applicationResult === 'object') {
							const contract = applicationResult as { success?: unknown; ok?: unknown };
							if (typeof contract.success === 'boolean') applicationSuccess = contract.success;
							else if (typeof contract.ok === 'boolean') applicationSuccess = contract.ok;
						}
						if (applicationSuccess === undefined) {
							resultContractError =
								"JSON result must contain a boolean 'success' or 'ok' property.";
						}
					} catch (error) {
						resultContractError = `Could not parse the final output line as JSON: ${error instanceof Error ? error.message : String(error)}`;
					}
				}
				const overallSuccess =
					result.success && applicationSuccess !== false && !resultContractError;

				const instanceKey = validated.instance || 'default';
				const reportTransportConfig =
					result.outcome !== 'completed' || !reportedTransportConfig.has(instanceKey);
				if (reportTransportConfig) reportedTransportConfig.add(instanceKey);

				// Format response for LLM
				const response = {
					success: overallSuccess,
					// Only surfaced when it disagrees with `success` — e.g. the transport
					// completed fine but the script's own JSON result said success:false.
					...(result.success !== overallSuccess ? { transportSuccess: result.success } : {}),
					...(applicationSuccess !== undefined ? { applicationSuccess } : {}),
					...(applicationResult !== undefined ? { applicationResult } : {}),
					executionTime: result.executionTime,
					output,
					...(outputTruncated
						? {
								outputTruncated: true,
								outputOriginalChars,
								outputReturnedChars: typeof output === 'string' ? output.length : 0,
								truncationReason,
							}
						: {}),
					...(result.executionPath === 'sys_trigger' ? { queueDelayMs: result.executionTime } : {}),
					...(result.error ? { error: result.error } : {}),
					instance: instanceKey,
					...(reportTransportConfig
						? {
								transportConfiguration: scriptService.getExecutionTransportStatus(
									validated.instance,
								),
							}
						: {}),
					executionPath: result.executionPath,
					outcome: result.outcome,
					...(result.runtimeIdentity
						? { runtimeContext: { observedIdentity: result.runtimeIdentity } }
						: {}),
					...(schemaCheck ? { schemaCheck } : {}),
					...(visibilityWarnings ? { visibilityWarnings } : {}),
					...(writeDetection.hasWrites && validated.allowWrites
						? {
								writeApproved: {
									calls: writeDetection.writeCalls.map((c) =>
										c.table ? `${c.method} on '${c.table}'` : c.method,
									),
									...(writeDetection.metadataTables.length > 0
										? {
												metadataWarning: `Wrote to metadata/config tables: ${writeDetection.metadataTables.join(', ')}. Consider moving this to Fluent source control.`,
											}
										: {}),
									...(writeDetection.lowConfidence
										? {
												lowConfidenceWarning: `${writeDetection.unresolvedWrites} approved write(s) target a GlideRecord whose table name could not be resolved statically — the metadata-table check could not cover them. Verify none wrote to a protected metadata/config table.`,
											}
										: {}),
									metadataWritesApproved:
										writeDetection.metadataTables.length > 0 && validated.allowMetadataWrites,
								},
							}
						: {}),
					warning:
						resultContractError ??
						(result.success
							? applicationSuccess === false
								? 'Script transport completed, but the declared application result was false.'
								: undefined
							: 'Script execution failed. Check error details above.'),
				};

				// A visibility warning is MOST dangerous on a successful run: that is
				// precisely when a silent zero reads as a real answer. Name it in the
				// summary so it isn't skipped over on the happy path.
				const visibilityNote = visibilityWarnings
					? ` — WARNING: scope-restricted table(s) ${visibilityWarnings
							.map((w) => w.table)
							.join(', ')}; an empty result is NOT conclusive (see visibilityWarnings)`
					: '';

				const formatted = toolResult(
					response,
					overallSuccess
						? `script ran — see output${visibilityNote}`
						: `script completed with failure — see outcome${visibilityNote}`,
				);
				return overallSuccess ? formatted : { ...formatted, isError: true as const };
			} catch (error) {
				logger.error('Error executing background script', error);
				return toolError(error, {
					operation: 'execute background script',
				});
			}
		},
	};
}

interface SchemaPreflightFinding {
	table: string;
	unknownFields?: { field: string; suggestion?: string }[];
	note?: string;
}

interface VisibilityWarning {
	table: string;
	reason: string;
	executionScope?: string;
	emptyResultIsConclusive: boolean;
	recommendedTransport?: string;
}

/**
 * Flag tables this script reads that its execution scope may not fully see.
 *
 * `sys_db_object.read_access=false` restricts a table to its OWNING application
 * scope. A GlideRecord for it from any other scope does not throw and does not
 * 403 — it simply iterates zero rows while `isValid()` and `canRead()` both
 * return true. So the script succeeds, reports "0 records", and the reader
 * concludes the table is empty. That is not a hypothetical: it produced a wrong
 * root-cause diagnosis and a recommendation that had to be retracted.
 *
 * This warns rather than blocks, per the plan: a background script can contain
 * perfectly valid cross-scope logic that static analysis cannot understand, and
 * the table refs themselves are only best-effort literals.
 *
 * The execution scope is deliberately NOT asserted here. This transport runs in
 * a scheduled-job context whose scope this code cannot prove from the outside,
 * so the warning states the risk and marks the result inconclusive instead of
 * claiming to know which scope ran.
 */
async function collectVisibilityWarnings(
	schemaService: SchemaService,
	script: string,
	instance?: string,
): Promise<VisibilityWarning[] | undefined> {
	try {
		// extractReferencedTables, not extractTableFieldRefs: a table that names no
		// column is dropped by the field-keyed extractor, and the script that
		// triggered this whole feature — `gr.query(); gr.getRowCount()` — is
		// exactly that shape.
		const tables = extractReferencedTables(script);
		if (tables.length === 0) return undefined;

		const warnings: VisibilityWarning[] = [];
		for (const table of tables) {
			const profile = await schemaService.getTableAccessProfile(table, instance);
			// Unknown/unreadable profile: stay silent. A warning on every table whose
			// metadata we merely failed to read would be noise, and the schema
			// preflight already reports unresolvable tables.
			if (!profile?.exists || profile.readAccess !== false) continue;

			const scope = profile.owningScope?.name;
			warnings.push({
				table,
				reason:
					`sys_db_object.read_access is off for ${table}, so it is readable only from its owning ` +
					`application scope${scope ? ` (${scope})` : ''}. A script running in any other scope reads ` +
					`ZERO rows and still reports success — no exception, isValid() and canRead() both true.`,
				emptyResultIsConclusive: false,
				recommendedTransport:
					profile.wsAccess === true
						? 'table-api'
						: 'owning-scope execution (verify with gs.getCurrentScopeName()) or now-sdk query',
			});
		}
		return warnings.length > 0 ? warnings : undefined;
	} catch (error) {
		// Advisory infrastructure: never let it interfere with execution.
		logger.debug('Script visibility pre-flight skipped', {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

/**
 * Validate the table/field names a script references against the live schema.
 * ADVISORY — returns findings to attach to the result; never throws or blocks.
 */
async function runSchemaPreflight(
	schemaService: SchemaService,
	script: string,
	instance?: string,
): Promise<SchemaPreflightFinding[] | undefined> {
	try {
		const refs = extractTableFieldRefs(script);
		if (refs.length === 0) return undefined;

		const findings: SchemaPreflightFinding[] = [];
		for (const { table, fields } of refs) {
			const result = await schemaService.validateFields(table, fields, instance);
			if (result === null) {
				// Couldn't resolve the table's schema — typo'd table name or no read
				// access. A close real-table suggestion disambiguates the two.
				const suggestion = await schemaService.suggestTableName(table, instance);
				findings.push({
					table,
					note: suggestion
						? `Table '${table}' not resolved — did you mean '${suggestion}'? (or no read access)`
						: 'Schema not resolved (unknown table or no read access) — field names not checked.',
				});
			} else if (result.unknown.length > 0) {
				findings.push({ table, unknownFields: result.unknown });
			}
		}
		return findings.length > 0 ? findings : undefined;
	} catch (error) {
		// Pre-flight is best-effort; never let it interfere with execution.
		logger.debug('Script schema pre-flight skipped', {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}
