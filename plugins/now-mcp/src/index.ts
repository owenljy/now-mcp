#!/usr/bin/env node

/**
 * now-mcp — Entry Point
 * Enables Claude to interact with ServiceNow instances via Model Context Protocol
 *
 * Startup is built for resilience: the MCP handshake completes first, config
 * problems degrade (rather than crash), connection checks run in the background,
 * and stray errors are logged instead of taking down the session.
 */

// stdout belongs to the MCP protocol. Route any accidental stdout writes (a
// stray console.log, a noisy dependency) to stderr so they can't corrupt the
// stream. The SDK transport writes to process.stdout directly, so this is safe.
// eslint-disable-next-line no-console
console.log = (...args: unknown[]) => console.error(...args);

import { InstanceManager } from './client/instance-manager.js';
import { exampleConfigPath, loadConfig, resolveNowSdkFollow } from './config/environment.js';
import { createServer, startServer } from './server.js';
import { initializeLogger, logger } from './utils/logger.js';

async function main() {
	let instanceManager: InstanceManager | null = null;
	let configError: Error | null = null;

	// 1. Load config. On failure, capture the error and degrade — do NOT exit,
	//    so the client still connects and sees the reason.
	try {
		const config = loadConfig();
		initializeLogger(config.logLevel);
		logger.info('Configuration loaded', {
			instanceCount: config.instances.length,
			defaultInstance: config.instances.find((i) => i.default)?.name,
			source: config.source.kind === 'yaml' ? config.source.path : 'env/plugin-form',
		});
		// Plugin-form / env installs have no YAML. Point at the annotated template
		// once, so anyone who later needs OAuth or multiple instances knows it exists.
		if (config.source.kind === 'env') {
			logger.info(
				`For OAuth / multiple instances, copy the YAML template and set SERVICENOW_CONFIG_PATH: ${exampleConfigPath()}`,
			);
		}
		instanceManager = new InstanceManager(config.instances, config.source);
		// Auto-follow is resolved after the handshake. Until it settles, block only
		// writes that omit `instance`; explicit targets and all reads remain usable.
		if (
			instanceManager.getInstanceCount() > 1 &&
			!process.env.SERVICENOW_FOLLOW_NOW_SDK?.trim().match(/^(0|false|no|off)$/i)
		) {
			instanceManager.beginDefaultAlignment();
		}
	} catch (error) {
		initializeLogger('info');
		configError = error instanceof Error ? error : new Error(String(error));
		logger.error(
			'Configuration error — starting in DEGRADED mode (connection stays up, tools report the error)',
			configError,
		);
	}

	// 2. Start serving immediately. Never block the handshake on network checks
	//    or now-sdk probes.
	const server = await createServer(instanceManager, configError);
	await startServer(server);
	logger.info('now-mcp server is running');

	// 3. Post-start background work. None of this may block the handshake: the
	//    now-sdk follow probe (~3s) and per-instance connection checks all run
	//    AFTER the server is already serving. Problems surface as per-tool errors.
	if (instanceManager) {
		const im = instanceManager;

		// 3a. Follow now-sdk (on by default): re-point the default instance to the
		//     one now-sdk is set to. This spawns now-sdk, hence it runs here rather
		//     than in loadConfig. Best-effort; keeps the YAML default on any miss.
		try {
			const configured = im.listInstances().map((name) => ({ name, url: im.getConfig(name).url }));
			const followTo = resolveNowSdkFollow(configured);
			const previousDefault = im.getDefaultInstance();
			const applied = im.completeDefaultAlignment(followTo ?? undefined);
			if (applied && followTo && followTo !== previousDefault) {
				logger.info(`Default instance re-pointed to '${followTo}' to follow now-sdk.`);
			}
		} catch (e) {
			im.completeDefaultAlignment();
			logger.warn('follow-now-sdk check failed; keeping YAML default', {
				error: e instanceof Error ? e.message : String(e),
			});
		}

		// 3b. Validate connections concurrently — one slow instance shouldn't serialize
		//     behind the others (sum(timeout) → max(timeout)).
		im.validateConnections()
			.then((results) => {
				for (const s of results) {
					if (s.connected) logger.info(`Instance ${s.name}: connected ✓`);
					else logger.warn(`Instance ${s.name}: not reachable`, { error: s.error });
				}
				if (results.filter((r) => r.connected).length === 0) {
					logger.warn(
						'No instances are currently reachable — tools will report connection errors until resolved.',
					);
				}
			})
			.catch((e) =>
				logger.warn('Background connection validation failed', {
					error: e instanceof Error ? e.message : String(e),
				}),
			);
	}
}

// Keep the server alive through stray errors — one bad tool call or rejected
// promise must not drop the whole MCP session.
process.on('uncaughtException', (error) => {
	logger.error('Uncaught exception (continuing)', error);
});
process.on('unhandledRejection', (reason) => {
	logger.error('Unhandled promise rejection (continuing)', {
		reason: reason instanceof Error ? reason.message : reason,
	});
});

// Graceful shutdown on signals.
process.on('SIGINT', () => {
	logger.info('Received SIGINT, shutting down...');
	process.exit(0);
});
process.on('SIGTERM', () => {
	logger.info('Received SIGTERM, shutting down...');
	process.exit(0);
});

// Only a failure to even start serving (e.g. the stdio transport) is fatal.
main().catch((error) => {
	logger.error('Fatal: MCP server could not start', error);
	process.exit(1);
});
