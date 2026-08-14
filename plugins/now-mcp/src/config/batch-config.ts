/**
 * Batch-operation tunables.
 *
 * None of these are ServiceNow API limits — every number here is a self-imposed
 * guardrail, not a server constraint. They exist to bound three things: the size
 * of the result echoed back into the model context, the blast radius of a single
 * write call, and the request rate (anti-lockout, alongside the
 * RateLimiter/CircuitBreaker).
 *
 * `batchConcurrency` now sizes a WAVE rather than a burst of parallel requests:
 * the batch tools send each wave as one Table Batch API request. It still bounds
 * the blast radius per round trip and still defines where `continueOnError`
 * stops, so the semantics carry over — but on the batch-API path it no longer
 * describes a number of concurrent connections.
 *
 * Each is configurable via env with a sane default, mirroring the pattern used
 * by SERVICENOW_MAX_DOWNLOAD_BYTES / SERVICENOW_AUDIT_LOG_MAX_BYTES. The batch
 * *size* also has a hard ceiling so a misconfigured env value (e.g. a typo'd
 * 999999) can't queue a runaway write.
 */

export const DEFAULT_MAX_BATCH_SIZE = 50;
export const DEFAULT_BATCH_CONCURRENCY = 25;
export const DEFAULT_BATCH_DELAY_MS = 100;

/**
 * Absolute upper bound on the configurable batch size. An env override may raise
 * the cap above the default but not past this — it's the anti-runaway backstop.
 */
export const MAX_BATCH_SIZE_CEILING = 100;

/**
 * Read a positive integer from an env var, falling back to `fallback` when it is
 * unset, non-numeric, or non-positive. `ceiling`, when given, clamps the result.
 */
function readPositiveInt(raw: string | undefined, fallback: number, ceiling?: number): number {
	if (raw === undefined) return fallback;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) return fallback;
	return ceiling !== undefined ? Math.min(n, ceiling) : n;
}

/**
 * Max records accepted in one batch_create / batch_update call. Default 50,
 * overridable via SERVICENOW_MAX_BATCH_SIZE up to MAX_BATCH_SIZE_CEILING.
 */
export function maxBatchSize(): number {
	return readPositiveInt(
		process.env.SERVICENOW_MAX_BATCH_SIZE,
		DEFAULT_MAX_BATCH_SIZE,
		MAX_BATCH_SIZE_CEILING,
	);
}

/**
 * How many records are dispatched concurrently within a batch (each is its own
 * Table API request). Default 25, overridable via SERVICENOW_BATCH_CONCURRENCY.
 */
export function batchConcurrency(): number {
	return readPositiveInt(process.env.SERVICENOW_BATCH_CONCURRENCY, DEFAULT_BATCH_CONCURRENCY);
}

/**
 * Delay (ms) between concurrency waves, to ease pressure on the instance.
 * Default 100. A value of 0 is honored (no delay); see readNonNegativeInt.
 */
export function batchDelayMs(): number {
	const raw = process.env.SERVICENOW_BATCH_DELAY_MS;
	if (raw === undefined) return DEFAULT_BATCH_DELAY_MS;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0) return DEFAULT_BATCH_DELAY_MS;
	return n;
}
