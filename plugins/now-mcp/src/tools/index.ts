/**
 * Tool registration for MCP server
 *
 * this server is the live-instance observation +
 * data layer. Authoring app metadata (business rules, ACLs, UI policies,
 * flows, PA, portal, AI agents, AWA, ...) is the job of the ServiceNow Fluent
 * SDK driven by the agent host — not blind table POSTs from here. The surface is
 * intentionally small: data CRUD, schema discovery, script execution,
 * attachments, update sets, and test-data seeding.
 */

import { randomUUID } from 'node:crypto';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { InstanceManager } from '../client/instance-manager.js';
import { AttachmentService } from '../services/attachment-service.js';
import { BatchService } from '../services/batch-service.js';
import { GraphqlService } from '../services/graphql-service.js';
import { SchemaService } from '../services/schema-service.js';
import { ScriptService } from '../services/script-service.js';
import { TableService } from '../services/table-service.js';
import { summarizeToolArguments } from '../utils/log-safety.js';
import { logger } from '../utils/logger.js';
import { isNowSdkAvailable } from '../utils/now-sdk-cli.js';
import { runWithOperationContext } from '../utils/operation-context.js';
import { formatToolCall } from '../utils/tool-log.js';
import { createAggregateRecordsTool } from './aggregate-records-tool.js';
import { TOOL_ANNOTATIONS } from './annotations.js';
import { createConnectionStatusTool, createResetConnectionTool } from './connection-status-tool.js';
import { createCreateRecordsTool } from './create-records-tool.js';
import { createDeleteRecordsTool } from './delete-records-tool.js';
import { createDiagnoseMutationTool } from './diagnose-mutation-tool.js';
import { createDiffRecordsTool } from './diff-records-tool.js';
import { createDownloadAttachmentTool } from './download-attachment-tool.js';
import { createExecuteBackgroundScriptTool } from './execute-background-script-tool.js';
import { createFindFieldsTool } from './find-fields-tool.js';
import { createGetAttachmentMetadataTool } from './get-attachment-metadata-tool.js';
import { createGetChoiceListTool } from './get-choice-list-tool.js';
import { createGetRecordTimelineTool } from './get-record-timeline-tool.js';
import { createGetRuntimeEventsTool } from './get-runtime-events-tool.js';
import { createGetSecurityInfoTool } from './get-security-info-tool.js';
import { createGetTableSchemaTool } from './get-table-schema-tool.js';
import { createGetTableStructureFromDataTool } from './get-table-structure-from-data-tool.js';
import { createListTablesTool } from './list-tables-tool.js';
import { createQueryRecordsTool } from './query-records-tool.js';
import { createSdkStatusTool } from './sdk-status-tool.js';
import { createSwitchDefaultInstanceTool } from './switch-default-instance-tool.js';
import { createUpdateRecordsTool } from './update-records-tool.js';
import { createUploadAttachmentTool } from './upload-attachment-tool.js';

/**
 * Shape every createXTool factory returns. `inputSchema` / `outputSchema` are
 * Zod schemas passed straight to `registerTool` (the SDK builds the advertised
 * JSON Schema itself). The handler returns an MCP `CallToolResult`-shaped
 * object: success carries `structuredContent`, errors set `isError: true`.
 */
export interface ToolDescriptor {
	name: string;
	title?: string;
	description: string;
	inputSchema: z.ZodTypeAny;
	outputSchema: z.ZodTypeAny;
	handler: (args: unknown, server?: Server) => Promise<ToolResult> | ToolResult;
}

interface ToolResult {
	content: { type: 'text'; text: string }[];
	structuredContent?: Record<string, unknown>;
	/**
	 * Result-level metadata (MCP `_meta`): structured, outside the text body and
	 * outside `structuredContent`. Query/aggregate carry `{ instance, durationMs,
	 * rowCount? }` here (WS-B §4.2).
	 */
	_meta?: Record<string, unknown>;
	isError?: boolean;
}

/**
 * Decorator that preserves the per-call tool logging the old
 * `CallToolRequestSchema` wrapper performed: extract the target `instance` from
 * args, time the call, derive `ok` from `result.isError`, and emit
 * `formatToolCall(...)`. On throw, log `ok:false` then rethrow so `McpServer`
 * converts the error into an `isError` tool result.
 */
function withLogging(
	name: string,
	handler: ToolDescriptor['handler'],
	lowLevelServer: Server,
	instanceManager: InstanceManager,
): (args: unknown, extra: unknown) => Promise<ToolResult> {
	return async (args: unknown, extra: unknown): Promise<ToolResult> => {
		const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
		const operationId = randomUUID();
		const selector =
			args &&
			typeof args === 'object' &&
			typeof (args as Record<string, unknown>).instance === 'string'
				? ((args as Record<string, unknown>).instance as string)
				: undefined;
		// Resolve once at the call boundary. Pinning the concrete name into ordinary
		// tool args prevents a concurrent default switch from splitting requests,
		// cache keys, logs and responses across two instances mid-call.
		const instance = instanceManager.resolveInstance(selector).name;
		const handlerArgs =
			name !== 'sn_connection_status' && args && typeof args === 'object' && !Array.isArray(args)
				? { ...(args as Record<string, unknown>), instance }
				: args;
		logger.debug(`Tool called: ${name}`, {
			arguments: summarizeToolArguments(handlerArgs),
			operationId,
		});

		return runWithOperationContext({ operationId, instance, tool: name, signal }, async () => {
			const start = Date.now();
			try {
				const result = await handler(handlerArgs, lowLevelServer);
				const durationMs = Date.now() - start;
				const ok = !(result && result.isError === true);
				const { msg, data } = formatToolCall({
					tool: name,
					durationMs,
					ok,
					instance,
				});
				logger.info(msg, { ...data, operationId });
				return {
					...result,
					_meta: {
						instance,
						durationMs,
						operationId,
						...(result._meta ?? {}),
					},
				};
			} catch (error) {
				const durationMs = Date.now() - start;
				const message = error instanceof Error ? error.message : String(error);
				const { msg, data } = formatToolCall({
					tool: name,
					durationMs,
					ok: false,
					instance,
					error: message,
				});
				logger.info(msg, { ...data, operationId });
				throw error;
			}
		});
	};
}

/**
 * Register all ServiceNow tools with the MCP server
 * @param server MCP server instance
 * @param instanceManager Instance manager for multi-instance support
 */
export async function registerTools(
	server: McpServer,
	instanceManager: InstanceManager,
): Promise<void> {
	// Initialize services with instance manager. schemaService is constructed
	// first so table/batch writes can resolve a scoped table's owning app scope
	// (sysparm_transaction_scope) — see utils/transaction-scope.ts.
	const schemaService = new SchemaService(instanceManager);
	const tableService = new TableService(instanceManager, schemaService);
	const attachmentService = new AttachmentService(instanceManager);
	const scriptService = new ScriptService(instanceManager);
	const batchService = new BatchService(instanceManager, schemaService);
	// Read-only GraphQL transport: `expand` on sn_query_records, plus the
	// effective-ACL verdicts the security and write tools ask for. Not a tool of
	// its own — see services/graphql-service.ts for why raw GraphQL is
	// deliberately not exposed.
	const graphqlService = new GraphqlService(instanceManager);

	const tools: ToolDescriptor[] = [
		// Table operations (runtime data)
		createQueryRecordsTool(tableService, schemaService, graphqlService),
		createAggregateRecordsTool(tableService, schemaService),
		// One tool per operation, for one record or many: cardinality is data, not a
		// different operation, and a separate batch tool got looped per record. Each
		// write tool routes internally — the plain Table API for a single record (real
		// HTTP status, echoed row), the Table Batch API in waves beyond that.
		createCreateRecordsTool(tableService, batchService, schemaService, graphqlService),
		createUpdateRecordsTool(tableService, batchService, schemaService, graphqlService),
		createDeleteRecordsTool(batchService, tableService, schemaService),

		// Schema discovery. Four rungs of one ladder, by what the caller already
		// knows: a name fragment (sn_list_tables + filter), only the concept
		// (sn_list_tables + concept), only a field the table must carry
		// (sn_find_fields), or the exact table name (sn_get_table_schema).
		createGetTableSchemaTool(schemaService),
		createListTablesTool(schemaService),
		createFindFieldsTool(schemaService),
		createGetChoiceListTool(schemaService),
		// Data-inference fallback for tables whose sys_dictionary is thin/incomplete.
		createGetTableStructureFromDataTool(tableService),

		// Comparison & security posture (read-only observation)
		createDiffRecordsTool(tableService),
		createGetSecurityInfoTool(tableService, graphqlService),
		createDiagnoseMutationTool(scriptService),
		createGetRecordTimelineTool(tableService),
		createGetRuntimeEventsTool(tableService),

		// Script execution (with advisory schema pre-flight on referenced fields)
		createExecuteBackgroundScriptTool(scriptService, schemaService),

		// Attachments
		createUploadAttachmentTool(attachmentService),
		createDownloadAttachmentTool(attachmentService),
		// Lightweight "what attachments exist" — no content download.
		createGetAttachmentMetadataTool(attachmentService),
	];

	// Session instance switching only makes sense when there's more than one
	// instance to switch between. A single-instance setup (env-based config always
	// yields exactly one; a one-entry YAML likewise) has nothing to switch to, so
	// the tool would just be noise — only expose it for a multi-instance config.
	if (instanceManager.getInstanceCount() > 1) {
		// Mutates the in-memory default only; no writes to any instance.
		tools.push(createSwitchDefaultInstanceTool(instanceManager, tableService));
		logger.info('Multi-instance config — sn_switch_default_instance tool enabled');
	} else {
		logger.info('Single instance — sn_switch_default_instance tool disabled');
	}

	// Local diagnostics/recovery are useful for both single- and multi-instance
	// configurations and do not make a ServiceNow API request themselves.
	tools.push(
		createConnectionStatusTool(instanceManager),
		createResetConnectionTool(instanceManager),
	);

	// Fluent SDK bridge: only expose when the now-sdk CLI is actually installed.
	if (isNowSdkAvailable()) {
		tools.push(createSdkStatusTool(instanceManager));
		logger.info('now-sdk detected — sn_sdk_status tool enabled');
	} else {
		logger.info('now-sdk not on PATH — sn_sdk_status tool disabled');
	}

	// Register every tool on the high-level McpServer. The Zod input/output
	// schemas are passed directly — the SDK advertises the JSON Schema, validates
	// input (bad input → self-correctable tool error, not a protocol throw), and
	// validates that a success result carries `structuredContent`.
	for (const tool of tools) {
		server.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				inputSchema: tool.inputSchema as never,
				outputSchema: tool.outputSchema as never,
				annotations: TOOL_ANNOTATIONS[tool.name],
			},
			withLogging(tool.name, tool.handler, server.server, instanceManager) as never,
		);
		logger.info(`Registered tool: ${tool.name}`);
	}

	logger.info(`Registered ${tools.length} ServiceNow tools`);
	logger.info(`Managing ${instanceManager.getInstanceCount()} ServiceNow instance(s)`);
}

/**
 * Register a degraded handler set used when configuration failed to load.
 *
 * The server still completes the MCP handshake (so the host stays connected
 * and the user isn't left with an opaque "Failed to connect"), but every tool
 * call returns the configuration error so the cause is visible in the client.
 */
export async function registerDegradedTools(
	server: McpServer,
	configError: Error | null,
): Promise<void> {
	const reason = configError?.message || 'now-mcp is not configured.';

	const message =
		'now-mcp is connected but not usable — configuration error:\n\n' +
		reason +
		`\n\n(server working directory: ${process.cwd()})` +
		'\n\nFix the config (plugin settings, or config/sn-credential.yaml, ' +
		'or the file at SERVICENOW_CONFIG_PATH) and reconnect the MCP server.';

	// Degraded mode still completes the handshake, but every capability is a
	// single status tool that reports the configuration error. Registering it via
	// the high-level `registerTool` keeps handshake, schema advertisement, and the
	// error path all on the supported McpServer API (rather than dropping to the
	// low-level request handlers, which is brittle across SDK upgrades).
	server.registerTool(
		'sn_status',
		{
			title: 'ServiceNow status',
			description:
				'Report the now-mcp status. In this session the server started in ' +
				'degraded mode because configuration failed to load; calling it returns ' +
				'the configuration error and how to fix it.',
			inputSchema: z.object({}).shape,
			outputSchema: z.object({ status: z.string(), error: z.string() }).shape,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		// outputSchema is declared, but an error result (isError:true, text only)
		// is allowed to omit structuredContent — same idiom the other tools use.
		async () => ({
			content: [{ type: 'text' as const, text: message }],
			isError: true as const,
		}),
	);

	logger.warn(
		'Registered DEGRADED handlers (configuration error). Tools will report the error until the config is fixed.',
	);
}
