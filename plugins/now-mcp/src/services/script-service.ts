/**
 * Script execution service for ServiceNow Scripted REST APIs
 */

import type { InstanceManager } from '../client/instance-manager.js';
import { ServiceNowError } from '../types/errors.js';
import { logger } from '../utils/logger.js';
import {
	chunkWriterSource,
	MAX_CHUNKS,
	type MailboxEnvelope,
	reassembleChunks,
} from '../utils/mailbox-protocol.js';
import { nextPollDelayMs } from '../utils/poll-schedule.js';
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

/**
 * Where the wall-clock time of a sys_trigger execution actually went.
 *
 * The old response reported `queueDelayMs` as the entire duration, which made
 * a 31-second call look like 31 seconds of *work* when nearly all of it was the
 * scheduler queue and the script itself ran in well under a second. That framing
 * invites the wrong optimization (simplify the script) instead of the right one
 * (install the Scripted REST fast path).
 */
export interface ScriptTransportTimings {
	/** Everything, start to finish, as measured in this process. */
	totalDurationMs: number;
	/**
	 * Time before the script began running, DERIVED: total minus the measured
	 * script duration and cleanup. It is named "observed" because this process
	 * cannot see the scheduler's own clock — it bounds the queue wait from
	 * outside rather than reading it. Absent when the script did not report its
	 * own duration, since the subtraction would then be meaningless.
	 */
	observedSchedulerWaitMs?: number;
	/** Measured inside the trigger, around the script body only. */
	scriptDurationMs?: number;
	/** Time spent deleting the mailbox parent and chunk properties. */
	cleanupDurationMs: number;
	/** Mailbox reads issued. The headline number for polling efficiency. */
	pollCount: number;
}

/** Injection seam for tests: lets a suite drive polling without real waiting. */
export interface ScriptServiceOptions {
	sleep?: (ms: number) => Promise<void>;
	random?: () => number;
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
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly random: () => number;

	constructor(
		private instanceManager: InstanceManager,
		options: ScriptServiceOptions = {},
	) {
		this.sleep =
			options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.random = options.random ?? Math.random;
	}

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
	 * Fetch this execution's output chunks in one request.
	 *
	 * One query rather than N GETs: the chunk count can reach MAX_CHUNKS, and
	 * paying a round trip each would reintroduce on the read side the latency the
	 * chunking exists to justify. Order is not trusted from the response —
	 * reassembleChunks sorts by the index encoded in each name.
	 */
	private async readChunks(
		client: { get: <T>(endpoint: string, params?: Record<string, unknown>) => Promise<T> },
		propKey: string,
		chunkCount: number,
	): Promise<Array<{ name?: string; value?: string }>> {
		if (chunkCount <= 0) return [];
		try {
			const resp = await client.get<{ result: Array<{ name?: string; value?: string }> }>(
				'/api/now/table/sys_properties',
				{
					sysparm_query: `nameSTARTSWITH${propKey}.chunk.`,
					sysparm_fields: 'name,value',
					sysparm_limit: MAX_CHUNKS,
				},
			);
			return resp.result ?? [];
		} catch (error) {
			// Returning [] lets reassembleChunks report every chunk as missing, which
			// surfaces as an explicit incomplete-output error. Throwing here would
			// instead discard a script result that did run.
			logger.warn('Failed to read background-script output chunks', {
				propKey,
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		}
	}

	/**
	 * Remove the mailbox parent and every chunk property.
	 *
	 * Deletes by name query rather than by remembered sys_id because the chunks
	 * are created on the INSTANCE by the trigger — this process never learns
	 * their sys_ids. Best-effort throughout: leaked temporary properties are
	 * untidy, but failing a completed execution over cleanup would be worse.
	 */
	private async cleanupMailbox(
		client: {
			get: <T>(endpoint: string, params?: Record<string, unknown>) => Promise<T>;
			delete: (endpoint: string) => Promise<unknown>;
		},
		parentSysId: string,
		propKey: string,
		expectedChunks: number,
	): Promise<void> {
		const endpoint = '/api/now/table/sys_properties';
		try {
			await client.delete(`${endpoint}/${parentSysId}`);
		} catch (error) {
			logger.warn('Failed to clean up sys_properties mailbox parent', { propKey, error });
		}

		if (expectedChunks <= 0) return;
		try {
			// Re-query instead of assuming indices 0..n-1: a partial write or a
			// timeout means the set on the instance may not match what the envelope
			// claimed, and an orphaned chunk is exactly what must not survive.
			const resp = await client.get<{ result: Array<{ sys_id?: string }> }>(endpoint, {
				sysparm_query: `nameSTARTSWITH${propKey}.chunk.`,
				sysparm_fields: 'sys_id',
				sysparm_limit: MAX_CHUNKS,
			});
			for (const row of resp.result ?? []) {
				if (!row.sys_id) continue;
				try {
					await client.delete(`${endpoint}/${row.sys_id}`);
				} catch (error) {
					logger.warn('Failed to clean up a background-script output chunk', {
						propKey,
						error,
					});
				}
			}
		} catch (error) {
			logger.warn('Failed to enumerate background-script output chunks for cleanup', {
				propKey,
				error,
			});
		}
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
		/** sys_trigger path only — the scripted-REST path has no queue to report. */
		timings?: ScriptTransportTimings;
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
			// Output no longer goes inline into the parent property: that column holds
			// 4000 chars and the old wrapper reserved 2700 of them, cutting output at
			// the SOURCE before the tool's own 8000-char render cap could apply. The
			// payload now goes to indexed chunk properties (mailbox-protocol.ts) and
			// the parent carries only the status envelope and the chunk count.
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
          ${chunkWriterSource('__key')}
          // Publish the envelope in ONE update so a poller can never observe
          // status=done before the chunks it promises exist.
          var __finish = function(envelope) {
            var __gr = new GlideRecord('sys_properties');
            if (__gr.get('name', __key)) {
              __gr.setValue('value', JSON.stringify(envelope));
              __gr.update();
            }
          };
          var __started = new Date().getTime();
          try {
            ${rewrittenScript}
            var __elapsed = new Date().getTime() - __started;
            var __w = __writeChunks(__output.join('\\n'));
            __finish({
              status: 'done', success: true, runtimeIdentity: __runtimeIdentity,
              chunkCount: __w.count,
              outputTruncated: __w.truncated,
              outputOriginalChars: __w.originalChars,
              outputReturnedChars: __w.returnedChars,
              chunkWriteFailed: __w.failed,
              scriptDurationMs: __elapsed
            });
          } catch (e) {
            var __elapsedErr = new Date().getTime() - __started;
            // The error body is chunked too: a stack trace from a deep call chain
            // routinely exceeded the old 2700-char inline cap, so the diagnostic
            // most needed on a failure was the one most likely to be cut.
            var __we = __writeChunks(String(e));
            __finish({
              status: 'done', success: false, runtimeIdentity: __runtimeIdentity,
              chunkCount: __we.count,
              outputTruncated: __we.truncated,
              outputOriginalChars: __we.originalChars,
              outputReturnedChars: __we.returnedChars,
              chunkWriteFailed: __we.failed,
              isErrorPayload: true,
              scriptDurationMs: __elapsedErr
            });
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

			// Step 3: Poll sys_properties until status=done or timeout, backing off as
			// the wait grows. Measured scheduler latency has a ~31s median, so a flat
			// 500ms interval spent ~60 requests per call reading an empty mailbox.
			const deadline = startTime + timeout;
			let envelope: MailboxEnvelope | null = null;
			let pollCount = 0;

			while (Date.now() < deadline) {
				await this.sleep(nextPollDelayMs(Date.now() - startTime, this.random));

				const pollEndpoint = `${mailboxEndpoint}/${propSysId}`;
				let propPoll: { result: { value: string } };
				pollCount++;
				try {
					propPoll = await client.get<{ result: { value: string } }>(pollEndpoint, {
						sysparm_fields: 'value',
					});
				} catch (error) {
					// Clean up everything, not just the parent: chunks may already have
					// been written by a trigger that ran while polling was failing.
					await this.cleanupMailbox(client, propSysId, propKey, MAX_CHUNKS);
					throw phaseError('mailbox polling', 'GET', pollEndpoint, error);
				}

				try {
					const data = JSON.parse(propPoll.result.value) as MailboxEnvelope;
					if (data.status === 'done') {
						envelope = data;
						break;
					}
				} catch {
					// Not valid JSON yet — keep polling
				}
			}

			// Step 4: Collect the payload, then clean up parent + chunks. Reading
			// happens BEFORE cleanup for the obvious reason, and cleanup happens on
			// every path below (including timeout) so a partially-written chunk set
			// from a late-running trigger cannot be left behind.
			let payload = '';
			let reassemblyError: string | undefined;
			if (envelope && (envelope.chunkCount ?? 0) > 0) {
				const chunks = await this.readChunks(client, propKey, envelope.chunkCount ?? 0);
				const reassembled = reassembleChunks(propKey, envelope.chunkCount ?? 0, chunks);
				payload = reassembled.payload;
				reassemblyError = reassembled.error;
			} else if (envelope) {
				// Legacy single-mailbox shape: a trigger created by a previous build,
				// still in flight across an upgrade. Its payload sits inline.
				payload = (envelope.success ? envelope.output : envelope.error) ?? '';
			}

			// Only enumerate chunks when some can exist. Three cases:
			//  - no envelope (timeout): the trigger may still run and write chunks
			//    after we stop waiting, so sweep for them.
			//  - chunkWriteFailed: the count is unreliable; sweep.
			//  - legacy envelope (no chunkCount at all): the old wrapper never wrote
			//    chunks, so a sweep would be a wasted round trip on every call.
			const chunksPossible =
				!envelope || envelope.chunkWriteFailed === true || (envelope.chunkCount ?? 0) > 0;
			const cleanupStart = Date.now();
			await this.cleanupMailbox(client, propSysId, propKey, chunksPossible ? MAX_CHUNKS : 0);
			const cleanupDurationMs = Date.now() - cleanupStart;

			const executionTime = Date.now() - startTime;
			const scriptDurationMs = envelope?.scriptDurationMs;
			const timings: ScriptTransportTimings = {
				totalDurationMs: executionTime,
				...(typeof scriptDurationMs === 'number'
					? {
							scriptDurationMs,
							// Derived, not observed directly — this process cannot read the
							// scheduler's clock. Floored at 0 so clock skew between the
							// instance and this host can never produce a negative wait.
							observedSchedulerWaitMs: Math.max(
								0,
								executionTime - scriptDurationMs - cleanupDurationMs,
							),
						}
					: {}),
				cleanupDurationMs,
				pollCount,
			};

			if (!envelope) {
				logger.error('Background script execution timed out', { timeout, executionTime });
				return {
					success: false,
					error: `Script execution timed out after ${executionTime}ms. The sys_trigger (Run Once) was created but the ServiceNow scheduler did not execute it within the timeout. Check that the scheduler is running: System Diagnostics > Scheduler.`,
					executionTime,
					executionPath: 'sys_trigger',
					outcome: 'timed_out',
					timings,
				};
			}

			logger.info('Background script execution completed', {
				success: envelope.success,
				executionTime,
				pollCount,
				instance: instance || 'default',
			});

			// A chunk write that failed on the instance is a KNOWN, specific loss of
			// payload. Reporting it as a plain script failure would send the reader
			// looking for a bug in their script that isn't there.
			if (envelope.chunkWriteFailed) {
				return {
					success: false,
					output: payload,
					error:
						`Background-script output could not be fully persisted: one or more sys_properties ` +
						`output chunks failed to insert (chunk_write_failed). The script itself ran` +
						`${envelope.success ? ' and reported success' : ' and reported failure'}; what is shown ` +
						`is partial. Check create access to sys_properties, or reduce the script's output.`,
					executionTime,
					executionPath: 'sys_trigger',
					outcome: 'script_failed',
					runtimeIdentity: envelope.runtimeIdentity as ScriptRuntimeIdentity | undefined,
					timings,
				};
			}

			const success = envelope.success === true && !reassemblyError;
			return {
				success,
				output: envelope.success ? payload : undefined,
				outputTruncated: envelope.outputTruncated,
				outputOriginalChars: envelope.outputOriginalChars,
				outputReturnedChars: envelope.outputReturnedChars,
				// A reassembly problem must reach the caller as an error even though
				// the script itself succeeded: silently returning short output is the
				// same failure mode as a silent zero-row read.
				error: reassemblyError ?? (envelope.success ? undefined : payload || envelope.error),
				executionTime,
				executionPath: 'sys_trigger',
				outcome: success ? 'completed' : 'script_failed',
				runtimeIdentity: envelope.runtimeIdentity as ScriptRuntimeIdentity | undefined,
				timings,
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
