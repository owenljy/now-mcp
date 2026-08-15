/**
 * Failure enrichment (learned from ServiceNow Forge).
 *
 * Turns a bare ServiceNow error or an empty result into actionable next steps,
 * so the model can recover instead of guessing. Pure + synchronous: it
 * classifies from the error text and call context and emits hint lines — no
 * extra API calls.
 */

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
				'Fix the underlying credentials/connectivity first. Then use sn_reset_connection. Basic-auth credential changes require restarting/reconnecting now-mcp because browser login does not update MCP credentials.',
			];
		case 'field_error':
			return [
				`A field name appears invalid. Run sn_get_table_schema for ${table} to confirm field names`,
				'For choice fields, sn_get_choice_list shows valid values.',
			];
		case '403': {
			if (ctx.wsAccess === 'disabled') {
				return [
					`${table} has "Allow access to this table via web services" (sys_db_object.ws_access) turned off. This blocks ALL REST/Table API access to the table before any role or ACL check runs — it is not a role problem, and admin does not override it.`,
					'This is often an intentional restriction on sensitive tables (e.g. GRC). Confirm with a table owner/admin before changing it — it is a security-posture setting, not a bug to route around silently.',
					'To read this data without changing the setting: sn_execute_background_script (GlideRecordSecure is not gated by ws_access) or now-sdk query (authenticates via a UI session, which ServiceNow does not treat as a web-service call).',
					'If it does need to change, that is a table-definition change and belongs in the Fluent SDK (now-sdk), not a direct sys_db_object write.',
				];
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
				'Basic auth: fix the configured env/YAML credentials, then restart/reconnect now-mcp. OAuth: check client/grant/user settings; the client automatically discards a rejected cached token and retries once.',
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
	return hints;
}

/**
 * Render hint lines as a single text block (or null if none).
 */
export function renderHints(hints: string[]): string | null {
	if (hints.length === 0) return null;
	return `Hints:\n${hints.map((h) => `- ${h}`).join('\n')}`;
}
