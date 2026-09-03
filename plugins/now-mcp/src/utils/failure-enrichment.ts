/**
 * Failure enrichment (learned from ServiceNow Forge).
 *
 * Turns a bare ServiceNow error or an empty result into actionable next steps,
 * so the model can recover instead of guessing. Pure + synchronous: it
 * classifies from the error text and call context and emits hint lines — no
 * extra API calls.
 */

import { extractQueryFields } from './encoded-query.js';
import { type GroupabilityMeta, isGroupableField } from './groupability.js';

export interface FailureContext {
	table?: string;
	/** Free-form label of the operation for logging/future use (not branched on). */
	operation?: string;
	query?: string;
	/** ServiceNow roles required by this tool, surfaced in 403 hints. */
	requiredRoles?: string[];
	/** HTTP status code from the failed response, when known. Preferred over
	 * text matching in classifyFailure — ServiceNow's own error.message text
	 * (e.g. "User Not Authorized") does not reliably contain the status code
	 * or recognizable keywords. */
	statusCode?: number;
	/** Whether the target table's "Allow access to this table via web
	 * services" (sys_db_object.ws_access) flag was found to be off — a
	 * table-level block that rejects all REST Table API access before any
	 * role/ACL evaluation happens, independent of the caller's roles.
	 * 'unknown' when the probe wasn't run or couldn't determine an answer. */
	wsAccess?: 'disabled' | 'enabled' | 'unknown';
	/**
	 * Whether the target table's `sys_db_object.read_access` flag was found to be
	 * off. This is a DIFFERENT gate from ws_access and fails in a far more
	 * dangerous way: REST returns an honest 403, but a GlideRecord running in
	 * another application scope returns ZERO ROWS and reports success — no
	 * exception, `isValid()` true, `canRead()` true.
	 *
	 * It is tracked here so a 403 hint never recommends "just use a background
	 * script" on a table where that script would silently answer "empty" and be
	 * believed. 'unknown' when the probe wasn't run or couldn't determine it.
	 */
	readAccess?: 'disabled' | 'enabled' | 'unknown';
	/** Owning application scope (sys_db_object.sys_scope.scope), when resolved.
	 * Named in hints so the reader knows which scope a read must run in. */
	owningScope?: string;
	/**
	 * Dictionary type/length for the fields named in `query`, when the caller
	 * has the schema in hand. Used ONLY to decide whether a groupBy suggestion
	 * would help — omit it and that suggestion is simply withheld, never guessed.
	 */
	fieldMeta?: Record<string, GroupabilityMeta>;
}

export type FailureType =
	| 'circuit_open'
	| '401'
	| '403'
	| 'readonly'
	| '404'
	| '400'
	| 'field_error'
	| 'unknown';

export function classifyFailure(text: string, statusCode?: number): FailureType {
	const t = text.toLowerCase();
	if (t.includes('circuit_open') || t.includes('circuit open')) return 'circuit_open';
	if (
		t.includes('invalid field') ||
		t.includes('unknown field') ||
		t.includes('invalid column') ||
		t.includes('no such field')
	) {
		return 'field_error';
	}
	// A client-side read-only write block (thrown before any HTTP call). Its
	// message already carries source-aware remediation, so it needs no extra hint —
	// classify it distinctly from a genuine server ACL 403 to avoid appending
	// stale, contradictory YAML advice.
	if (t.includes('read-only') || t.includes('not permitted on read-only')) return 'readonly';

	// Prefer the structured HTTP status when available — ServiceNow's own
	// error.message text (e.g. "User Not Authorized") doesn't always contain a
	// recognizable keyword or the numeric code itself.
	if (statusCode === 401) return '401';
	if (statusCode === 403) return '403';
	if (statusCode === 404) return '404';
	if (statusCode === 400) return '400';

	if (t.includes('401') || t.includes('authentication') || t.includes('unauthorized')) return '401';
	if (
		t.includes('403') ||
		t.includes('access denied') ||
		t.includes('access_denied') ||
		t.includes('forbidden') ||
		t.includes('failed api level acl validation')
	)
		return '403';
	if (t.includes('404') || t.includes('not found') || t.includes('does not exist')) return '404';
	if (t.includes('400') || t.includes('bad request')) return '400';
	return 'unknown';
}

/**
 * Produce actionable hint lines for a failed call.
 */
export function failureHints(text: string, ctx: FailureContext = {}): string[] {
	const table = ctx.table ? `'${ctx.table}'` : 'the table';
	switch (classifyFailure(text, ctx.statusCode)) {
		case 'circuit_open':
			return [
				'This is a local instance-wide anti-lockout pause; no ServiceNow request was sent for this call. Run sn_connection_status for the reason and retryAfterMs.',
				'For read-only record verification, switch immediately to now-sdk query; it uses the CLI credential path independently of now-mcp.',
				'Fix the underlying credentials/connectivity first. Then use sn_reset_connection. YAML-backed credentials are reloaded by that tool; plugin-form/environment credential changes still require restarting/reconnecting now-mcp.',
			];
		case 'field_error':
			return [
				`A field name appears invalid. Run sn_get_table_schema for ${table} to confirm field names`,
				'For choice fields, sn_get_choice_list shows valid values.',
			];
		case '403': {
			if (ctx.wsAccess === 'disabled') {
				const scopeNote = ctx.owningScope ? ` (owning scope: ${ctx.owningScope})` : '';
				const hints = [
					`${table} has "Allow access to this table via web services" (sys_db_object.ws_access) turned off${scopeNote}. This blocks ALL REST/Table API access to the table before any role or ACL check runs — it is not a role problem, and admin does not override it.`,
					'This is often an intentional restriction on sensitive tables (e.g. GRC). Confirm with a table owner/admin before changing it — it is a security-posture setting, not a bug to route around silently.',
				];

				// The fallback advice depends ENTIRELY on read_access, because that
				// flag decides whether a background script answers honestly or
				// silently lies. Recommending a script without checking it is how a
				// 403 becomes a confident, wrong "the table is empty".
				if (ctx.readAccess === 'disabled') {
					hints.push(
						`${table} ALSO has sys_db_object.read_access off, so it is readable only from its own application scope${scopeNote}. A background script running in global scope will return ZERO ROWS and report success — no error, isValid() and canRead() both true. Do NOT treat an empty result from a global-scope script as evidence the table is empty.`,
						// Measured on a live instance: sys_trigger has NO sys_scope column,
						// so the background transport always runs in rhino.global and there
						// is no in-script escape — GlideRecordSecure, GlideAggregate, and
						// even get() on a known sys_id all come back empty. So this hint
						// must not offer a script-shaped workaround; there isn't one.
						'sn_execute_background_script CANNOT read this table: its transport always runs in global scope (sys_trigger has no scope field), and no GlideRecord variant escapes that. Read it from inside the owning scope instead — a UI session, or code deployed into that application. If you do run a script, print gs.getCurrentScopeName() and treat a zero-row result from global scope as proving nothing.',
					);
				} else if (ctx.readAccess === 'enabled') {
					hints.push(
						'read_access is on, so this table IS readable from another scope: sn_execute_background_script (GlideRecordSecure is not gated by ws_access) or now-sdk query will return real rows.',
					);
				} else {
					hints.push(
						'read_access for this table could not be determined, so the safe transport is unknown. If it is off, a global-scope background script returns zero rows silently rather than erroring — check sys_db_object.read_access before trusting an empty script result.',
					);
				}

				hints.push(
					'If the flag does need to change, that is a table-definition change and belongs in the Fluent SDK (now-sdk), not a direct sys_db_object write.',
				);
				return hints;
			}
			const roleNote = ctx.requiredRoles?.length
				? ` This tool requires the ${ctx.requiredRoles.join(' or ')} role.`
				: '';
			const aclNote =
				ctx.wsAccess === 'enabled'
					? ' Web-service access to the table is enabled, so this is a role/ACL/field restriction, not a table-level block.'
					: '';
			const hints = [
				`Access denied on ${table}. Likely an ACL — the account may lack the required role, or the field/record is restricted.${roleNote}${aclNote}`,
			];
			if (ctx.wsAccess === 'unknown') {
				// Without the flag we cannot tell a role/ACL denial from a table-wide
				// REST block, and the two have opposite remediations. Say so instead
				// of nominating a transport on no evidence.
				hints.push(
					`Table-level access metadata (sys_db_object.ws_access / read_access) could not be read for ${table}, so the safe transport cannot be determined from here: this may be a role/ACL denial OR a table-wide web-service block. Check those two flags before switching transports — in particular, if read_access is off, a global-scope background script returns zero rows silently instead of erroring.`,
				);
			}
			if (ctx.operation === 'update') {
				hints.push(
					'Use sn_diagnose_mutation to distinguish missing effective write ACL coverage from an existing ACL whose role, condition, script, or field rule denied the caller.',
					'If diagnostics find no effective table, field, inherited, or wildcard write ACL, secure record access defaults to deny. Add the intended ACL through the application definition/Fluent source control; do not bypass it with an unsecured script.',
				);
			} else if (ctx.operation === 'delete') {
				hints.push(
					'If deletion works in the UI, compare the authenticated API user with the UI user, including roles, domain/scope, ACL evaluation, and transaction-specific logic. Browser and API sessions are different execution paths; that alone does not prove an undocumented UI-only restriction.',
					'Use sn_diagnose_mutation for evidence before falling back to sn_execute_background_script.',
				);
			}
			return hints;
		}
		case 'readonly':
			// The read-only write-block message already includes source-aware
			// remediation (which config to edit + reload). No extra hint.
			return [];
		case '401':
			return [
				'Authentication failed at the API layer. Browser/UI login is a separate session and does not update now-mcp credentials.',
				'For read-only record verification, use now-sdk query while repairing now-mcp; it authenticates through the CLI own profile.',
				'Basic auth: fix the configured credentials, then use sn_reset_connection (YAML is reloaded in place; plugin-form/environment changes require a restart). OAuth: check client/grant/user settings; sn_reset_connection reloads YAML and clears the cached token.',
				'After the cause is fixed, use sn_reset_connection (or wait for the reported cooldown) before retrying.',
			];
		case '404':
			return [
				`Not found. Verify the table name with sn_list_tables, and that the sys_id/record exists.`,
			];
		case '400':
			return [
				`Bad request. Check the encoded query syntax${ctx.query ? ` ("${ctx.query}")` : ''} and field values.`,
			];
		default:
			return ctx.operation === 'delete'
				? [
						'For a failed delete, verify the record still exists, then use sn_diagnose_mutation. If the UI behaves differently, compare API/UI identity, roles, domain/scope, ACLs, and transaction-specific logic rather than assuming deletion is UI-only.',
					]
				: [];
	}
}

/**
 * Hints for a write whose per-record `results` contain failures.
 *
 * A multi-record write reports failures inside `results[]` instead of throwing,
 * so the recovery guidance a single-record failure gets (via `toolError`) would
 * otherwise be missing precisely when many records are involved. Derived from
 * the FIRST failure: fifty rows refused by one ACL have one cause, and repeating
 * the same hint per row would only cost context.
 */
export function resultsFailureHints(
	results: Array<{ success: boolean; error?: string } | undefined>,
	ctx: FailureContext = {},
): string[] {
	const first = results.find((r) => r && !r.success && r.error);
	return first?.error ? failureHints(first.error, ctx) : [];
}

/**
 * Hints for a successful-but-empty result set.
 */
export function zeroResultHints(ctx: FailureContext = {}): string[] {
	const hints = ['No records matched. The query may be too narrow, or the data may not exist.'];
	if (ctx.query) {
		hints.push(
			`Try broadening the query (current: "${ctx.query}") — remove a clause or use LIKE for partial matches.`,
		);
	}
	hints.push(
		'Confirm field values with sn_get_choice_list, or check the table with sn_get_table_schema.',
	);
	// Suggest groupBy only for a field whose values form a bounded set. The
	// first query field is NOT a safe default: on a free-text column
	// (user_message, 8000 chars) groupBy returns one group per row — the exact
	// call sn_aggregate_records blocks for sys_id. Without fieldMeta the type is
	// unknown, so the suggestion is withheld rather than guessed.
	const groupable = (ctx.query ? extractQueryFields(ctx.query) : []).find((f) =>
		isGroupableField(f, ctx.fieldMeta?.[f]),
	);
	if (groupable) {
		hints.push(
			`To see which values actually exist for ${groupable}, call sn_aggregate_records {groupBy:["${groupable}"],count:true} — one call, and it shows real values rather than configured choices.`,
		);
	}
	return hints;
}

/**
 * Render hint lines as a single text block (or null if none).
 */
export function renderHints(hints: string[]): string | null {
	if (hints.length === 0) return null;
	return `Hints:\n${hints.map((h) => `- ${h}`).join('\n')}`;
}
