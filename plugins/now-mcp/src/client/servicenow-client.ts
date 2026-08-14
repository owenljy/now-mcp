/**
 * ServiceNow HTTP client for all API interactions (native fetch, no axios).
 */

import { randomUUID } from 'node:crypto';
import { API_ENDPOINTS, HTTP_CONFIG } from '../config/constants.js';
import { CircuitOpenError, HttpError, NetworkError } from '../types/errors.js';
import type { AuthConfig } from '../types/instance.js';
import { recordWrite } from '../utils/audit.js';
import {
	CircuitBreaker,
	type CircuitBreakerSnapshot,
	type FailureKind,
} from '../utils/circuit-breaker.js';
import { isRetryableError, transformError } from '../utils/error-handler.js';
import { logger } from '../utils/logger.js';
import {
	type BatchOutcome,
	type BatchSubRequest,
	buildBatchPayload,
	isMutatingMethod,
	parseBatchResponse,
} from '../utils/native-batch.js';
import { RateLimiter } from '../utils/rate-limiter.js';
import {
	type OAuthConfig as AuthOAuthConfig,
	clearOAuthTokenCache,
	createBasicAuthHeader,
	createOAuthHeader,
	getOAuthToken,
	validateCredentials,
} from './auth.js';

/** Reads a non-negative integer env var, falling back to `fallback`. */
function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === '') {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Internal per-request options. */
interface RequestOptions {
	method: string;
	/** Query params (GET). */
	params?: Record<string, unknown>;
	/** Request body — a JSON-serializable value, or a FormData for uploads. */
	body?: unknown;
	/** Override the default request timeout (e.g. attachment ops). */
	timeoutMs?: number;
	/** 'json' (default) or 'arraybuffer' for binary downloads. */
	responseType?: 'json' | 'arraybuffer';
	/** When true, resolve to { data, headers } instead of the bare body. */
	includeHeaders?: boolean;
}

/** Body plus lower-cased response headers, for callers that need e.g. X-Total-Count. */
export interface ResponseEnvelope<T> {
	data: T;
	headers: Record<string, string>;
}

export class ServiceNowClient {
	private readonly instanceUrl: string;
	private readonly authConfig: AuthConfig;
	private readonly timeoutMs: number;
	/** Per-instance concurrency cap + pacing (anti-flood). */
	private readonly rateLimiter: RateLimiter;
	/** Per-instance circuit breaker (anti-lockout backoff). */
	private readonly breaker: CircuitBreaker;

	constructor(
		instanceUrl: string,
		authConfig: AuthConfig,
		timeoutMs: number = HTTP_CONFIG.TIMEOUT,
	) {
		// Normalize once so endpoint joining is a plain concatenation.
		this.instanceUrl = instanceUrl.replace(/\/+$/, '');
		this.authConfig = authConfig;
		this.timeoutMs = timeoutMs;

		// Per-instance isolation: each client gets its own limiter + breaker so a
		// misbehaving instance cannot starve or trip the breaker for the others.
		this.rateLimiter = new RateLimiter(
			envInt('SERVICENOW_MAX_CONCURRENT', 8),
			envInt('SERVICENOW_MIN_REQUEST_INTERVAL_MS', 0),
		);
		this.breaker = new CircuitBreaker({
			failureThreshold: envInt('SERVICENOW_BREAKER_THRESHOLD', 5),
			authFailureThreshold: envInt('SERVICENOW_BREAKER_AUTH_THRESHOLD', 2),
			cooldownMs: envInt('SERVICENOW_BREAKER_COOLDOWN_MS', 30000),
		});

		// Validate authentication configuration
		if (authConfig.type === 'basic') {
			validateCredentials(authConfig.username, authConfig.password);
		}
	}

	/** Builds the Authorization header for the configured auth type. */
	private async authHeader(): Promise<string> {
		if (this.authConfig.type === 'basic') {
			return createBasicAuthHeader(this.authConfig.username, this.authConfig.password);
		}
		const token = await getOAuthToken({
			grantType: this.authConfig.grantType,
			clientId: this.authConfig.clientId,
			clientSecret: this.authConfig.clientSecret,
			tokenUrl: this.authConfig.tokenUrl,
			username: this.authConfig.username,
			password: this.authConfig.password,
			scope: this.authConfig.scope,
		} as AuthOAuthConfig);
		return createOAuthHeader(token);
	}

	private oauthConfig(): AuthOAuthConfig | undefined {
		if (this.authConfig.type !== 'oauth') return undefined;
		return {
			grantType: this.authConfig.grantType,
			clientId: this.authConfig.clientId,
			clientSecret: this.authConfig.clientSecret,
			tokenUrl: this.authConfig.tokenUrl,
			username: this.authConfig.username,
			password: this.authConfig.password,
			scope: this.authConfig.scope,
		};
	}

	/** Appends query params to an endpoint path. */
	private buildUrl(endpoint: string, params?: Record<string, unknown>): string {
		const base = `${this.instanceUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
		if (!params) {
			return base;
		}
		const search = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined && value !== null) {
				search.append(key, String(value));
			}
		}
		const qs = search.toString();
		return qs ? `${base}?${qs}` : base;
	}

	/**
	 * Executes a single fetch, translating the outcome into either a resolved
	 * value (2xx) or a thrown HttpError (non-2xx) / NetworkError (no response).
	 * No retry/breaker logic here — that lives in requestWithRetry.
	 */
	private async doFetch<T>(endpoint: string, opts: RequestOptions): Promise<T> {
		const url = this.buildUrl(endpoint, opts.params);
		const headers: Record<string, string> = {
			Authorization: await this.authHeader(),
			Accept: 'application/json',
			'Accept-Encoding': 'gzip, deflate',
		};

		let body: string | FormData | undefined;
		if (opts.body instanceof FormData) {
			// Let fetch set the multipart boundary Content-Type.
			body = opts.body;
		} else if (opts.body !== undefined) {
			headers['Content-Type'] = 'application/json';
			body = JSON.stringify(opts.body);
		}

		logger.debug('ServiceNow API request', {
			method: opts.method,
			url,
			authType: this.authConfig.type,
		});

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.timeoutMs);

		let response: Response;
		try {
			response = await fetch(url, {
				method: opts.method,
				headers,
				body,
				redirect: 'follow',
				signal: controller.signal,
			});
		} catch (error) {
			// Transport-level failure (DNS, connection refused, timeout/abort).
			const message =
				(error as Error)?.name === 'AbortError'
					? `Request to ${url} timed out after ${opts.timeoutMs ?? this.timeoutMs}ms`
					: 'Failed to connect to ServiceNow instance. Please check your network connection and instance URL.';
			throw new NetworkError(message, { originalError: (error as Error)?.message });
		} finally {
			clearTimeout(timeout);
		}

		logger.debug('ServiceNow API response', { status: response.status, url });

		if (!response.ok) {
			const headerObj: Record<string, string> = {};
			response.headers.forEach((v, k) => {
				headerObj[k] = v;
			});
			// ServiceNow error payloads are JSON; fall back to text.
			let data: unknown;
			try {
				data = await response.json();
			} catch {
				data = undefined;
			}
			throw new HttpError(response.status, response.statusText, headerObj, data);
		}

		if (opts.responseType === 'arraybuffer') {
			return (await response.arrayBuffer()) as T;
		}

		// 204 No Content and empty bodies parse to undefined rather than throwing.
		const text = await response.text();
		const data = text ? JSON.parse(text) : undefined;

		if (opts.includeHeaders) {
			const headerObj: Record<string, string> = {};
			response.headers.forEach((v, k) => {
				headerObj[k] = v;
			});
			return { data, headers: headerObj } as T;
		}

		return data as T;
	}

	/**
	 * Performs HTTP GET request with retry logic
	 */
	async get<T>(endpoint: string, params?: Record<string, unknown>): Promise<T> {
		return this.requestWithRetry<T>(() => this.doFetch<T>(endpoint, { method: 'GET', params }));
	}

	/**
	 * GET that also returns response headers (for X-Total-Count and similar).
	 * Same retry/breaker/rate-limit path as get().
	 */
	async getWithHeaders<T>(
		endpoint: string,
		params?: Record<string, unknown>,
	): Promise<ResponseEnvelope<T>> {
		return this.requestWithRetry<ResponseEnvelope<T>>(() =>
			this.doFetch<ResponseEnvelope<T>>(endpoint, { method: 'GET', params, includeHeaders: true }),
		);
	}

	/**
	 * Performs HTTP POST request with retry logic
	 */
	async post<T>(endpoint: string, data: unknown): Promise<T> {
		recordWrite('POST', endpoint, this.instanceUrl);
		return this.requestWithRetry<T>(() =>
			this.doFetch<T>(endpoint, { method: 'POST', body: data }),
		);
	}

	/**
	 * Performs HTTP PUT request with retry logic
	 */
	async put<T>(endpoint: string, data: unknown): Promise<T> {
		recordWrite('PUT', endpoint, this.instanceUrl);
		return this.requestWithRetry<T>(() => this.doFetch<T>(endpoint, { method: 'PUT', body: data }));
	}

	/**
	 * Performs HTTP PATCH request with retry logic
	 */
	async patch<T>(endpoint: string, data: unknown): Promise<T> {
		recordWrite('PATCH', endpoint, this.instanceUrl);
		return this.requestWithRetry<T>(() =>
			this.doFetch<T>(endpoint, { method: 'PATCH', body: data }),
		);
	}

	/**
	 * Performs HTTP DELETE request with retry logic
	 */
	async delete<T>(endpoint: string): Promise<T> {
		recordWrite('DELETE', endpoint, this.instanceUrl);
		return this.requestWithRetry<T>(() => this.doFetch<T>(endpoint, { method: 'DELETE' }));
	}

	/**
	 * Executes many Table API calls in a single request via the Table Batch API.
	 *
	 * Audit is recorded per LOGICAL write rather than once for the envelope: a
	 * single `POST /api/now/v1/batch` line would hide which records this server
	 * actually changed, defeating the point of the trail. The envelope POST
	 * itself is therefore sent through doFetch directly instead of post().
	 */
	async batch(requests: BatchSubRequest[]): Promise<BatchOutcome> {
		for (const request of requests) {
			if (isMutatingMethod(request.method)) {
				recordWrite(request.method, request.url, this.instanceUrl);
			}
		}

		const payload = buildBatchPayload(randomUUID(), requests);
		const raw = await this.requestWithRetry<unknown>(() =>
			this.doFetch<unknown>(API_ENDPOINTS.BATCH, { method: 'POST', body: payload }),
		);

		return parseBatchResponse(raw, requests);
	}

	/**
	 * Uploads a file to ServiceNow
	 * @param file File buffer
	 * @param fileName File name
	 * @param tableName Table to attach to
	 * @param recordSysId Record sys_id to attach to
	 */
	async uploadFile(
		file: Buffer,
		fileName: string,
		tableName: string,
		recordSysId: string,
	): Promise<unknown> {
		// Attachment upload is a write; audit it like every other POST/PUT/PATCH/DELETE.
		recordWrite(
			'POST',
			`${API_ENDPOINTS.ATTACHMENT_UPLOAD} (${tableName}/${recordSysId})`,
			this.instanceUrl,
		);

		// ServiceNow's multipart attachment endpoint requires table_name/table_sys_id
		// as form fields *before* the file part, and the file part must be named
		// 'uploadFile' and be the last part (per the Attachment API contract).
		const formData = new FormData();
		formData.append('table_name', tableName);
		formData.append('table_sys_id', recordSysId);
		formData.append('uploadFile', new Blob([file]), fileName);

		return this.requestWithRetry(() =>
			this.doFetch(API_ENDPOINTS.ATTACHMENT_UPLOAD, {
				method: 'POST',
				body: formData,
				timeoutMs: HTTP_CONFIG.ATTACHMENT_TIMEOUT,
			}),
		);
	}

	/**
	 * Downloads a file from ServiceNow
	 * @param attachmentSysId Attachment sys_id
	 */
	async downloadFile(attachmentSysId: string): Promise<Buffer> {
		const data = await this.requestWithRetry<ArrayBuffer>(() =>
			this.doFetch<ArrayBuffer>(`/api/now/attachment/${attachmentSysId}/file`, {
				method: 'GET',
				responseType: 'arraybuffer',
				timeoutMs: HTTP_CONFIG.ATTACHMENT_TIMEOUT,
			}),
		);

		return Buffer.from(data);
	}

	/**
	 * Only authentication and transient availability failures affect the
	 * instance-level breaker. Authorization/client errors prove that the server
	 * responded and must not make unrelated tables unavailable.
	 */
	private classifyFailure(error: unknown): FailureKind | undefined {
		const status =
			error instanceof HttpError
				? error.status
				: (error as { statusCode?: number } | undefined)?.statusCode;
		if (status === 401) return 'authentication';
		if (status === 429 || (status !== undefined && status >= 500)) return 'transient';
		if (error instanceof NetworkError) return 'transient';
		return undefined;
	}

	private circuitOpenError(): CircuitOpenError {
		const snapshot = this.breaker.snapshot();
		return new CircuitOpenError({
			instanceUrl: this.instanceUrl,
			scope: 'instance',
			reason: snapshot.openedReason,
			retryAfterMs: snapshot.retryAfterMs,
			retryAt: new Date(Date.now() + snapshot.retryAfterMs).toISOString(),
			authType: this.authConfig.type,
		});
	}

	private retryDelay(error: unknown, retryCount: number): number {
		if (error instanceof HttpError && error.status === 429) {
			const value = error.headers['retry-after'];
			if (value) {
				const seconds = Number.parseFloat(value);
				if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
				const date = Date.parse(value);
				if (Number.isFinite(date)) return Math.max(0, date - Date.now());
			}
		}
		return HTTP_CONFIG.RETRY_DELAY * 2 ** retryCount;
	}

	/**
	 * Performs a request with exponential backoff retry logic.
	 *
	 * Anti-lockout: every attempt is gated by the per-instance circuit breaker
	 * and routed through the per-instance rate limiter. If the breaker is open we
	 * fail fast WITHOUT entering the retry loop, so a string of failures cannot
	 * keep flooding the instance.
	 */
	private async requestWithRetry<T>(
		requestFn: () => Promise<T>,
		retryCount: number = 0,
		oauthRefreshAttempted = false,
		skipBreakerGate = false,
	): Promise<T> {
		// Fail fast when the breaker is open — do not retry into a wall.
		if (!skipBreakerGate && !this.breaker.canRequest()) {
			throw this.circuitOpenError();
		}

		try {
			// Bound concurrency / pacing per instance to avoid flooding.
			const result = await this.rateLimiter.run(requestFn);
			this.breaker.recordSuccess();
			return result;
		} catch (error) {
			// A cached OAuth token can be revoked before its advertised expiry. Drop
			// it and replay exactly once with a newly acquired token. Do not count the
			// stale-token response toward lockout unless the fresh token also fails.
			if (
				error instanceof HttpError &&
				error.status === 401 &&
				this.authConfig.type === 'oauth' &&
				!oauthRefreshAttempted
			) {
				clearOAuthTokenCache(this.authConfig.clientId, this.authConfig.tokenUrl);
				logger.warn('OAuth API request returned 401; cleared cached token and retrying once', {
					instanceUrl: this.instanceUrl,
				});
				return this.requestWithRetry(requestFn, retryCount, true, true);
			}

			const failureKind = this.classifyFailure(error);
			if (failureKind) this.breaker.recordFailure(failureKind);
			else this.breaker.recordSuccess();

			const transformedError = transformError(error);

			// Check if we should retry
			if (retryCount < HTTP_CONFIG.MAX_RETRIES && isRetryableError(error)) {
				// Calculate delay with exponential backoff
				const delay = this.retryDelay(error, retryCount);

				logger.warn(
					`Request failed, retrying in ${delay}ms (attempt ${retryCount + 1}/${HTTP_CONFIG.MAX_RETRIES})`,
					{
						error: transformedError.message,
					},
				);

				// Wait before retrying
				await this.sleep(delay);

				// Retry the request
				return this.requestWithRetry(requestFn, retryCount + 1, oauthRefreshAttempted);
			}

			// Max retries reached or non-retryable error
			throw transformedError;
		}
	}

	/**
	 * Sleep utility for delays
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * Gets the instance URL
	 */
	getInstanceUrl(): string {
		return this.instanceUrl;
	}

	getAuthType(): 'basic' | 'oauth' {
		return this.authConfig.type;
	}

	getConnectionStatus(): CircuitBreakerSnapshot {
		return this.breaker.snapshot();
	}

	/** Clear local auth/backoff state after configuration has been repaired. */
	resetConnection(): CircuitBreakerSnapshot {
		const oauth = this.oauthConfig();
		if (oauth) clearOAuthTokenCache(oauth.clientId, oauth.tokenUrl);
		this.breaker.reset();
		logger.info('ServiceNow connection state reset', {
			instanceUrl: this.instanceUrl,
			authType: this.authConfig.type,
		});
		return this.breaker.snapshot();
	}

	/**
	 * Simple query method for validation (lightweight table query)
	 * @param tableName Table to query
	 * @param query Optional query string
	 * @param limit Limit number of results
	 * @param offset Offset for pagination
	 */
	async query(
		tableName: string,
		query?: string,
		limit: number = 1,
		offset: number = 0,
	): Promise<unknown> {
		const endpoint = `/api/now/table/${tableName}`;
		const params: Record<string, unknown> = {
			sysparm_limit: limit,
			sysparm_offset: offset,
		};

		if (query) {
			params.sysparm_query = query;
		}

		return this.get(endpoint, params);
	}
}
