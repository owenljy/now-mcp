/**
 * Types and interfaces for multi-instance support
 */

/**
 * Authentication configuration for Basic Auth
 */
export interface BasicAuthConfig {
	type: 'basic';
	username: string;
	password: string;
}

/**
 * OAuth 2.0 grant types supported for token acquisition.
 * - `client_credentials`: app-level token from clientId/secret (no user).
 * - `password`: user-level token, exchanges username/password once for a token
 *   (ServiceNow's Resource Owner Password Credentials flow).
 */
export type OAuthGrantType = 'client_credentials' | 'password';

/**
 * Authentication configuration for OAuth 2.0.
 *
 * `grantType` defaults to `client_credentials` when omitted (backward
 * compatible). For `password`, `username` and `password` are required.
 */
export interface OAuthConfig {
	type: 'oauth';
	/** OAuth grant type. Defaults to `client_credentials` when omitted. */
	grantType?: OAuthGrantType;
	clientId: string;
	clientSecret: string;
	tokenUrl: string;
	/** Required when grantType is `password`. */
	username?: string;
	/** Required when grantType is `password`. */
	password?: string;
	/** Optional OAuth scope. */
	scope?: string;
}

/**
 * Union type for authentication configurations
 */
export type AuthConfig = BasicAuthConfig | OAuthConfig;

/**
 * Configuration for a single ServiceNow instance
 */
export interface InstanceConfig {
	/** Unique name identifier for this instance */
	name: string;

	/** HTTPS URL of the ServiceNow instance */
	url: string;

	/** Authentication configuration */
	auth: AuthConfig;

	/** Whether this is the default instance */
	default: boolean;

	/** Request timeout in seconds */
	timeout?: number;

	/** Whether this instance is read-only (defaults to true for safety) */
	readOnly?: boolean;

	/**
	 * Optional path to a custom Scripted REST API that executes background scripts
	 * synchronously (e.g. /api/x_custom/script_runner/execute). This is an example
	 * path, not a built-in ServiceNow route. When set, the
	 * execute_background_script tool POSTs directly here instead of relying on the
	 * ServiceNow scheduler via sys_trigger. The route must already be installed and
	 * active on that specific instance. A failure does not silently fall back.
	 */
	scriptApiPath?: string;
	/** Explicit SDK identity for query fallback; must target this instance's host. */
	nowSdkProfile?: string;
}

/**
 * Multi-instance configuration container
 */
export interface MultiInstanceConfig {
	instances: InstanceConfig[];
}

/**
 * Alias for backward compatibility and CLI usage
 */
export type ServiceNowConfig = MultiInstanceConfig;

/**
 * OAuth token response
 */
export interface OAuthToken {
	accessToken: string;
	refreshToken?: string;
	expiresIn: number;
	tokenType: string;
}

/**
 * Instance connection status
 */
export interface InstanceStatus {
	name: string;
	connected: boolean;
	error?: string;
	lastChecked: Date;
}
