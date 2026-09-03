/**
 * Adaptive polling schedule for the sys_trigger transport.
 *
 * The transport polls a sys_properties mailbox until the scheduler runs the
 * trigger. A flat 500 ms interval was tuned for a job that starts promptly, but
 * measured scheduler latency on a real instance had a median of ~31 s and a P95
 * of ~46 s — so the flat interval issued roughly 60 requests per call, almost
 * all of them into an empty mailbox, and did so against the very instance whose
 * rate limiter and circuit breaker protect us from lockout.
 *
 * Backing off keeps short jobs feeling immediate (the first seconds stay at
 * 500 ms) while making a 30-second wait cost a handful of requests instead of
 * sixty.
 */

/** Poll interval in ms as a function of elapsed wait. */
export function pollIntervalMs(elapsedMs: number): number {
	if (elapsedMs < 3_000) return 500;
	if (elapsedMs < 10_000) return 1_000;
	return 2_000;
}

/**
 * Jitter applied to the steady-state interval.
 *
 * Several concurrent executions started together would otherwise stay in
 * lockstep forever, hitting the instance in synchronized bursts. Spreading them
 * costs nothing and smooths the load. Only the long tail is jittered — the
 * early fast polls are short enough that spreading them would be noise.
 */
export const POLL_JITTER_MS = 250;

/**
 * The next sleep before re-checking the mailbox.
 *
 * `random` is injectable so tests can pin the jitter and assert an exact poll
 * count rather than a range.
 */
export function nextPollDelayMs(elapsedMs: number, random: () => number = Math.random): number {
	const base = pollIntervalMs(elapsedMs);
	if (base < 2_000) return base;
	return base + Math.floor(random() * POLL_JITTER_MS);
}
