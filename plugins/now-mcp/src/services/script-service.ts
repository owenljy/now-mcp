/**
 * Script execution service for ServiceNow Scripted REST APIs
 */

import type { InstanceManager } from '../client/instance-manager.js';
import { ServiceNowError } from '../types/errors.js';
import { logger } from '../utils/logger.js';
import { validateWriteAccess } from '../utils/validators.js';

interface ScriptExecutionResult {
	success: boolean;
	output?: string;
	outputTruncated?: boolean;
	outputOriginalChars?: number;
	outputReturnedChars?: number;
	error?: string;
	runtimeIdentity?: ScriptRuntimeIdentity;
}

export interface ScriptRuntimeIdentity {
	userName?: string;
	userId?: string;
	roles?: string;
	isInteractive?: boolean;
}

export type ScriptExecutionTransport = 'scripted_rest' | 'sys_trigger';

export interface ScriptExecutionTransportStatus {
	transport: ScriptExecutionTransport;
	configuredPath: string | null;
	usesCompanionEndpoint: boolean;
	fallbackOnFailure: false;
	privilegeModel: 'configured_endpoint_context' | 'scheduled_job_context';
	diagnostic: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function phaseError(
	phase: string,
	method: string,
	endpoint: string,
	error: unknown,
	remediation?: string,
): ServiceNowError {
	const original = error instanceof ServiceNowError ? error : undefined;
	const suffix = remediation ? ` ${remediation}` : '';
	return new ServiceNowError(
		`Background-script ${phase} failed: ${method} ${endpoint}: ${errorMessage(error)}.${suffix}`,
		original?.statusCode,
		original?.servicenowError,
		'BACKGROUND_SCRIPT_TRANSPORT_ERROR',
	);
}

function parseScriptApiResponse(value: unknown, endpoint: string): ScriptExecutionResult {
	const result = (value as { result?: unknown } | null)?.result;
	if (
		typeof result !== 'object' ||
		result === null ||
		typeof (result as { success?: unknown }).success !== 'boolean'
	) {
		throw new ServiceNowError(
			`Background-script Scripted REST API returned an invalid response from POST ${endpoint}; expected { result: { success: boolean, output?: string, error?: string } }`,
			undefined,
			undefined,
			'BACKGROUND_SCRIPT_INVALID_RESPONSE',
		);
	}
	const typed = result as ScriptExecutionResult;
	if (typed.output !== undefined && typeof typed.output !== 'string') {
		throw new ServiceNowError(
			`Background-script Scripted REST API returned a non-string output from POST ${endpoint}`,
			undefined,
			undefined,
			'BACKGROUND_SCRIPT_INVALID_RESPONSE',
		);
	}
	if (typed.error !== undefined && typeof typed.error !== 'string') {
		throw new ServiceNowError(
			`Background-script Scripted REST API returned a non-string error from POST ${endpoint}`,
			undefined,
			undefined,
			'BACKGROUND_SCRIPT_INVALID_RESPONSE',
		);
	}
	if (
		typed.runtimeIdentity !== undefined &&
		(typeof typed.runtimeIdentity !== 'object' || typed.runtimeIdentity === null)
	) {
		throw new ServiceNowError(
			`Background-script Scripted REST API returned an invalid runtimeIdentity from POST ${endpoint}`,
			undefined,
			undefined,
			'BACKGROUND_SCRIPT_INVALID_RESPONSE',
		);
	}
	return typed;
}

export class ScriptService {
	constructor(private instanceManager: InstanceManager) {}

	/** Describe the selected transport without making a ServiceNow request. */
	getExecutionTransportStatus(instanceName?: string): ScriptExecutionTransportStatus {
		const config = this.instanceManager.getConfig(instanceName);
		if (config.scriptApiPath) {
			return {
				transport: 'scripted_rest',
				configuredPath: config.scriptApiPath,
				usesCompanionEndpoint: true,
				fallbackOnFailure: false,
				privilegeModel: 'configured_endpoint_context',
				diagnostic:
					`Background scripts POST to ${config.scriptApiPath}. The resource must be installed, active, reachable, and permitted for the integration user. ` +
					'The MCP does not elevate roles or fall back to sys_trigger when this configured endpoint fails.',
			};
		}
		return {
			transport: 'sys_trigger',
			configuredPath: null,
			usesCompanionEndpoint: false,
			fallbackOnFailure: false,
			privilegeModel: 'scheduled_job_context',
			diagnostic:
				'Background scripts use a sys_properties mailbox and sys_trigger. The integration user needs access to those records; ServiceNow determines runtime context, so this is not an MCP role-escalation mechanism.',
		};
	}

	/**
	 * Execute arbitrary server-side JavaScript using the configured Scripted REST
	 * resource, or sys_trigger when scriptApiPath is omitted.
	 * The selected ServiceNow transport determines runtime privileges; allowWrites
	 * and this service do not grant roles or bypass ACLs.
	 *
	 * @param script JavaScript code to execute
	 * @param timeout Maximum execution time in milliseconds (default: 60000)
	 * @param instance Optional instance name (uses default if not specified)
	 * @returns Execution result including output and status
	 */
	async executeBackgroundScript(
		script: string,
		timeout: number = 60000,
		instance?: string,
		mirrorOutputToSystemLog = false,
	): Promise<{
		success: boolean;
		output?: string;
		error?: string;
		executionTime: number;
		executionPath: 'scripted-rest' | 'sys_trigger';
		outcome: 'completed' | 'script_failed' | 'timed_out';
		runtimeIdentity?: ScriptRuntimeIdentity;
		outputTruncated?: boolean;
		outputOriginalChars?: number;
		outputReturnedChars?: number;
	}> {
		validateWriteAccess(this.instanceManager, instance);
		const client = this.instanceManager.getClient(instance);
		const config = this.instanceManager.getConfig(instance);
		const startTime = Date.now();

		logger.info('Executing background script', {
			scriptLength: script.length,
			timeout,
			instance: instance || 'default',
			path: config.scriptApiPath ? 'scripted-rest' : 'sys_trigger',
		});

		// Fast path: Scripted REST API executes synchronously without the scheduler.
		// Requires the companion REST API installed on the instance.
		// Expected contract: POST scriptApiPath {script} → {result: {success, output?, error?}}
		if (config.scriptApiPath) {
			try {
				const response = await client.post<unknown>(config.scriptApiPath, { script });
				const executionTime = Date.now() - startTime;
				const r = parseScriptApiResponse(response, config.scriptApiPath);
				logger.info('Background script completed via Scripted REST', {
					success: r.success,
					executionTime,
				});
				return {
					success: r.success,
					output: r.output,
					error: r.error,
					runtimeIdentity: r.runtimeIdentity,
					executionTime,
					executionPath: 'scripted-rest',
					outcome: r.success ? 'completed' : 'script_failed',
				};
			} catch (error) {
				const executionTime = Date.now() - startTime;
				logger.error('Background script failed via Scripted REST', { error, executionTime });
				if (
					error instanceof ServiceNowError &&
					error.code === 'BACKGROUND_SCRIPT_INVALID_RESPONSE'
				) {
					throw error;
				}
				const detail = errorMessage(error);
				const statusCode = error instanceof ServiceNowError ? error.statusCode : undefined;
				const endpointUnavailable =
					statusCode === 404 || /Requested URI does not represent any resource/i.test(detail);
				throw new ServiceNowError(
					`Background-script Scripted REST execution transport failed: POST ${config.scriptApiPath}: ${detail}. ` +
						(endpointUnavailable
							? 'The configured route is unavailable on this instance (missing, inactive, or its namespace/resource path does not match). '
							: 'The configured route did not complete the request. ') +
						'This endpoint/configuration failure occurred before the submitted script ran; allowWrites does not affect it or elevate the integration user. ' +
						'now-mcp will not silently switch transports. Verify/install/activate the resource and its execute ACL, or remove scriptApiPath to intentionally select sys_trigger and satisfy its sys_properties/sys_trigger prerequisites.',
					statusCode,
					error,
					endpointUnavailable
						? 'BACKGROUND_SCRIPT_ENDPOINT_UNAVAILABLE'
						: 'BACKGROUND_SCRIPT_TRANSPORT_ERROR',
				);
			}
		}

		try {
			// Fallback path: sys_trigger (requires active ServiceNow scheduler).
			//
			// Design: "Run Once" triggers (type 0) are DELETED by the scheduler after
			// execution, so we can't read results from the trigger record. Instead, use
			// sys_properties as a stable output mailbox that survives scheduler cleanup.
			//
			// Flow:
			//   1. Create sys_properties record (status=pending) as the output channel.
			//   2. Create Run Once sys_trigger whose script writes to that property.
			//   3. Poll the property record until status=done.
			//   4. Clean up the property (trigger is already gone after execution).

			const triggerName = `mcp_script_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
			const propKey = `mcp.script.output.${triggerName}`;

			// Step 1: Create the sys_properties mailbox.
			const mailboxEndpoint = '/api/now/table/sys_properties';
			let propCreate: { result: { sys_id: string } };
			try {
				propCreate = await client.post<{ result: { sys_id: string } }>(mailboxEndpoint, {
					name: propKey,
					value: JSON.stringify({ status: 'pending' }),
					description: 'Temporary MCP background-script output buffer — safe to delete',
					type: 'string',
				});
			} catch (error) {
				throw phaseError(
					'mailbox creation',
					'POST',
					mailboxEndpoint,
					error,
					'The sys_trigger fallback requires Table API create/read/delete access to sys_properties. Configure a working scriptApiPath when protected system tables are not exposed.',
				);
			}
			const propSysId = propCreate.result.sys_id;
			if (!propSysId) {
				throw new ServiceNowError(
					`Background-script mailbox creation returned no sys_id from POST ${mailboxEndpoint}`,
					undefined,
					undefined,
					'BACKGROUND_SCRIPT_INVALID_RESPONSE',
				);
			}
			logger.debug(`Created sys_properties mailbox: ${propKey}`);

			// Step 2: Build and create the Run Once trigger.
			// gs is a Java-backed object in Rhino — assigning gs.log = function(){} silently
			// fails. Instead we define a log() helper in the wrapper scope and rewrite any
			// gs.log( / gs.info( / gs.print( calls in the user script to log() before inlining.
			// gs.print is a global-scope-only API (blocked/swallowed in scoped scripts), so we
			// normalize it here too — a user who pastes gs.print still gets captured output, and
			// the canonical scoped-safe call is gs.info (see the tool description's runtime contract).
			// sys_properties.value is limited to 4000 chars; truncate output to stay safe.
			const rewrittenScript = script
				.replace(/\bgs\.log\s*\(/g, 'log(')
				.replace(/\bgs\.info\s*\(/g, 'log(')
				.replace(/\bgs\.print\s*\(/g, 'log(');

			const wrappedScript = `
        (function() {
          var __key = '${propKey}';
          var __output = [];
		  var __runtimeIdentity = {};
		  try { __runtimeIdentity.userName = String(gs.getUserName()).substring(0, 160); } catch (ignore) {}
		  try { __runtimeIdentity.userId = String(gs.getUserID()).substring(0, 64); } catch (ignore) {}
		  try { __runtimeIdentity.roles = String(gs.getUser().getRoles()).substring(0, 800); } catch (ignore) {}
		  try { __runtimeIdentity.isInteractive = !!gs.getSession().isInteractive(); } catch (ignore) {}
          // log() is the output capture helper. gs.log/gs.info in the user script
          // have been rewritten to call this automatically.
		  var log = function(msg) { var s = String(msg); __output.push(s); ${mirrorOutputToSystemLog ? `gs.log('[now-mcp ${triggerName}] ' + s);` : ''} };
          try {
            ${rewrittenScript}
            var __gr = new GlideRecord('sys_properties');
            if (__gr.get('name', __key)) {
              __gr.setValue('value', JSON.stringify({
				status: 'done', success: true, runtimeIdentity: __runtimeIdentity,
				output: (function(){ var s = __output.join('\\n'); return s.substring(0, 2700); })(),
				// Compatibility marker: output truncated at 2700 chars. Numeric fields below are authoritative.
				outputTruncated: __output.join('\\n').length > 2700,
				outputOriginalChars: __output.join('\\n').length,
				outputReturnedChars: Math.min(__output.join('\\n').length, 2700)
              }));
              __gr.update();
            }
          } catch (e) {
            var __gr = new GlideRecord('sys_properties');
            if (__gr.get('name', __key)) {
              __gr.setValue('value', JSON.stringify({
				status: 'done', success: false, runtimeIdentity: __runtimeIdentity,
				error: String(e).substring(0, 2700)
              }));
              __gr.update();
            }
          }
        })();
      `;

			const nowSN = new Date().toISOString().slice(0, 19).replace('T', ' ');
			const triggerEndpoint = '/api/now/table/sys_trigger';
			try {
				await client.post(triggerEndpoint, {
					name: triggerName,
					trigger_type: '0', // Run Once — scheduler picks up and deletes after execution
					next_action: nowSN,
					script: wrappedScript,
					active: true,
				});
			} catch (error) {
				// The trigger was never created, so remove the mailbox immediately.
				try {
					await client.delete(`${mailboxEndpoint}/${propSysId}`);
				} catch (cleanupError) {
					logger.warn('Failed to clean up mailbox after trigger creation failure', {
						propKey,
						error: cleanupError,
					});
				}
				throw phaseError(
					'trigger creation',
					'POST',
					triggerEndpoint,
					error,
					'The sys_trigger fallback requires Table API create access to sys_trigger. Configure a working scriptApiPath when this protected table is not exposed.',
				);
			}
			logger.debug(`Created sys_trigger (Run Once): ${triggerName}`);

			// Step 3: Poll sys_properties until status=done or timeout.
			const pollInterval = 500;
			const deadline = startTime + timeout;
			let result: ScriptExecutionResult | null = null;

			while (Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, pollInterval));

				const pollEndpoint = `${mailboxEndpoint}/${propSysId}`;
				let propPoll: { result: { value: string } };
				try {
					propPoll = await client.get<{ result: { value: string } }>(pollEndpoint, {
						sysparm_fields: 'value',
					});
				} catch (error) {
					try {
						await client.delete(pollEndpoint);
					} catch (cleanupError) {
						logger.warn('Failed to clean up mailbox after polling failure', {
							propKey,
							error: cleanupError,
						});
					}
					throw phaseError('mailbox polling', 'GET', pollEndpoint, error);
				}

				try {
					const data = JSON.parse(propPoll.result.value);
					if (data.status === 'done') {
						result = data;
						break;
					}
				} catch {
					// Not valid JSON yet — keep polling
				}
			}

			// Step 4: Clean up sys_properties (trigger is already deleted by scheduler).
			try {
				await client.delete(`${mailboxEndpoint}/${propSysId}`);
				logger.debug(`Cleaned up sys_properties mailbox: ${propKey}`);
			} catch (cleanupError) {
				logger.warn('Failed to clean up sys_properties mailbox', { propKey, error: cleanupError });
			}

			const executionTime = Date.now() - startTime;

			if (!result) {
				logger.error('Background script execution timed out', { timeout, executionTime });
				return {
					success: false,
					error: `Script execution timed out after ${executionTime}ms. The sys_trigger (Run Once) was created but the ServiceNow scheduler did not execute it within the timeout. Check that the scheduler is running: System Diagnostics > Scheduler.`,
					executionTime,
					executionPath: 'sys_trigger',
					outcome: 'timed_out',
				};
			}

			logger.info('Background script execution completed', {
				success: result.success,
				executionTime,
				instance: instance || 'default',
			});

			return {
				success: result.success,
				output: result.output,
				outputTruncated: result.outputTruncated,
				outputOriginalChars: result.outputOriginalChars,
				outputReturnedChars: result.outputReturnedChars,
				error: result.error,
				executionTime,
				executionPath: 'sys_trigger',
				outcome: result.success ? 'completed' : 'script_failed',
				runtimeIdentity: result.runtimeIdentity,
			};
		} catch (error) {
			const executionTime = Date.now() - startTime;
			logger.error('Background script execution failed', {
				error,
				executionTime,
				instance: instance || 'default',
			});
			throw error;
		}
	}
}
