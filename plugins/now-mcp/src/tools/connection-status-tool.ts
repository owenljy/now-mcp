import type { InstanceManager } from '../client/instance-manager.js';
import {
	ConnectionStatusOutputSchema,
	ConnectionStatusSchema,
	ResetConnectionOutputSchema,
	ResetConnectionSchema,
} from '../schemas/instance-schemas.js';
import { toolError } from '../utils/error-handler.js';
import { toolResult } from '../utils/tool-response.js';

export const CONNECTION_STATUS_TOOL = {
	name: 'sn_connection_status',
	title: 'ServiceNow connection status',
	description: `What: Inspect local authentication/backoff state and the configured background-script transport for ServiceNow instances without sending an API request.
When to use: After a 401, timeout, rate limit, or CIRCUIT_OPEN response to see whether requests are paused and when a trial is allowed.
Produces: Per-instance auth type, breaker state, failure counters, retry delay, and whether scripts select a configured Scripted REST path or sys_trigger. Never exposes credentials or tokens.`,
	inputSchema: ConnectionStatusSchema,
	outputSchema: ConnectionStatusOutputSchema,
};

export const RESET_CONNECTION_TOOL = {
	name: 'sn_reset_connection',
	title: 'Reset ServiceNow connection state',
	description: `What: Reload YAML-backed instance configuration and clients, then clear the selected instance's local circuit-breaker state and cached OAuth token.
When to use: After editing YAML credentials, roles, OAuth configuration, or connectivity. Plugin-form/environment credentials still require restarting the MCP because a running child process cannot receive later parent-environment changes.
Produces: The reset local state and whether configuration was reloaded. Reload is atomic: invalid YAML leaves the current clients unchanged. This does not change ServiceNow data or unlock an account.`,
	inputSchema: ResetConnectionSchema,
	outputSchema: ResetConnectionOutputSchema,
};

export function createConnectionStatusTool(instanceManager: InstanceManager) {
	return {
		...CONNECTION_STATUS_TOOL,
		handler: async (params: unknown) => {
			try {
				const { instance } = ConnectionStatusSchema.parse(params);
				const instances = instanceManager.getConnectionStatuses(instance);
				const scriptedRest = instances.filter(
					(item) => item.backgroundScriptTransport.transport === 'scripted_rest',
				).length;
				return toolResult(
					{ success: true, instances },
					`connection status: ${instances.length} instance(s); background scripts: ${scriptedRest} scripted_rest, ${instances.length - scriptedRest} sys_trigger`,
				);
			} catch (error) {
				return toolError(error, { operation: 'inspect connection status' });
			}
		},
	};
}

export function createResetConnectionTool(instanceManager: InstanceManager) {
	return {
		...RESET_CONNECTION_TOOL,
		handler: async (params: unknown) => {
			try {
				const { instance } = ResetConnectionSchema.parse(params);
				const connection = instanceManager.resetConnection(instance);
				const note = connection.configReloaded
					? `Reloaded ${connection.reloadedInstances} instance(s) from YAML and reset local connection state; subsequent requests use the new credentials.`
					: connection.authType === 'basic'
						? 'Local backoff was reset. Plugin-form/environment credentials cannot be refreshed in a running MCP process; restart now-mcp after changing them.'
						: 'Local backoff and cached OAuth token were cleared; the next API call will acquire a token. Restart now-mcp if plugin-form/environment credential values changed.';
				return toolResult(
					{ success: true, connection, note },
					`reset connection: ${connection.name}`,
				);
			} catch (error) {
				return toolError(error, { operation: 'reset connection' });
			}
		},
	};
}
