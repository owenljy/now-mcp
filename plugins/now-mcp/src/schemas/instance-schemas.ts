/**
 * Zod schemas for instance-management tools.
 */

import { z } from 'zod';

/**
 * Schema for switching the session default instance.
 */
export const SwitchDefaultInstanceSchema = z.object({
	instance: z.string().describe('Name of a configured instance to make default for this session'),
});

export type SwitchDefaultInstanceInput = z.infer<typeof SwitchDefaultInstanceSchema>;

/**
 * Output schema for sn_switch_default_instance.
 */
export const SwitchDefaultInstanceOutputSchema = z.object({
	success: z.boolean(),
	previousDefault: z.string(),
	newDefault: z.string(),
	connectivityVerified: z.boolean(),
	connectivityDetail: z.string().optional(),
});

export const ConnectionStatusSchema = z.object({
	instance: z.string().min(1).optional().describe('Instance name; omit to inspect every instance'),
});

export const ResetConnectionSchema = z.object({
	instance: z
		.string()
		.min(1)
		.optional()
		.describe('Instance name; omit to reset the default instance'),
});

const BreakerStatusSchema = z.object({
	name: z.string(),
	url: z.string(),
	authType: z.enum(['basic', 'oauth']),
	state: z.enum(['closed', 'open', 'half-open']),
	failureScore: z.number(),
	authFailureScore: z.number(),
	openedReason: z
		.enum(['repeated_authentication_failures', 'repeated_transient_failures'])
		.optional(),
	lastFailureAt: z.number().optional(),
	retryAfterMs: z.number(),
});

const BackgroundScriptTransportStatusSchema = z.object({
	transport: z.enum(['scripted_rest', 'sys_trigger']),
	configuredPath: z.string().nullable(),
	usesCompanionEndpoint: z.boolean(),
	fallbackOnFailure: z.literal(false),
	privilegeModel: z.enum(['configured_endpoint_context', 'scheduled_job_context']),
	/**
	 * Prose explanation of the transport. Hoisted to the response-level
	 * `transportDiagnostics` map when several instances share a transport, since
	 * it is a property of the TRANSPORT, not of the instance — repeating the same
	 * paragraph per instance was pure duplication. Always present when only one
	 * instance is reported, so a single-instance caller sees no change.
	 */
	diagnostic: z.string().optional(),
});

/**
 * Observed background-script transport latency for one instance this session.
 *
 * Absent until a background script has actually run — an empty history is
 * reported as absence rather than as zeros, which would read as "instantaneous".
 */
export const TransportHealthSchema = z.object({
	samples: z.number().int().nonnegative(),
	medianTotalDurationMs: z.number(),
	/** Median scheduler queue wait. This, not total duration, is the number that
	 * tells you whether the transport itself is the bottleneck. */
	medianSchedulerWaitMs: z.number().optional(),
	medianPollCount: z.number(),
	timeouts: z.number().int().nonnegative(),
	note: z.string().optional(),
});

export const ConnectionStatusOutputSchema = z.object({
	success: z.literal(true),
	instances: z.array(
		BreakerStatusSchema.extend({
			isDefault: z.boolean(),
			backgroundScriptTransport: BackgroundScriptTransportStatusSchema,
			/** Present once a background script has run on this instance. */
			transportHealth: TransportHealthSchema.optional(),
		}),
	),
	/**
	 * Transport diagnostics said once, keyed by transport, when more than one
	 * instance is reported. Breaker state and auth stay per-instance because they
	 * genuinely differ; this prose does not.
	 */
	transportDiagnostics: z.record(z.string(), z.string()).optional(),
});

export const ResetConnectionOutputSchema = z.object({
	success: z.literal(true),
	connection: BreakerStatusSchema.extend({
		configReloaded: z.boolean(),
		configSource: z.enum(['yaml', 'env', 'unknown']),
		reloadedInstances: z.number().int().nonnegative(),
	}),
	note: z.string(),
});
