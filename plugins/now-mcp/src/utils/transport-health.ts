/**
 * Recent background-script transport latency, per instance.
 *
 * Exists so `sn_connection_status` can answer "is the sys_trigger transport
 * healthy on this instance?" from evidence rather than from the operator's
 * memory. The scheduler wait is the number that matters: on the transcript that
 * motivated this work it was a ~31s median, which is a standing property of the
 * instance and a one-line configuration fix (install a Scripted REST endpoint),
 * yet it was invisible anywhere except by reading 61 individual call durations.
 *
 * In-process and bounded: a ring of the last few samples per instance. This is
 * diagnostic colour, not telemetry — nothing is persisted, and an empty history
 * simply means no background script has run yet this session.
 */

/** Samples retained per instance. Enough to show a trend, small enough to stay free. */
const WINDOW = 10;

export interface TransportSample {
	totalDurationMs: number;
	observedSchedulerWaitMs?: number;
	pollCount: number;
	outcome: 'completed' | 'script_failed' | 'timed_out';
}

export interface TransportHealth {
	samples: number;
	medianTotalDurationMs: number;
	/** Median of the samples that reported a wait; absent when none did. */
	medianSchedulerWaitMs?: number;
	medianPollCount: number;
	timeouts: number;
	/** Set when the median wait indicates the scheduler, not the script, is the
	 * bottleneck — the case where a configuration change is the real fix. */
	note?: string;
}

const history = new Map<string, TransportSample[]>();

export function recordTransportSample(instance: string, sample: TransportSample): void {
	const list = history.get(instance) ?? [];
	list.push(sample);
	if (list.length > WINDOW) list.shift();
	history.set(instance, list);
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	// Even-length windows average the two central samples rather than picking
	// one arbitrarily — with WINDOW=10 that is the common case.
	return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

/** Summary for one instance, or undefined when nothing has been observed. */
export function transportHealth(instance: string): TransportHealth | undefined {
	const samples = history.get(instance);
	if (!samples || samples.length === 0) return undefined;

	const waits = samples
		.map((s) => s.observedSchedulerWaitMs)
		.filter((w): w is number => typeof w === 'number');
	const medianSchedulerWaitMs = waits.length > 0 ? median(waits) : undefined;

	return {
		samples: samples.length,
		medianTotalDurationMs: median(samples.map((s) => s.totalDurationMs)),
		...(medianSchedulerWaitMs !== undefined ? { medianSchedulerWaitMs } : {}),
		medianPollCount: median(samples.map((s) => s.pollCount)),
		timeouts: samples.filter((s) => s.outcome === 'timed_out').length,
		...(medianSchedulerWaitMs !== undefined && medianSchedulerWaitMs > 10_000
			? {
					note:
						`Scheduler pickup plus polling detection takes at most ~${Math.round(medianSchedulerWaitMs / 1000)}s for a Run Once ` +
						`trigger on this instance. Script time is reported separately — configure scriptApiPath ` +
						`(a Scripted REST resource) to execute synchronously and skip the scheduler.`,
				}
			: {}),
	};
}

/** Test seam: drop all recorded history. */
export function resetTransportHealth(): void {
	history.clear();
}
