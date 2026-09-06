/**
 * Custom error types for now-mcp
 */

export class ServiceNowError extends Error {
	/** Safe classified diagnostics for an attempted independent read recovery. */
	fallbackFailure?: { reason: string };
	constructor(
		message: string,
		public statusCode?: number,
		public servicenowError?: unknown,
		public code?: string,
	) {
		super(message);
		this.name = 'ServiceNowError';
		Object.setPrototypeOf(this, ServiceNowError.prototype);
	}

	toJSON() {
		return {
			success: false,
			error: {
				name: this.name,
				message: this.message,
				code: this.code,
				statusCode: this.statusCode,
				details: this.servicenowError,
				...(this.fallbackFailure ? { fallbackFailure: this.fallbackFailure } : {}),
			},
			isError: true,
		};
	}
}

export class AuthenticationError extends ServiceNowError {
	constructor(message: string = 'Authentication failed', details?: unknown) {
		super(message, 401, details, 'AUTH_ERROR');
		this.name = 'AuthenticationError';
		Object.setPrototypeOf(this, AuthenticationError.prototype);
	}
}

export class ValidationError extends ServiceNowError {
	constructor(message: string, details?: unknown) {
		super(message, 400, details, 'VALIDATION_ERROR');
		this.name = 'ValidationError';
		Object.setPrototypeOf(this, ValidationError.prototype);
	}
}

export class NotFoundError extends ServiceNowError {
	constructor(message: string = 'Resource not found', details?: unknown) {
		super(message, 404, details, 'NOT_FOUND');
		this.name = 'NotFoundError';
		Object.setPrototypeOf(this, NotFoundError.prototype);
	}
}

export class RateLimitError extends ServiceNowError {
	constructor(
		message: string = 'Rate limit exceeded',
		public retryAfter?: number,
		details?: unknown,
	) {
		super(message, 429, details, 'RATE_LIMIT_ERROR');
		this.name = 'RateLimitError';
		Object.setPrototypeOf(this, RateLimitError.prototype);
	}
}

export class ServerError extends ServiceNowError {
	constructor(message: string = 'Server error occurred', details?: unknown) {
		super(message, 500, details, 'SERVER_ERROR');
		this.name = 'ServerError';
		Object.setPrototypeOf(this, ServerError.prototype);
	}
}

export class NetworkError extends ServiceNowError {
	constructor(message: string = 'Network error occurred', details?: unknown) {
		super(message, undefined, details, 'NETWORK_ERROR');
		this.name = 'NetworkError';
		Object.setPrototypeOf(this, NetworkError.prototype);
	}
}

export interface MutationOutcomeUncertainDetails {
	outcome: 'uncertain';
	retryable: false;
	method: string;
	endpoint: string;
	instanceUrl: string;
	reason: string;
	reconciliation: string;
}

/**
 * The request may have reached ServiceNow, but no authoritative response came
 * back. Replaying a non-idempotent mutation could duplicate records, files, or
 * script side effects, so callers must reconcile state before deciding what to do.
 */
export class MutationOutcomeUncertainError extends ServiceNowError {
	constructor(details: MutationOutcomeUncertainDetails) {
		super(
			`${details.method} ${details.endpoint} may have been applied, but its outcome could not be confirmed. ` +
				'Do not retry blindly; verify the target state first.',
			undefined,
			details,
			'MUTATION_OUTCOME_UNCERTAIN',
		);
		this.name = 'MutationOutcomeUncertainError';
		Object.setPrototypeOf(this, MutationOutcomeUncertainError.prototype);
	}
}

export class AccessDeniedError extends ServiceNowError {
	constructor(message: string, details?: unknown) {
		super(message, 403, details, 'ACCESS_DENIED');
		this.name = 'AccessDeniedError';
		Object.setPrototypeOf(this, AccessDeniedError.prototype);
	}
}

export interface CircuitOpenDetails {
	instanceUrl: string;
	scope: 'instance';
	reason?: string;
	retryAfterMs: number;
	retryAt: string;
	authType: 'basic' | 'oauth';
}

/** A local anti-lockout rejection; no HTTP request was sent. */
export class CircuitOpenError extends ServiceNowError {
	constructor(details: CircuitOpenDetails) {
		super(
			`Requests to this ServiceNow instance are paused for ${Math.ceil(details.retryAfterMs / 1000)}s after repeated failures`,
			503,
			details,
			'CIRCUIT_OPEN',
		);
		this.name = 'CircuitOpenError';
		Object.setPrototypeOf(this, CircuitOpenError.prototype);
	}
}

/**
 * Raw transport-level error for a non-2xx HTTP response (a response WAS
 * received). Thrown by the HTTP client and normalized into a ServiceNowError by
 * error-handler.transformError. Network-level failures (no response) are thrown
 * as NetworkError directly.
 */
export class HttpError extends Error {
	constructor(
		public status: number,
		public statusText: string,
		public headers: Record<string, string>,
		public data: unknown,
	) {
		super(`HTTP ${status} ${statusText}`);
		this.name = 'HttpError';
		Object.setPrototypeOf(this, HttpError.prototype);
	}
}
