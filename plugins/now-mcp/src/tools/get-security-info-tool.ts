/**
 * MCP tool for a consolidated view of what protects a table:
 * ACLs, role requirements, data policies, and security business rules.
 *
 * Read-only. Orchestrates several tableService.queryRecords calls; each section
 * degrades independently so one missing permission only empties that section.
 *
 * Two kinds of answer live here and they must not be confused. Everything read
 * out of `sys_security_acl` is an INVENTORY of rules — it explains *why* access
 * is shaped the way it is, but no amount of row-reading combines those rules into
 * a decision. `effectiveAccess` is the decision: ServiceNow's own verdict for the
 * user this MCP authenticates as, obtained from GraphQL's `_table_metadata`.
 */

import {
	GetSecurityInfoOutputSchema,
	GetSecurityInfoSchema,
} from '../schemas/security-info-schemas.js';
import type { EffectiveAccessResult } from '../services/graphql-service.js';
import type { TableService } from '../services/table-service.js';
import type { ServiceNowRecord } from '../types/servicenow.js';
import type { EffectiveAccessReader } from '../utils/access-preflight.js';
import { toolError } from '../utils/error-handler.js';
import { logger } from '../utils/logger.js';
import { toolResult } from '../utils/tool-response.js';

export const GET_SECURITY_INFO_TOOL = {
	name: 'sn_get_security_info',
	title: 'Get security info',
	description: `What: A consolidated view of what protects a table — ACLs (access controls), per-ACL role alternatives, active data policies, and security-related business rules.
When to use: To understand why access to a table/field is granted or denied, or to audit a table's security posture, without querying each security table separately.
Preconditions: The table should exist. Read access to the security metadata tables (sys_security_acl, sys_data_policy2, sys_script) — a section you cannot read is returned empty with a note in warnings, the call still succeeds.
Produces (default, includeDetails=false): effectiveAccess (see below), acls {total, byOperation, tableLevel, fieldLevel}, aclRoleGroups (the roles attached to each ACL are any-of alternatives), rolesByOperation (a lossy inventory only—not a combined requirement), dataPolicies, securityBusinessRules, warnings. ACL role, condition, and script checks on one ACL are conjunctive; admin only bypasses an ACL when adminOverrides is true. Pass includeDetails=true to also get the raw ACL and ACL-role rows.
effectiveAccess is the one section that answers WHETHER rather than why: ServiceNow's own canRead/canWrite/canCreate/canDelete verdict for the user this MCP authenticates as (plus per-field canRead/canWrite when you pass fields). Trust it over any reading of the ACL rows — instances do carry ACLs with admin_overrides=false, so even an admin gets false here. It is the API user's verdict specifically; sn_diagnose_mutation reports the background-script identity, which usually differs.`,
	inputSchema: GetSecurityInfoSchema,
	outputSchema: GetSecurityInfoOutputSchema,
};

/** Verbatim in the response so a caller cannot mistake one answer for the other. */
const EFFECTIVE_ACCESS_NOTE =
	'ServiceNow evaluated this for the credentials this MCP connects with. It is the ' +
	'decision; the ACL sections explain how it was reached. A null verdict means the ' +
	'platform did not report that flag, not that access is denied. Field verdicts are ' +
	'read off one sample record, so a per-record ACL condition is only reflected when ' +
	'recordSysId pins the record you care about.';

export function createGetSecurityInfoTool(
	tableService: TableService,
	accessReader?: EffectiveAccessReader,
) {
	return {
		...GET_SECURITY_INFO_TOOL,
		handler: async (params: unknown) => {
			let tableName: string | undefined;
			try {
				const validated = GetSecurityInfoSchema.parse(params);
				tableName = validated.tableName;
				const instance = validated.instance;
				const t = validated.tableName;
				const includeDetails = validated.includeDetails;
				const operations = validated.operations;
				const fields = validated.fields;

				logger.info(`Getting security info for ${t}`, {
					instance: instance || 'default',
				});

				const warnings: string[] = [];

				// Query one security table, isolating any error to just this section so a
				// single missing permission degrades only that part of the result.
				const safeQuery = async (
					table: string,
					query: string,
					fields: string[],
					limit: number,
					displayValue?: boolean | 'all',
				): Promise<{ records: ServiceNowRecord[]; error?: string }> => {
					try {
						const records = await tableService.queryRecords(
							table,
							{ query, fields, limit, excludeReferenceLink: true, displayValue },
							instance,
						);
						return { records };
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						const note = `Could not read ${table}: ${message}`;
						warnings.push(note);
						logger.warn(note);
						return { records: [], error: message };
					}
				};

				// The effective-access probe. It rides along with the ACL reads because it
				// is a different endpoint (GraphQL, not the Table API), so it adds no
				// wall-clock — and it degrades to a reason string rather than an error,
				// like every other section here.
				const accessProbe = async (): Promise<
					{ ok: true; result: EffectiveAccessResult } | { ok: false; reason: string }
				> => {
					if (!accessReader) {
						return { ok: false, reason: 'This tool was built without a GraphQL read channel.' };
					}
					try {
						const result = await accessReader.fetchEffectiveAccess(
							t,
							{
								fields,
								recordQuery: validated.recordSysId ? `sys_id=${validated.recordSysId}` : undefined,
							},
							instance,
						);
						return { ok: true, result };
					} catch (error) {
						return { ok: false, reason: error instanceof Error ? error.message : String(error) };
					}
				};

				const [
					aclResult,
					dataPolicyResult,
					businessRuleResult,
					beforeBrResult,
					dictionaryResult,
					accessResult,
				] = await Promise.all([
					safeQuery(
						'sys_security_acl',
						`name=${t}^ORnameLIKE${t}.`,
						[
							'sys_id',
							'name',
							'operation',
							'type',
							'active',
							'admin_overrides',
							'condition',
							'script',
						],
						100,
					),
					safeQuery(
						'sys_data_policy2',
						`model_table=${t}^active=true`,
						['sys_id', 'short_description', 'enforce_ui', 'enforce_scripting'],
						50,
					),
					safeQuery(
						'sys_script',
						`collection=${t}^active=true^scriptLIKEgs.hasRole^ORscriptLIKEgs.getUser`,
						['sys_id', 'name', 'when', 'collection'],
						30,
					),
					safeQuery(
						'sys_script',
						`collection=${t}^active=true^when=before`,
						[
							'sys_id',
							'name',
							'when',
							'order',
							'action_update',
							'action_delete',
							'filter_condition',
							'script',
						],
						100,
					),
					safeQuery(
						'sys_dictionary',
						`name=${t}^elementISNOTEMPTY`,
						[
							'sys_id',
							'name',
							'element',
							'internal_type',
							'reference',
							'reference_cascade_rule',
							'read_only',
							'mandatory',
						],
						300,
					),
					accessProbe(),
				]);

				const aclRecords = aclResult.records.filter((acl) => {
					const operation = String(acl.operation ?? '');
					const name = String(acl.name ?? '');
					if (operations?.length && !operations.includes(operation as never)) return false;
					if (fields?.length && name !== t && !fields.some((f) => name === `${t}.${f}`))
						return false;
					return true;
				});
				const aclById = new Map(aclRecords.map((acl) => [acl.sys_id, acl]));

				// Resolve role requirements for the ACLs found. displayValue: 'all' turns
				// each reference field into {value, display_value} so the role comes back
				// as its name (e.g. "admin") instead of a bare sys_id — no second lookup.
				let roleRecords: ServiceNowRecord[] = [];
				if (aclRecords.length > 0) {
					const ids = aclRecords
						.map((acl) => acl.sys_id)
						.filter((id): id is string => typeof id === 'string' && id.length > 0);
					const cappedIds = ids.slice(0, 20);
					if (ids.length > cappedIds.length) {
						warnings.push(
							`Role lookup covers only the first ${cappedIds.length} of ${ids.length} ACLs — role requirements for the rest were not resolved.`,
						);
					}
					if (cappedIds.length > 0) {
						const roleQuery = cappedIds.map((id) => `sys_security_acl=${id}`).join('^OR');
						const roleResult = await safeQuery(
							'sys_security_acl_role',
							roleQuery,
							['sys_security_acl', 'sys_user_role'],
							200,
							'all',
						);
						roleRecords = roleResult.records;
					}
				}

				const refValue = (field: unknown): string | undefined =>
					typeof field === 'object' && field !== null && 'value' in field
						? String((field as { value: unknown }).value)
						: typeof field === 'string'
							? field
							: undefined;
				const refDisplay = (field: unknown): string | undefined =>
					typeof field === 'object' && field !== null && 'display_value' in field
						? String((field as { display_value: unknown }).display_value)
						: undefined;
				const booleanValue = (field: unknown): boolean => {
					const value = refValue(field) ?? String(field ?? '');
					return value === 'true' || value === '1';
				};
				const hasValue = (field: unknown): boolean => {
					const value = refValue(field) ?? String(field ?? '');
					return value.trim().length > 0;
				};

				// Summarize ACLs: counts per operation, table-level vs field-level, and
				// which role names are required per operation.
				const byOperation: Record<string, number> = {};
				let tableLevel = 0;
				let fieldLevel = 0;
				for (const acl of aclRecords) {
					const operation =
						typeof acl.operation === 'string' ? acl.operation : String(acl.operation ?? '');
					if (operation) {
						byOperation[operation] = (byOperation[operation] ?? 0) + 1;
					}
					const name = typeof acl.name === 'string' ? acl.name : '';
					if (name === t) {
						tableLevel += 1;
					} else if (name.includes('.')) {
						fieldLevel += 1;
					}
				}

				const rolesByOperationSets: Record<string, Set<string>> = {};
				for (const role of roleRecords) {
					const aclId = refValue(role.sys_security_acl);
					const roleName = refDisplay(role.sys_user_role) ?? refValue(role.sys_user_role);
					const acl = aclId ? aclById.get(aclId) : undefined;
					const operation =
						acl && typeof acl.operation === 'string' ? acl.operation : (acl?.operation ?? '');
					const operationKey = String(operation || 'unknown');
					if (!roleName) continue;
					(rolesByOperationSets[operationKey] ??= new Set()).add(roleName);
				}
				const rolesByOperation: Record<string, string[]> = {};
				for (const [operation, names] of Object.entries(rolesByOperationSets)) {
					rolesByOperation[operation] = Array.from(names).sort();
				}

				// A single ACL's Requires role list is an any-of list. Do not flatten
				// roles across ACLs and present that union as one authorization rule:
				// ACL evaluation also depends on matching table/field ACLs and each
				// ACL's condition/script. Keep the legacy operation inventory above,
				// but expose the semantically useful grouping explicitly.
				const roleNamesByAcl = new Map<string, Set<string>>();
				for (const role of roleRecords) {
					const aclId = refValue(role.sys_security_acl);
					const roleName = refDisplay(role.sys_user_role) ?? refValue(role.sys_user_role);
					if (!aclId || !roleName) continue;
					const names = roleNamesByAcl.get(aclId) ?? new Set<string>();
					names.add(roleName);
					roleNamesByAcl.set(aclId, names);
				}
				const aclRoleGroups = aclRecords.map((acl) => {
					const aclSysId = String(acl.sys_id ?? '');
					const requiredRolesAnyOf = Array.from(roleNamesByAcl.get(aclSysId) ?? []).sort();
					return {
						aclSysId,
						name: String(acl.name ?? ''),
						operation: String(acl.operation ?? ''),
						active: booleanValue(acl.active),
						adminOverrides: booleanValue(acl.admin_overrides),
						roleRequirement:
							requiredRolesAnyOf.length > 0 ? ('any_of' as const) : ('none' as const),
						requiredRolesAnyOf,
						hasCondition: hasValue(acl.condition),
						hasScript: hasValue(acl.script),
					};
				});

				// Assemble the verdict section. Unavailability is stated explicitly rather
				// than omitted, so a missing section can never be read as "denied".
				let effectiveAccess: Record<string, unknown>;
				if (accessResult.ok) {
					const access = accessResult.result;
					effectiveAccess = {
						available: true,
						source: 'graphql _table_metadata and per-field metadata',
						identity: 'the ServiceNow user this MCP authenticates as',
						...(validated.recordSysId ? { evaluatedAgainstRecord: validated.recordSysId } : {}),
						table: access.table,
						fields: access.fields,
						fieldVerdicts: access.fieldVerdicts,
						unresolvedFields: access.unresolvedFields,
						note: EFFECTIVE_ACCESS_NOTE,
					};
					if (access.fieldVerdicts === 'no_sample_row') {
						warnings.push(
							`No field-level effective access for ${t}: field verdicts live on a record, and ` +
								`${validated.recordSysId ? `record ${validated.recordSysId}` : 'this table'} returned no readable row.`,
						);
					}
					if (access.unresolvedFields.length > 0) {
						warnings.push(
							`No effective-access verdict for field(s) ${access.unresolvedFields.join(', ')} on ${t} — ` +
								`GraphQL returns null for a field that does not exist, so these names are probably wrong.`,
						);
					}
				} else {
					effectiveAccess = { available: false, reason: accessResult.reason };
					warnings.push(
						`Effective access could not be determined: ${accessResult.reason}. The ACL sections below ` +
							`describe the rules, not the resulting verdict — do not read this as denied access.`,
					);
				}

				const acls: Record<string, unknown> = {
					total: aclRecords.length,
					byOperation,
					tableLevel,
					fieldLevel,
				};
				const response: Record<string, unknown> = {
					success: true,
					table: t,
					effectiveAccess,
					acls,
					aclRoleGroups,
					rolesByOperation,
					dataPolicies: dataPolicyResult.records,
					securityBusinessRules: businessRuleResult.records,
					beforeBusinessRules: beforeBrResult.records.map((br) => ({
						...br,
						hasAbortAction: String(br.script ?? '').includes('setAbortAction'),
					})),
					dictionary: dictionaryResult.records,
				};
				if (includeDetails) {
					acls.details = aclRecords;
					response.roleRequirements = roleRecords;
				}
				if (warnings.length > 0) {
					response.warnings = warnings;
				}

				// Lead the one-line summary with the verdict, in the compact RWCD form: it
				// is the answer most callers came for. A denied flag shows as '.'.
				const verdict = accessResult.ok
					? ['canRead', 'canWrite', 'canCreate', 'canDelete']
							.map((flag, i) => {
								const value = accessResult.result.table[flag as 'canRead'];
								return value === true ? 'RWCD'[i] : value === false ? '.' : '?';
							})
							.join('')
					: 'unknown';

				return toolResult(
					response,
					`${t}: effective access ${verdict}; ${aclRecords.length} ACL(s), ${dataPolicyResult.records.length} data policy(ies)${
						warnings.length > 0 ? ' — see warnings' : ''
					}`,
				);
			} catch (error) {
				logger.error('Error getting security info', error);
				return toolError(error, {
					table: tableName,
					operation: 'get security info',
					requiredRoles: ['admin', 'security_admin'],
				});
			}
		},
	};
}
