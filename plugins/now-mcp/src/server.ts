/**
 * MCP Server initialization and configuration
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SetLevelRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { InstanceManager } from './client/instance-manager.js';
import { registerPrompts } from './prompts/index.js';
import { registerResources } from './resources/index.js';
import { registerDegradedTools, registerTools } from './tools/index.js';
import { logger } from './utils/logger.js';
import { packageVersion } from './utils/package-info.js';

const SERVER_VERSION = packageVersion();

/**
 * Guidance surfaced to the assistant in the `initialize` result. The key part is
 * the now-sdk default-alignment protocol: a stdio MCP server can't prompt a
 * human directly, so the assistant performs the check and asks for confirmation.
 */
const SESSION_INSTRUCTIONS = `This MCP serves live ServiceNow data across one or more configured instances. Tool calls that omit the "instance" argument target the DEFAULT instance.

Token economy: every row you fetch stays in context and is re-paid on every later turn of this session. Before any read, decide whether you need the ROWS or just a NUMBER. If the question is "how many", "per group", "which values does this column take", or any min/max/avg/sum, it belongs to sn_aggregate_records — it computes server-side and returns a few numbers instead of hundreds of rows. On sn_query_records always pass fields with the specific columns you need; omitting it returns EVERY column. When a result comes back with Hints, act on them — they name the cheaper call, computed from what you actually got.

now-sdk default alignment: by default the MCP AUTO-FOLLOWS now-sdk's active instance, so the default is already aligned and no start-of-session check is needed. Only when the operator has set SERVICENOW_FOLLOW_NOW_SDK=false AND multiple instances are configured can the MCP default drift from the instance now-sdk deploys to. In that case, if you are about to verify a Fluent deploy and want to be sure both target the same instance, call sn_sdk_status once: if it returns "defaultAligned": false with a "recommendedDefaultInstance", tell the user now-sdk points at <nowSdkDefaultHost> (instance "<recommendedDefaultInstance>") while the MCP default is "<mcpDefaultInstance>". To realign, pass instance:"<recommendedDefaultInstance>" explicitly on the calls you make, or advise the user to drop SERVICENOW_FOLLOW_NOW_SDK=false (follow then auto-aligns) or set default:true on that instance in the config YAML. Otherwise proceed normally.

now-sdk presence: this MCP only reads/writes DATA on the running instance — it never authors application metadata (tables, business rules, UI policies, workflows, ACLs). That's the Fluent SDK's (now-sdk) job. The sn_sdk_status tool is registered ONLY when now-sdk is on PATH; its absence from your tool list is your signal that now-sdk isn't installed. Don't mention this proactively — but if the user asks to build/author/deploy any application metadata, or otherwise wants a Fluent app, and sn_sdk_status is unavailable, tell them now-sdk isn't installed and to run: pnpm add -g @servicenow/sdk (see the plugin README for details).`;

/**
 * Create and configure the MCP server.
 * @param instanceManager Instance manager, or null if configuration failed.
 * @param configError The configuration error to surface in degraded mode.
 */
export async function createServer(
	instanceManager: InstanceManager | null,
	configError: Error | null = null,
): Promise<McpServer> {
	// The high-level McpServer infers capabilities from registrations. In
	// degraded mode we register no tools and fall back to low-level handlers
	// (see registerDegradedTools), but still declare the tools capability so the
	// empty list + config error are visible.
	const capabilities = instanceManager
		? { tools: {}, resources: {}, prompts: {}, logging: {} }
		: { tools: {}, logging: {} };

	// Returned in the `initialize` result. Drives the session-start protocol that
	// keeps the MCP default instance aligned with the instance now-sdk is
	// connected to — with explicit user confirmation before any switch.
	const instructions = instanceManager ? SESSION_INSTRUCTIONS : undefined;

	const server = new McpServer(
		{
			name: 'now-mcp',
			title: 'ServiceNow',
			version: SERVER_VERSION,
		},
		{ capabilities, instructions },
	);

	// Mirror our stderr logs to the MCP client via notifications/message. stderr
	// remains the always-on fallback (see logger.ts); this is best-effort and
	// never throws — the SDK drops messages until the client supports logging and
	// gates them by the client's requested level.
	logger.setMcpSender((entry) => {
		server.server
			.sendLoggingMessage({
				level: entry.level,
				logger: 'now-mcp',
				data: entry.data,
			})
			.catch(() => {
				// Client not ready / logging unsupported — stderr already has the log.
			});
	});

	// When the logging capability is declared, the SDK's underlying Server
	// auto-registers its own logging/setLevel handler (it records the level to
	// gate outgoing messages per session). setRequestHandler is a Map.set, so
	// registering ours here REPLACES the SDK's. That's intentional: we gate
	// forwarding at the source via the Logger's own level (see forwardToMcp +
	// shouldLog), so steering logger.setLevel is what actually honors the client's
	// request. The try/catch is defensive only — a future SDK that rejects
	// duplicate registration must not crash startup.
	try {
		server.server.setRequestHandler(SetLevelRequestSchema, async (req) => {
			const level = req.params.level;
			// Map the MCP spec level enum onto the levels our Logger understands.
			if (level === 'warning' || level === 'notice') {
				logger.setLevel('warn');
			} else if (
				level === 'error' ||
				level === 'critical' ||
				level === 'alert' ||
				level === 'emergency'
			) {
				logger.setLevel('error');
			} else if (level === 'debug') {
				logger.setLevel('debug');
			} else {
				logger.setLevel('info');
			}
			return {};
		});
	} catch (e) {
		logger.debug('logging/setLevel handled by SDK; skipping manual handler', {
			error: e instanceof Error ? e.message : String(e),
		});
	}

	// Register tools normally, or degraded handlers if config couldn't load.
	if (instanceManager) {
		await registerTools(server, instanceManager);
		registerResources(server, instanceManager);
		registerPrompts(server, instanceManager);
	} else {
		await registerDegradedTools(server, configError);
	}

	// Set up error handler on the underlying low-level Server.
	server.server.onerror = (error) => {
		logger.error('Server error occurred', error);
	};

	logger.info('now-mcp server initialized');

	return server;
}

/**
 * Start the MCP server with stdio transport
 */
export async function startServer(server: McpServer): Promise<void> {
	// Create stdio transport
	const transport = new StdioServerTransport();

	// Connect server to transport
	await server.connect(transport);

	logger.info('now-mcp server connected via stdio transport');

	// Log server information
	logger.info('Server ready to receive requests', {
		name: 'now-mcp',
		version: SERVER_VERSION,
		transport: 'stdio',
	});
}
