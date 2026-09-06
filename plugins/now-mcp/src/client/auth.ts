/**
 * Authentication utilities for ServiceNow API
 */

import { ValidationError } from '../types/errors.js';

/**
 * Creates a Basic Authentication header value
 * @param username ServiceNow username
 * @param password ServiceNow password
 * @returns Base64-encoded authentication header value
 */
export function createBasicAuthHeader(username: string, password: string): string {
	// Validate credentials
	if (!username || username.trim().length === 0) {
		throw new ValidationError('Username cannot be empty');
	}

	if (!password || password.trim().length === 0) {
		throw new ValidationError('Password cannot be empty');
	}

	// Create Basic Auth header: "Basic base64(username:password)"
	const credentials = `${username}:${password}`;
	const encodedCredentials = Buffer.from(credentials).toString('base64');

	return `Basic ${encodedCredentials}`;
}

/**
 * Validates credential format
 * @param username ServiceNow username
 * @param password ServiceNow password
 * @throws ValidationError if credentials are invalid
 */
export function validateCredentials(username: string, password: string): void {
	if (!username || username.trim().length === 0) {
		throw new ValidationError('Username cannot be empty');
	}

	if (!password || password.trim().length === 0) {
		throw new ValidationError('Password cannot be empty');
	}

	// Basic validation for username format (typically email or alphanumeric)
	if (username.length > 255) {
		throw new ValidationError('Username is too long (max 255 characters)');
	}

	// Ensure no control characters in username
	if (/[\x00-\x1F\x7F]/.test(username)) {
		throw new ValidationError('Username contains invalid characters');
	}
}

/**
 * OAuth 2.0 grant types supported for token acquisition.
 */
export type OAuthGrantType = 'client_credentials' | 'password';

/**
 * OAuth 2.0 configuration
 */
export interface OAuthConfig {
	/** Defaults to `client_credentials` when omitted. */
	grantType?: OAuthGrantType;
	clientId: string;
	clientSecret: string;
	tokenUrl: string;
	/** Required when grantType is `password`. */
	username?: string;
	/** Required when grantType is `password`. */
	password?: string;
	scope?: string;
}

/**
 * OAuth token response from ServiceNow
 */
interface OAuthTokenResponse {
	access_token: string;
	token_type: string;
	expires_in: number;
	refresh_token?: string;
	scope?: string;
}

/**
 * Cached OAuth token with expiration and (for the password grant) a
 * refresh_token so we can renew without re-sending the user's password.
 */
interface CachedToken {
	token: string;
	expiresAt: number;
	refreshToken?: string;
}

// Token cache: Map<cacheKey, CachedToken>
const tokenCache = new Map<string, CachedToken>();

/** Cache key isolates tokens by client, endpoint, grant and (if any) user. */
function cacheKeyFor(config: OAuthConfig): string {
	const grant = config.grantType ?? 'client_credentials';
	return `${grant}:${config.clientId}:${config.tokenUrl}:${config.username ?? ''}`;
}

/** POST the token endpoint with the given params and cache the result. */
async function requestToken(
	config: OAuthConfig,
	params: URLSearchParams,
	cacheKey: string,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted();
	const response = await fetch(config.tokenUrl, {
		signal,
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Accept: 'application/json',
		},
		body: params.toString(),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(
			`OAuth token request failed: ${response.status} ${response.statusText}. ${errorText}`,
		);
	}

	const data = (await response.json()) as OAuthTokenResponse;

	if (!data.access_token) {
		throw new Error('OAuth token response missing access_token');
	}

	// Cache the token with a buffer (expire 5 minutes early to be safe)
	const expiresIn = data.expires_in || 3600; // Default 1 hour
	const bufferSeconds = 300; // 5 minutes
	const expiresAt = Date.now() + (expiresIn - bufferSeconds) * 1000;

	tokenCache.set(cacheKey, {
		token: data.access_token,
		expiresAt,
		refreshToken: data.refresh_token,
	});

	return data.access_token;
}

/**
 * Get an OAuth 2.0 access token.
 *
 * Supports two grants:
 * - `client_credentials` (default): app-level token from clientId/secret.
 * - `password`: user-level token from username/password; on expiry the cached
 *   refresh_token is used to renew (no password re-send), falling back to a
 *   fresh password exchange if the refresh fails.
 *
 * Tokens are cached (keyed by grant/client/endpoint/user) to avoid needless
 * token requests.
 *
 * @param config OAuth configuration
 * @returns Access token
 */
export async function getOAuthToken(config: OAuthConfig, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	// Validate config
	if (!config.clientId || !config.clientSecret || !config.tokenUrl) {
		throw new ValidationError(
			'OAuth configuration is incomplete: clientId, clientSecret, and tokenUrl are required',
		);
	}

	const grantType = config.grantType ?? 'client_credentials';

	if (grantType === 'password' && (!config.username || !config.password)) {
		throw new ValidationError('OAuth password grant requires both username and password');
	}

	const cacheKey = cacheKeyFor(config);

	// Serve an unexpired cached token.
	const cached = tokenCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.token;
	}

	try {
		// Password grant: try refreshing with the stored refresh_token first, so
		// we don't re-send the user's password on every expiry.
		if (grantType === 'password' && cached?.refreshToken) {
			try {
				const refreshParams = new URLSearchParams({
					grant_type: 'refresh_token',
					refresh_token: cached.refreshToken,
					client_id: config.clientId,
					client_secret: config.clientSecret,
				});
				if (config.scope) refreshParams.append('scope', config.scope);
				return await requestToken(config, refreshParams, cacheKey, signal);
			} catch {
				signal?.throwIfAborted();
				// Refresh failed (expired/revoked) — drop it and fall through to a
				// fresh password exchange below.
				tokenCache.delete(cacheKey);
			}
		}

		const params = new URLSearchParams({
			grant_type: grantType,
			client_id: config.clientId,
			client_secret: config.clientSecret,
		});

		if (grantType === 'password') {
			params.append('username', config.username as string);
			params.append('password', config.password as string);
		}

		if (config.scope) {
			params.append('scope', config.scope);
		}

		return await requestToken(config, params, cacheKey, signal);
	} catch (error) {
		signal?.throwIfAborted();
		if (error instanceof Error) {
			throw new Error(`Failed to obtain OAuth token: ${error.message}`);
		}
		throw new Error('Failed to obtain OAuth token: Unknown error');
	}
}

/**
 * Create OAuth Bearer token authentication header
 * @param token OAuth access token
 * @returns Bearer authentication header value
 */
export function createOAuthHeader(token: string): string {
	if (!token || token.trim().length === 0) {
		throw new ValidationError('OAuth token cannot be empty');
	}

	return `Bearer ${token}`;
}

/**
 * Clear cached OAuth token(s) for a client/endpoint.
 * Useful when a token is revoked or needs to be refreshed. Clears every cached
 * entry for this clientId+tokenUrl across grant types and users, since the
 * cache key also encodes those.
 * @param clientId OAuth client ID
 * @param tokenUrl OAuth token URL
 */
export function clearOAuthTokenCache(clientId: string, tokenUrl: string): void {
	for (const key of tokenCache.keys()) {
		if (key.includes(`:${clientId}:${tokenUrl}:`)) {
			tokenCache.delete(key);
		}
	}
}

/**
 * Clear all cached OAuth tokens
 */
export function clearAllOAuthTokens(): void {
	tokenCache.clear();
}
