/**
 * Table Batch API (`/api/now/v1/batch`) envelope construction and parsing.
 *
 * One HTTP request carries many Table API calls, replacing the N sequential
 * round trips the batch tools used to make. Verified against a live instance:
 *
 *   - Sub-request bodies MUST be base64-encoded. A raw JSON string is not
 *     serviced at all (the response comes back with no serviced_requests),
 *     which is a silent no-op rather than an error — hence the assertion in
 *     encodeBody and the explicit test for it.
 *   - The envelope returns HTTP 200 even when sub-requests fail; each carries
 *     its own `status_code` (a bad table name came back as 400 alongside a 200
 *     sibling), so partial failure is cleanly attributable.
 *   - Sub-requests that never ran are listed by id in `unserviced_requests`.
 *   - Response bodies are base64 too (`body_encoding: "base64"`), and DELETE
 *     sub-requests answer 204 with no body.
 */

export type BatchMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface BatchSubRequest {
	/** Correlation id, echoed back on the response. */
	id: string;
	method: BatchMethod;
	/** Instance-relative path including any query string. */
	url: string;
	/** JSON-serializable request body; base64-encoded by the builder. */
	body?: unknown;
}

export interface BatchSubResponse {
	id: string;
	statusCode: number;
	/** Parsed response body, or undefined for 204 / empty. */
	body?: unknown;
	/** ServiceNow's error message, when the sub-request failed. */
	error?: string;
}

export interface BatchOutcome {
	/** Responses keyed by sub-request id. */
	responses: Map<string, BatchSubResponse>;
	/** Ids ServiceNow accepted but did not execute. */
	unserviced: string[];
}

/** Raw shape of the batch response envelope. */
interface RawBatchResponse {
	batch_request_id?: string;
	serviced_requests?: Array<{
		id: string;
		status_code: number;
		body?: string;
		body_encoding?: string;
	}>;
	unserviced_requests?: Array<string | { id: string }>;
}

/** Methods that mutate, for audit purposes. */
const MUTATING: ReadonlySet<string> = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export function isMutatingMethod(method: string): boolean {
	return MUTATING.has(method.toUpperCase());
}

/**
 * Build the batch envelope. Bodies are base64-encoded because the API requires
 * it — see the module note; sending raw JSON is silently ignored.
 *
 * `exclude_response_headers` is set because nothing in the batch path reads
 * sub-response headers, and they are the bulk of an otherwise tiny response.
 */
export function buildBatchPayload(
	batchRequestId: string,
	requests: BatchSubRequest[],
): Record<string, unknown> {
	return {
		batch_request_id: batchRequestId,
		rest_requests: requests.map((r) => ({
			id: r.id,
			method: r.method,
			url: r.url,
			exclude_response_headers: true,
			headers: [
				{ name: 'Accept', value: 'application/json' },
				...(r.body !== undefined ? [{ name: 'Content-Type', value: 'application/json' }] : []),
			],
			...(r.body !== undefined
				? { body: Buffer.from(JSON.stringify(r.body), 'utf-8').toString('base64') }
				: {}),
		})),
	};
}

/** Decode a base64 sub-response body into parsed JSON, tolerating 204/empty. */
function decodeBody(raw: string | undefined, encoding: string | undefined): unknown {
	if (!raw) return undefined;
	const text = encoding === 'base64' ? Buffer.from(raw, 'base64').toString('utf-8') : raw;
	if (!text.trim()) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		// A non-JSON body (an HTML error page from a proxy, say) is still worth
		// surfacing verbatim rather than dropped.
		return text;
	}
}

/** Pull ServiceNow's error message out of a failed sub-response body. */
function errorMessageOf(body: unknown, statusCode: number): string | undefined {
	if (statusCode < 400) return undefined;
	const err = (body as { error?: { message?: string; detail?: string } } | undefined)?.error;
	const message = [err?.message, err?.detail].filter(Boolean).join(' — ');
	return message || `HTTP ${statusCode}`;
}

/**
 * Parse the batch envelope into per-id outcomes.
 *
 * Any requested id missing from BOTH serviced and unserviced lists is reported
 * as unserviced: a request that vanished must not be mistaken for a success,
 * which is exactly how the raw-body encoding mistake would have presented.
 */
export function parseBatchResponse(raw: unknown, requests: BatchSubRequest[]): BatchOutcome {
	const envelope = (raw ?? {}) as RawBatchResponse;
	const responses = new Map<string, BatchSubResponse>();

	for (const serviced of envelope.serviced_requests ?? []) {
		const body = decodeBody(serviced.body, serviced.body_encoding);
		responses.set(serviced.id, {
			id: serviced.id,
			statusCode: serviced.status_code,
			body,
			error: errorMessageOf(body, serviced.status_code),
		});
	}

	const unserviced = new Set(
		(envelope.unserviced_requests ?? []).map((u) => (typeof u === 'string' ? u : u.id)),
	);
	for (const request of requests) {
		if (!responses.has(request.id)) unserviced.add(request.id);
	}

	return { responses, unserviced: [...unserviced] };
}

/**
 * Whether a failure of the batch endpoint itself means "this instance has no
 * batch API" (so the caller should fall back to looped single calls) rather than
 * "this batch was rejected". 404/405 are the endpoint-absent signals.
 */
export function isBatchEndpointUnavailable(error: unknown): boolean {
	const status =
		(error as { statusCode?: number; status?: number } | undefined)?.statusCode ??
		(error as { status?: number } | undefined)?.status;
	return status === 404 || status === 405;
}
