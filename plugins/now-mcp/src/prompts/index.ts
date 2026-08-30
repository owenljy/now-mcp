/**
 * MCP Prompts — canned, discoverable workflows the user can invoke from the
 * client. Each returns a guidance message that orchestrates the existing tools
 * (and, for the Fluent loop, the now-sdk CLI run by the agent host).
 */

import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { InstanceManager } from '../client/instance-manager.js';
import { TableService } from '../services/table-service.js';
import { logger } from '../utils/logger.js';

// Static fallbacks: completion must always return *something* helpful even when
// the instance is unreachable (e.g. placeholder creds). These mirror the shapes
// the prompts ask for.
const COMMON_SCOPES = ['global', 'x_acme_app', 'x_snc_app'];

// Completion fires per keystroke; cache the live scope list per instance for a
// short TTL and prefix-filter locally so a burst of typing costs one lookup.
const SCOPE_CACHE_TTL_MS = 60_000;
const scopeCache = new Map<string, { at: number; scopes: string[] }>();

function rankStrings(candidates: string[], prefix: string): string[] {
	const p = prefix.toLowerCase();
	const seen = new Set<string>();
	const out: string[] = [];
	for (const c of candidates) {
		if (!c || seen.has(c)) continue;
		if (p && !c.toLowerCase().includes(p)) continue;
		seen.add(c);
		out.push(c);
	}
	return out.slice(0, 100);
}

/**
 * Wrap guidance lines into the MCP prompt result shape. Every prompt returns a
 * single user-role text message; centralizing the wrapper keeps the handlers to
 * just their content and prevents the message shape from drifting between them.
 */
function textPrompt(lines: string[]) {
	return {
		messages: [
			{ role: 'user' as const, content: { type: 'text' as const, text: lines.join('\n') } },
		],
	};
}

export function registerPrompts(server: McpServer, instanceManager: InstanceManager): void {
	const tableService = new TableService(instanceManager);

	// Recent app scopes from sys_scope, prefix-filtered, with a static fallback.
	// Cached per instance for a short TTL so per-keystroke completion doesn't
	// round-trip to ServiceNow on every character.
	const completeScope = async (value: string): Promise<string[]> => {
		const prefix = (value ?? '').trim();
		const cacheKey = instanceManager.getDefaultInstance();
		const cached = scopeCache.get(cacheKey);
		if (cached && Date.now() - cached.at < SCOPE_CACHE_TTL_MS) {
			return rankStrings([...cached.scopes, ...COMMON_SCOPES], prefix);
		}
		try {
			// Fetch the recent scope set once and cache it; prefix-filtering is local
			// (rankStrings), so we don't push the partial into the query.
			const records = await tableService.queryRecords('sys_scope', {
				query: 'ORDERBYDESCsys_updated_on',
				fields: ['scope'],
				limit: 50,
			});
			const scopes = records
				.map((r) => (r as Record<string, unknown>).scope)
				.filter((s): s is string => typeof s === 'string' && s.length > 0);
			scopeCache.set(cacheKey, { at: Date.now(), scopes });
			return rankStrings([...scopes, ...COMMON_SCOPES], prefix);
		} catch (error) {
			// Completion is best-effort: fall back to the static list, but log why the
			// live lookup failed so a misconfig/permission issue isn't invisible.
			logger.debug('Scope completion lookup failed; using static fallback', {
				error: error instanceof Error ? error.message : String(error),
			});
			return rankStrings(COMMON_SCOPES, prefix);
		}
	};

	// Incident-number completion. We deliberately do NOT query live records here:
	// fetching real incident numbers would (a) round-trip per keystroke and (b)
	// leak live record identifiers into autocomplete before the user commits to
	// any action. Return only a static, non-identifying format hint.
	const completeIncidentNumber = (value: string): string[] =>
		rankStrings(['INC0010001'], (value ?? '').trim());

	server.registerPrompt(
		'verify_fluent_deploy',
		{
			title: 'Verify Fluent deploy',
			description: 'Verify a Fluent (now-sdk) deploy landed and behaves on the instance.',
			argsSchema: {
				scope: completable(
					z.string().describe("App scope, e.g. 'x_acme_app' (from now.config.json)"),
					completeScope,
				),
			},
		},
		(args) => {
			const scope = args.scope || '<scope>';
			return textPrompt([
				`Verify the Fluent app in scope "${scope}" deployed correctly:`,
				'',
				`1. Confirm artifacts landed: sn_query_records on "sys_metadata" with`,
				`   query "sys_scope.scope=${scope}" — group/sanity-check the records you expect`,
				`   (or use sn_aggregate_records grouped by sys_class_name).`,
				'2. For new/changed tables, re-read the schema with sn_get_table_schema.',
				'3. Exercise behavior: sn_execute_background_script to trigger the logic,',
				'   then sn_query_records on "syslog" (level=error, recent) to check for errors.',
				'4. Confirm the MCP and now-sdk target the same instance with sn_sdk_status.',
			]);
		},
	);

	server.registerPrompt(
		'diagnose_deploy_failure',
		{
			title: 'Diagnose deploy failure',
			description: 'Investigate why a now-sdk deploy failed, using instance-side logs.',
			argsSchema: {
				scope: z.string().optional().describe('App scope being deployed'),
			},
		},
		(args) => {
			const scope = args.scope ? ` for scope "${args.scope}"` : '';
			return textPrompt([
				`A now-sdk deploy${scope} failed. Use the instance to explain why:`,
				'',
				'1. sn_query_records on "syslog" with level=error, ordered by newest,',
				'   filtered to around the deploy time — look for the underlying error.',
				'2. Check "sys_update_xml" / "sys_metadata" for partially-applied records in the scope.',
				'3. If it is a runtime error in app logic, reproduce it with',
				'   sn_execute_background_script and read the gs.log output.',
				'4. Summarize the root cause and the specific Fluent source change needed to fix it.',
			]);
		},
	);

	server.registerPrompt(
		'investigate_incident',
		{
			title: 'Investigate incident',
			description: 'Pull an incident and its context (caller, CIs, related changes) in one sweep.',
			argsSchema: {
				number: completable(
					z.string().describe('Incident number, e.g. INC0010001'),
					completeIncidentNumber,
				),
			},
		},
		(args) => {
			// Only interpolate a well-formed incident number into the example query.
			// Anything else becomes a neutral placeholder so a malformed/hostile value
			// (e.g. containing `^` or ORDERBY) can't shape the query we hand the model.
			const raw = (args.number || '').trim();
			const num = /^INC\d+$/i.test(raw) ? raw.toUpperCase() : '<INC...>';
			return textPrompt([
				`Investigate incident ${num}:`,
				'',
				`1. sn_query_records on "incident" query "number=${num}", displayValue=true,`,
				'   dot-walking caller_id.name, assignment_group.name, cmdb_ci.name.',
				'2. Pull the affected CI and its relationships (cmdb_rel_ci) and recent changes',
				'   (change_request) touching that CI.',
				'3. Check for similar recent incidents (same cmdb_ci or short_description) via',
				'   sn_aggregate_records / sn_query_records.',
				'4. Summarize likely cause, blast radius, and next action.',
			]);
		},
	);

	server.registerPrompt(
		'cmdb_health_overview',
		{
			title: 'CMDB health overview',
			description: 'Summarize CMDB inventory and basic health signals.',
			argsSchema: {},
		},
		() =>
			textPrompt([
				'Produce a CMDB health overview:',
				'',
				'1. sn_aggregate_records on "cmdb_ci" grouped by sys_class_name (count) for inventory.',
				'2. If the CMDB Health engine has run, read "cmdb_health_result" for completeness/',
				'   correctness/compliance scores.',
				'3. Compute ad-hoc signals via sn_aggregate_records / sn_query_records:',
				'   stale CIs (sys_updated_on old), CIs missing owner/support_group, duplicates by name.',
				'4. Summarize the biggest data-quality gaps and where to focus.',
			]),
	);

	logger.info('Registered 4 MCP prompts');
}
