/**
 * Instance Manager for handling multiple ServiceNow instances
 */

import type { ConfigSource } from '../config/environment.js';
import { ServiceNowError } from '../types/errors.js';
import type { InstanceConfig, InstanceStatus } from '../types/instance.js';
import { logger } from '../utils/logger.js';
import { ServiceNowClient } from './servicenow-client.js';

/** A concrete, internally consistent instance selection. */
export interface ResolvedInstance {
	name: string;
	config: InstanceConfig;
	client: ServiceNowClient;
}

/**
 * Manages multiple ServiceNow client instances
 */
export class InstanceManager {
	private clients: Map<string, ServiceNowClient> = new Map();
	private configs: Map<string, InstanceConfig> = new Map();
	private defaultInstance: string;
	/**
	 * True while the post-handshake now-sdk probe is deciding whether the YAML
	 * default should move. Reads may continue, but an unqualified write must not
	 * race this decision and land on the wrong instance.
	 */
	private defaultAlignmentPending = false;
	/** Where the config came from — for source-aware runtime error guidance. */
	private readonly configSource?: ConfigSource;

	/**
	 * Creates a new InstanceManager
	 * @param instances Array of instance configurations
	 * @param configSource Where the config was resolved from (optional)
	 * @throws {ServiceNowError} If no default instance is specified or instance names are not unique
	 */
	constructor(instances: InstanceConfig[], configSource?: ConfigSource) {
		this.configSource = configSource;
		if (instances.length === 0) {
			throw new ServiceNowError('At least one instance configuration is required', 400);
		}

		// Validate unique instance names
		const names = instances.map((i) => i.name);
		const uniqueNames = new Set(names);
		if (names.length !== uniqueNames.size) {
			throw new ServiceNowError('Instance names must be unique', 400);
		}

		// Find default instance
		const defaultInstances = instances.filter((i) => i.default);
		if (defaultInstances.length === 0) {
			throw new ServiceNowError('Exactly one instance must be marked as default', 400);
		}
		if (defaultInstances.length > 1) {
			throw new ServiceNowError('Only one instance can be marked as default', 400);
		}

		this.defaultInstance = defaultInstances[0].name;

		// Initialize clients for each instance
		for (const config of instances) {
			try {
				const client = new ServiceNowClient(config.url, config.auth, (config.timeout ?? 30) * 1000);

				this.clients.set(config.name, client);
				this.configs.set(config.name, config);

				logger.info(`Initialized ServiceNow instance: ${config.name}`, {
					url: config.url,
					authType: config.auth.type,
					default: config.default,
				});
			} catch (error) {
				logger.error(`Failed to initialize instance ${config.name}`, { error });
				throw new ServiceNowError(
					`Failed to initialize instance ${config.name}: ${error instanceof Error ? error.message : String(error)}`,
					500,
				);
			}
		}
	}

	/**
	 * Get a ServiceNow client for a specific instance
	 * @param instanceName Optional instance name. If not provided, returns the default instance
	 * @returns ServiceNowClient for the specified instance
	 * @throws {ServiceNowError} If the instance name is invalid
	 */
	getClient(instanceName?: string): ServiceNowClient {
		return this.resolveInstance(instanceName).client;
	}

	/**
	 * Get the configuration for a specific instance
	 * @param instanceName Optional instance name. If not provided, returns the default instance config
	 * @returns InstanceConfig for the specified instance
	 */
	getConfig(instanceName?: string): InstanceConfig {
		return this.resolveInstance(instanceName).config;
	}

	/**
	 * Resolve an optional selector to one concrete target. Consumers that need
	 * the client and its identity should use this once rather than independently
	 * resolving "default" for requests, cache keys, logs, and responses.
	 */
	resolveInstance(instanceName?: string): ResolvedInstance {
		const name = instanceName || this.defaultInstance;
		const client = this.clients.get(name);
		const config = this.configs.get(name);
		if (!client || !config) {
			const availableInstances = Array.from(this.clients.keys()).join(', ');
			throw new ServiceNowError(
				`Instance '${name}' not found. Available instances: ${availableInstances}`,
				400,
			);
		}
		return { name, config, client };
	}

	/**
	 * Where the config was resolved from (env fast-path vs a YAML file). Used to
	 * give source-specific remediation when a write is blocked.
	 */
	getConfigSource(): ConfigSource | undefined {
		return this.configSource;
	}

	/**
	 * List all available instance names
	 * @returns Array of instance names
	 */
	listInstances(): string[] {
		return Array.from(this.clients.keys());
	}

	/**
	 * Get the default instance name
	 * @returns Name of the default instance
	 */
	getDefaultInstance(): string {
		return this.defaultInstance;
	}

	/** Mark the runtime default as temporarily unsafe for implicit writes. */
	beginDefaultAlignment(): void {
		this.defaultAlignmentPending = true;
	}

	/** Whether an automatic default-selection probe is still in flight. */
	isDefaultAlignmentPending(): boolean {
		return this.defaultAlignmentPending;
	}

	/**
	 * Finish the automatic alignment, optionally selecting the matched instance.
	 * A manual switch cancels the pending probe, so a late background result can
	 * never override an explicit user choice.
	 */
	completeDefaultAlignment(instanceName?: string): boolean {
		if (!this.defaultAlignmentPending) return false;
		if (instanceName) this.assertManagedInstance(instanceName);
		if (instanceName) this.defaultInstance = instanceName;
		this.defaultAlignmentPending = false;
		return true;
	}

	/**
	 * Check if an instance exists
	 * @param instanceName Instance name to check
	 * @returns True if instance exists, false otherwise
	 */
	hasInstance(instanceName: string): boolean {
		return this.clients.has(instanceName);
	}

	/**
	 * Switch the in-memory default instance for the current session.
	 * Persistence to the YAML is handled separately by the caller.
	 * @param instanceName Name of a managed instance to make default
	 * @throws {ServiceNowError} If the instance name is not managed
	 */
	setDefaultInstance(instanceName: string): void {
		this.assertManagedInstance(instanceName);
		this.defaultInstance = instanceName;
		// An explicit switch wins over an in-flight automatic follow probe.
		this.defaultAlignmentPending = false;
	}

	private assertManagedInstance(instanceName: string): void {
		if (this.clients.has(instanceName)) return;
		const available = Array.from(this.clients.keys()).join(', ');
		throw new ServiceNowError(
			`Instance '${instanceName}' not found. Available instances: ${available}`,
			400,
		);
	}

	/**
	 * Validate connections to all instances
	 * @returns Array of instance statuses
	 */
	async validateConnections(): Promise<InstanceStatus[]> {
		// Probe every instance concurrently — a slow/unreachable one shouldn't
		// serialize behind the others (total time becomes max, not sum, of probes).
		return Promise.all(
			Array.from(this.clients.entries()).map(async ([name, client]) => {
				const status: InstanceStatus = {
					name,
					connected: false,
					lastChecked: new Date(),
				};

				try {
					// Lightweight query to sys_user (limit 1) just to confirm reachability.
					await client.query('sys_user', '', 1, 0);
					status.connected = true;
					logger.info(`Connection validated for instance: ${name}`);
				} catch (error) {
					status.connected = false;
					status.error = error instanceof Error ? error.message : String(error);
					logger.warn(`Connection validation failed for instance: ${name}`, {
						error: status.error,
					});
				}

				return status;
			}),
		);
	}

	/**
	 * Get the total number of managed instances
	 * @returns Number of instances
	 */
	getInstanceCount(): number {
		return this.clients.size;
	}

	/** Secret-free runtime connection state for one or every configured instance. */
	getConnectionStatuses(instanceName?: string) {
		const names = instanceName ? [this.resolveInstance(instanceName).name] : this.listInstances();
		return names.map((name) => {
			const { config, client } = this.resolveInstance(name);
			return {
				name,
				url: config.url,
				isDefault: name === this.defaultInstance,
				authType: client.getAuthType(),
				backgroundScriptTransport: config.scriptApiPath
					? {
							transport: 'scripted_rest' as const,
							configuredPath: config.scriptApiPath,
							usesCompanionEndpoint: true,
							fallbackOnFailure: false,
							privilegeModel: 'configured_endpoint_context' as const,
							diagnostic:
								`Background scripts POST to ${config.scriptApiPath}. The resource must be installed, active, reachable, and permitted for the integration user. ` +
								'The MCP does not elevate roles or fall back to sys_trigger when this configured endpoint fails.',
						}
					: {
							transport: 'sys_trigger' as const,
							configuredPath: null,
							usesCompanionEndpoint: false,
							fallbackOnFailure: false,
							privilegeModel: 'scheduled_job_context' as const,
							diagnostic:
								'Background scripts use a sys_properties mailbox and sys_trigger. The integration user needs access to those records; ServiceNow determines runtime context, so this is not an MCP role-escalation mechanism.',
						},
				...client.getConnectionStatus(),
			};
		});
	}

	/** Reset local token/backoff state. Configuration itself is unchanged. */
	resetConnection(instanceName?: string) {
		const resolved = this.resolveInstance(instanceName);
		return {
			name: resolved.name,
			url: resolved.config.url,
			authType: resolved.client.getAuthType(),
			...resolved.client.resetConnection(),
		};
	}
}
