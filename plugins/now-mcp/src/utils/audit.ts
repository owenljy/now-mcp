/**
 * Write-operation audit log.
 *
 * Every mutating HTTP call (POST/PUT/PATCH/DELETE) is recorded so there is a
 * trail of what this server changed and where. Entries always go to the
 * logger (stderr); if SERVICENOW_AUDIT_LOG is set to a file path, a JSON line
 * per write is also appended there.
 *
 * The file is size-capped: before each append, if it has grown past
 * SERVICENOW_AUDIT_LOG_MAX_BYTES (default 10 MiB), it is rotated to
 * `<path>.1` (replacing any previous rotation) and a fresh file is started.
 * A single backup generation is kept — enough to bound disk use on a
 * long-lived server without pulling in a full log-rotation dependency.
 */

import { appendFileSync, renameSync, statSync } from 'node:fs';
import { logger } from './logger.js';
import { getOperationContext } from './operation-context.js';

export type WriteAuditEvent = 'attempt' | 'outcome';
export type WriteAuditOutcome = 'succeeded' | 'failed' | 'uncertain';

export interface WriteAuditEntry {
	timestamp: string;
	method: string;
	endpoint: string;
	host: string;
	event: WriteAuditEvent;
	outcome?: WriteAuditOutcome;
	operationId?: string;
	instance?: string;
	tool?: string;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

function hostOf(instanceUrl: string): string {
	try {
		return new URL(instanceUrl).host;
	} catch {
		return instanceUrl;
	}
}

/**
 * Resolve the configured rotation cap. Invalid or non-positive values disable
 * rotation (returns Infinity) so a misconfigured env var never drops entries.
 */
function maxBytes(): number {
	const raw = process.env.SERVICENOW_AUDIT_LOG_MAX_BYTES;
	if (raw === undefined) return DEFAULT_MAX_BYTES;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return Infinity;
	return n;
}

/**
 * Rotate the audit file if it has reached the size cap. Best-effort: any
 * failure (missing file, permission error) is swallowed so auditing keeps
 * appending rather than blocking the write it is recording.
 */
function rotateIfNeeded(auditFile: string, limit: number): void {
	if (limit === Infinity) return;
	try {
		const { size } = statSync(auditFile);
		if (size < limit) return;
		renameSync(auditFile, `${auditFile}.1`);
	} catch {
		// File doesn't exist yet, or can't be rotated — nothing to do.
	}
}

/**
 * Record a write operation to the audit trail.
 */
export function recordWrite(
	method: string,
	endpoint: string,
	instanceUrl: string,
	event: WriteAuditEvent = 'attempt',
	outcome?: WriteAuditOutcome,
): void {
	const context = getOperationContext();
	const entry: WriteAuditEntry = {
		timestamp: new Date().toISOString(),
		method: method.toUpperCase(),
		endpoint,
		host: hostOf(instanceUrl),
		event,
		...(outcome ? { outcome } : {}),
		...(context
			? {
					operationId: context.operationId,
					instance: context.instance,
					tool: context.tool,
				}
			: {}),
	};

	const correlation = entry.operationId ? ` op=${entry.operationId}` : '';
	const result = entry.outcome ? ` ${entry.outcome}` : '';
	logger.info(
		`[AUDIT] ${entry.event}${result} ${entry.method} ${entry.endpoint} @ ${entry.host}${correlation}`,
	);

	const auditFile = process.env.SERVICENOW_AUDIT_LOG;
	if (auditFile) {
		try {
			rotateIfNeeded(auditFile, maxBytes());
			appendFileSync(auditFile, `${JSON.stringify(entry)}\n`, 'utf-8');
		} catch (error) {
			// Never let auditing break the actual operation.
			logger.warn(`Failed to write audit log to ${auditFile}`, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
