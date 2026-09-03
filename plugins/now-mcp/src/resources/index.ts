/**
 * MCP Resources — read-only, addressable context the client can fetch cheaply.
 *
 *   servicenow://instances        → the configured instances (no credentials)
 *   servicenow://schema/{table}   → a table's schema (resource template)
 *
 * Resources complement tools: the model can pull schema/context by URI without
 * spending a tool call
 */

import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InstanceManager } from '../client/instance-manager.js';
import { SchemaService } from '../services/schema-service.js';
import { logger } from '../utils/logger.js';

const INSTANCES_URI = 'servicenow://instances';

// A small, always-useful fallback when the instance can't be reached (e.g. the
// example/placeholder creds in the contract test). These are the tables the
// read tools touch most, so completion is still helpful offline.
const COMMON_TABLES = [
	'incident',
	'problem',
	'change_request',
	'task',
	'sc_request',
	'sc_req_item',
	'sys_user',
	'sys_user_group',
	'cmdb_ci',
	'cmdb_rel_ci',
	'sys_db_object',
	'sys_dictionary',
	'sys_metadata',
	'sys_scope',
	'sys_update_set',
	'sys_update_xml',
	'syslog',
];

// Completion fires on every client keystroke; without caching each one is a
// live round-trip to ServiceNow. Cache the (full) table-name list per instance
// for a short TTL and prefix-filter locally — keystrokes within the window cost
// nothing and never touch the instance.
const TABLE_CACHE_TTL_MS = 60_000;
const tableNameCache = new Map<string, { at: number; names: string[] }>();

function rankTables(candidates: string[], prefix: string): string[] {
	const p = prefix.toLowerCase();
	const seen = new Set<string>();
	const out: string[] = [];
	for (const name of candidates) {
		if (seen.has(name)) continue;
		if (p && !name.toLowerCase().includes(p)) continue;
		seen.add(name);
		out.push(name);
	}
	// MCP caps completion results at 100; keep it tidy.
	return out.slice(0, 100);
}

export function registerResources(server: McpServer, instanceManager: InstanceManager): void {
	const schemaService = new SchemaService(instanceManager);

	server.registerResource(
		'configured-instances',
		INSTANCES_URI,
		{
			title: 'Configured instances',
			description:
				'The ServiceNow instances this server is configured for (names, URLs, read-only flags — no credentials).',
			mimeType: 'application/json',
		},
		async (uri) => {
			const runtimeDefault = instanceManager.getDefaultInstance();
			const instances = instanceManager.listInstances().map((name) => {
				const cfg = instanceManager.getConfig(name);
				return {
					name: cfg.name,
					url: cfg.url,
					default: name === runtimeDefault,
					readOnly: cfg.readOnly !== false,
					authType: cfg.auth.type,
				};
			});
			return {
				contents: [
					{
						uri: uri.href,
						mimeType: 'application/json',
						text: JSON.stringify({ instances }, null, 2),
					},
				],
			};
		},
	);

	// Dynamic table-schema template. `list: undefined` is required (it signals we
	// intentionally don't enumerate every table). The `complete.table` callback
	// autocompletes table names off the live instance (via list_tables), falling
	// back to a static common-tables set when the instance is unreachable so the
	// contract test and offline use still get helpful candidates.
	server.registerResource(
		'table-schema',
		new ResourceTemplate('servicenow://schema/{table}', {
			list: undefined,
			complete: {
				table: async (value) => {
					const prefix = (value ?? '').trim();
					// Cache by instance and filter locally: a burst of keystrokes reuses
					// one lookup instead of hitting ServiceNow on each character.
					const cacheKey = instanceManager.getDefaultInstance();
					const cached = tableNameCache.get(cacheKey);
					if (cached && Date.now() - cached.at < TABLE_CACHE_TTL_MS) {
						return rankTables([...cached.names, ...COMMON_TABLES], prefix);
					}
					try {
						// Fetch the (broad) table list once and cache it; prefix-filtering
						// happens locally in rankTables, so we don't pass the partial here.
						const { tables } = await schemaService.listTables(undefined, 100);
						const names = tables.map((t) => t.name);
						tableNameCache.set(cacheKey, { at: Date.now(), names });
						// Blend in common tables so the list is never empty/odd-shaped.
						return rankTables([...names, ...COMMON_TABLES], prefix);
					} catch {
						return rankTables(COMMON_TABLES, prefix);
					}
				},
			},
		}),
		{
			title: 'Table schema',
			description:
				"A table's field definitions (name, type, reference, mandatory/read-only). Example: servicenow://schema/incident",
			mimeType: 'application/json',
		},
		async (uri, variables) => {
			const raw = Array.isArray(variables.table) ? variables.table[0] : variables.table;
			const table = decodeURIComponent(String(raw ?? '')).trim();
			if (!table) {
				throw new Error(
					`Invalid schema resource URI: "${uri.href}" (expected servicenow://schema/<table>)`,
				);
			}
			const schema = await schemaService.getTableSchema(table);
			return {
				contents: [
					{
						uri: uri.href,
						mimeType: 'application/json',
						text: JSON.stringify(schema, null, 2),
					},
				],
			};
		},
	);

	logger.info('Registered MCP resources (instances, schema template)');
}
