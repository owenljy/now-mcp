/**
 * Optional write pre-flight against ServiceNow's own effective-ACL verdict.
 *
 * Why this exists: a denied write is normally discovered AFTER the fact — either
 * as a 403, or worse, as a 200 that silently persisted nothing. GraphQL's
 * `_table_metadata` (and the per-field metadata leaves) answer the question up
 * front, evaluated by the platform on the same credentials the write would use.
 *
 * Two deliberate limits:
 *   - It is advisory infrastructure, so a broken probe never blocks a write. Any
 *     GraphQL failure returns null and the write proceeds as it did before.
 *   - It answers for the API user. `sn_diagnose_mutation` answers for the
 *     background-script identity, which is usually more privileged — the two can
 *     disagree in both directions, which is exactly why this path exists.
 */

import type { EffectiveAccessOptions, EffectiveAccessResult } from '../services/graphql-service.js';
import { logger } from './logger.js';

/** The slice of GraphqlService this pre-flight needs — keeps callers testable. */
export interface EffectiveAccessReader {
	fetchEffectiveAccess(
		tableName: string,
		options?: EffectiveAccessOptions,
		instance?: string,
	): Promise<EffectiveAccessResult>;
}

export interface AccessPreflightCheck {
	/** create checks canCreate; update checks canWrite plus per-field canWrite. */
	operation: 'create' | 'update';
	tableName: string;
	/** Fields the write would set. Only consulted for `update`. */
	fields?: string[];
	/** Encoded query pinning the target row, so field verdicts describe IT. */
	recordQuery?: string;
	instance?: string;
	/** Off by default: the check costs a round trip, so the caller opts in. */
	enabled?: boolean;
}

function renderVerdict(result: EffectiveAccessResult): string {
	const t = result.table;
	const show = (value: boolean | null): string => (value === null ? 'unknown' : String(value));
	return (
		`canRead=${show(t.canRead)} canWrite=${show(t.canWrite)} ` +
		`canCreate=${show(t.canCreate)} canDelete=${show(t.canDelete)}`
	);
}

/**
 * Returns a refusal message when the platform says this caller cannot perform the
 * write, or null when it can, when the answer is unknown, or when the check is off.
 *
 * Only an explicit `false` blocks. A null verdict (field absent from the
 * response) is treated as unknown and allowed through — the platform's own
 * response remains the authority.
 */
export async function preflightEffectiveAccess(
	reader: EffectiveAccessReader | undefined,
	check: AccessPreflightCheck,
): Promise<string | null> {
	if (!reader || !check.enabled) return null;

	// Field verdicts come off a row, so they describe write ACLs on an EXISTING
	// record. That is the wrong question for an insert (and there is no target row
	// to read), so create checks the table verdict only.
	const fields = check.operation === 'update' ? (check.fields ?? []) : [];

	let result: EffectiveAccessResult;
	try {
		result = await reader.fetchEffectiveAccess(
			check.tableName,
			{ fields, recordQuery: check.recordQuery },
			check.instance,
		);
	} catch (error) {
		// Advisory only: never fail a write because the diagnostic channel is down.
		logger.warn(
			`Effective-access pre-flight skipped for ${check.tableName}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return null;
	}

	const tableAllowed =
		check.operation === 'create' ? result.table.canCreate : result.table.canWrite;
	const readOnlyFields = result.fields.filter((f) => f.canWrite === false).map((f) => f.field);

	if (tableAllowed !== false && readOnlyFields.length === 0) return null;

	const label = check.operation === 'create' ? 'create records in' : 'update';
	const reason =
		tableAllowed === false
			? `cannot ${label} ${check.tableName}`
			: `cannot write ${readOnlyFields.length === 1 ? 'field' : 'fields'} ` +
				`${readOnlyFields.join(', ')} on ${check.tableName}`;

	const lines = [
		`Blocked before sending: ServiceNow reports the API user this MCP authenticates as ${reason}.`,
		'',
		'Effective access for that user (the platform’s own evaluation, not an inference from sys_security_acl rows):',
		`  ${check.tableName} — ${renderVerdict(result)}`,
	];
	if (readOnlyFields.length > 0) {
		lines.push(`  read-only field(s) among those requested: ${readOnlyFields.join(', ')}`);
	}
	if (result.unresolvedFields.length > 0) {
		lines.push(
			`  no verdict for: ${result.unresolvedFields.join(', ')} — GraphQL returns null for a field that does not exist, so check the name(s).`,
		);
	}
	lines.push(
		'',
		'Nothing was sent. Next steps:',
		`  - sn_get_security_info (effectiveAccess + aclRoleGroups) shows which ACLs decide this.`,
		'  - sn_diagnose_mutation answers for the background-script identity instead, which is usually more privileged — a green verdict there does not mean this user can write.',
		'  - Pass preflightAccess: false to send the request anyway and let the platform answer.',
	);

	return lines.join('\n');
}
