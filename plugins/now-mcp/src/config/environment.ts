import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { z } from 'zod';
import type { InstanceConfig } from '../types/instance.js';
import { logger } from '../utils/logger.js';
import { findInstanceByHost, isNowSdkAvailable, resolveProfile } from '../utils/now-sdk-cli.js';

// Define authentication schemas
const BasicAuthConfigSchema = z.object({
	type: z.literal('basic'),
	username: z.string().min(1, 'Username is required'),
	password: z.string().min(1, 'Password is required'),
});

// Kept as a plain ZodObject (no refinement) so it stays usable inside the
// discriminatedUnion below. The cross-field rule (password grant needs
// username/password) is enforced on InstanceConfigSchema instead.
const OAuthConfigSchema = z.object({
	type: z.literal('oauth'),
	// Defaults to client_credentials when omitted, so existing OAuth configs
	// (clientId/secret/tokenUrl only) keep working unchanged.
	grantType: z.enum(['client_credentials', 'password']).default('client_credentials'),
	clientId: z.string().min(1, 'Client ID is required'),
	clientSecret: z.string().min(1, 'Client secret is required'),
	tokenUrl: z.string().url('Token URL must be a valid URL'),
	username: z.string().min(1).optional(),
	password: z.string().min(1).optional(),
	scope: z.string().min(1).optional(),
});

const AuthConfigSchema = z.discriminatedUnion('type', [BasicAuthConfigSchema, OAuthConfigSchema]);

// Define instance configuration schema
const InstanceConfigSchema = z
	.object({
		// Coerce to string: ServiceNow instance/PDI names are often purely numeric
		// (e.g. 123456), which YAML parses as a number. Accept that without quotes.
		name: z.coerce
			.string()
			.regex(
				/^[a-zA-Z0-9_-]+$/,
				'Instance name must contain only alphanumeric characters, underscores, and hyphens',
			),
		url: z
			.string()
			.url('Invalid ServiceNow instance URL')
			.refine((url) => url.startsWith('https://'), {
				message: 'ServiceNow instance URL must use HTTPS',
			}),
		auth: AuthConfigSchema,
		default: z.boolean().default(false),
		timeout: z
			.number()
			.min(1)
			.max(120)
			.optional()
			.describe(
				'HTTP request timeout in seconds (1–120, default 30). Applies to individual Table/Stats API calls, not the background-script execution timeout.',
			),
		readOnly: z.boolean().default(true), // Default to true for safety
		scriptApiPath: z.string().optional(),
	})
	.superRefine((cfg, ctx) => {
		// The OAuth password (Resource Owner) grant needs a user identity.
		if (cfg.auth.type === 'oauth' && cfg.auth.grantType === 'password') {
			if (!cfg.auth.username) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['auth', 'username'],
					message: 'username is required when OAuth grantType is "password"',
				});
			}
			if (!cfg.auth.password) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['auth', 'password'],
					message: 'password is required when OAuth grantType is "password"',
				});
			}
		}
	});

// Define multi-instance configuration schema
const MultiInstanceConfigSchema = z
	.object({
		instances: z.array(InstanceConfigSchema).min(1, 'At least one instance is required'),
	})
	.transform((data) => {
		const defaults = data.instances.filter((i) => i.default);
		if (defaults.length === 1) return data;

		// 0 or 2+ defaults — use now-sdk's active instance as the tiebreaker.
		let winner: string | null = null;
		let reason = '';

		if (isNowSdkAvailable()) {
			const profile = resolveProfile();
			if (profile) {
				const matched = findInstanceByHost(data.instances, profile.host);
				if (matched) {
					winner = matched;
					reason = ` (matched now-sdk active profile '${profile.alias}')`;
				}
			}
		}

		if (!winner) {
			// Fallback: last explicit default wins, or first instance when none set.
			winner = defaults.length > 1 ? defaults[defaults.length - 1].name : data.instances[0].name;
			reason = defaults.length > 1 ? ' (last explicit default)' : ' (first instance)';
		}

		logger.warn(
			`Config has ${defaults.length} default instance(s); auto-selecting '${winner}'${reason}. ` +
				`Update the default: flags in your YAML to silence this.`,
		);

		for (const i of data.instances) {
			i.default = i.name === winner;
		}
		return data;
	})
	.refine(
		(data) => {
			const names = data.instances.map((i) => i.name);
			const uniqueNames = new Set(names);
			return names.length === uniqueNames.size;
		},
		{ message: 'Instance names must be unique' },
	);

/**
 * Where the resolved config came from. Kept on the Environment so a runtime
 * error (e.g. a read-only write block) can point the user at the EXACT place to
 * change — the plugin form / env vars, or a specific YAML file — instead of
 * assuming a YAML that a plugin-form install doesn't have.
 */
export type ConfigSource =
	| { kind: 'env' } // single-instance fast path (plugin form / SERVICENOW_* env vars)
	| { kind: 'yaml'; path: string }; // a YAML file (explicit path or cwd default)

/**
 * Human-facing, source-specific instruction for flipping an instance out of
 * read-only. Shared by validateWriteAccess and the 403 hint so the guidance is
 * identical wherever a write is blocked.
 */
export function readOnlyRemediation(
	source: ConfigSource | undefined,
	instanceName: string,
): string {
	if (source?.kind === 'yaml') {
		return `Set readOnly: false on instance '${instanceName}' in ${source.path}, then reload the plugin (or restart the MCP server).`;
	}
	// env fast path (plugin form) — or unknown, which for a single-instance install
	// is overwhelmingly the plugin form.
	return "This instance is configured via the plugin form / env vars (no YAML). Set the 'Read-only' field to false in the now-mcp plugin config (or SERVICENOW_READ_ONLY=false), then reload plugins.";
}

// Environment configuration type
export interface Environment {
	instances: InstanceConfig[];
	logLevel: 'debug' | 'info' | 'warn' | 'error';
	/** Where this config was resolved from (for source-aware error guidance). */
	source: ConfigSource;
}

let cachedConfig: Environment | null = null;

/**
 * Absolute path to the annotated YAML template shipped with the plugin
 * (config/sn-credential.example.yaml). Resolved relative to this module so it's
 * correct wherever the plugin is installed. Surfaced in the startup log and the
 * no-config error so YAML/OAuth/multi-instance users find it without hunting.
 */
export function exampleConfigPath(): string {
	// build/config/environment.js → plugin root is two levels up.
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.resolve(here, '..', '..', 'config', 'sn-credential.example.yaml');
}

/**
 * Load and validate the YAML configuration file.
 * @param configPath Path to the YAML config file
 * @returns Environment configuration
 */
function loadYamlConfig(configPath: string): Environment {
	try {
		const configContent = fs.readFileSync(configPath, 'utf-8');
		// YAML is a superset of JSON, so this also parses any legacy JSON content.
		const configData = yaml.load(configContent);

		const result = MultiInstanceConfigSchema.safeParse(configData);

		if (!result.success) {
			const errors = result.error.errors
				.map((err) => `  - ${err.path.join('.')}: ${err.message}`)
				.join('\n');

			throw new Error(
				`Configuration validation failed:\n${errors}\n\n` +
					`Please check your configuration file at ${configPath}`,
			);
		}

		return {
			instances: result.data.instances,
			logLevel: (process.env.LOG_LEVEL as Environment['logLevel']) || 'info',
			source: { kind: 'yaml', path: configPath },
		};
	} catch (error) {
		if (error instanceof Error) {
			if (error.message.includes('validation failed')) {
				throw error;
			}
			throw new Error(`Failed to load configuration from ${configPath}: ${error.message}`);
		}
		throw new Error(`Failed to load configuration from ${configPath}`);
	}
}

/**
 * Re-read a YAML configuration from disk without consulting the startup cache.
 * Runtime recovery tools use this after the file has been edited in place.
 * The caller is responsible for applying the returned configuration atomically.
 */
export function reloadYamlConfig(configPath: string): Environment {
	return loadYamlConfig(path.resolve(configPath));
}

/**
 * Resolve which configured instance now-sdk wants to be active, by matching its
 * selected auth profile's host against the given instances. Returns the instance
 * NAME to switch the default to, or null to keep the YAML's own default.
 *
 * This is the (potentially ~3s, now-sdk-spawning) half of the follow feature,
 * split out from loadConfig so it can run in the BACKGROUND after the server is
 * already serving — the handshake never blocks on a now-sdk probe.
 *
 * Follow is ON by default; opt out with SERVICENOW_FOLLOW_NOW_SDK=false
 * (or 0/no/off). Returns null (no switch) when the flag is off, now-sdk is
 * absent, there's no default profile, or no instance matches its host.
 */
export function resolveNowSdkFollow(
	instances: Array<{ name: string; url: string }>,
): string | null {
	const flag = process.env.SERVICENOW_FOLLOW_NOW_SDK;
	if (flag !== undefined && /^(0|false|no|off)$/i.test(flag.trim())) {
		return null;
	}

	if (!isNowSdkAvailable()) {
		logger.debug('follow-now-sdk: now-sdk not on PATH; using the YAML default.');
		return null;
	}
	const profile = resolveProfile();
	if (!profile) {
		logger.debug('follow-now-sdk: no default now-sdk auth profile found; using the YAML default.');
		return null;
	}
	const matchName = findInstanceByHost(instances, profile.host);
	if (!matchName) {
		logger.warn(
			`follow-now-sdk: now-sdk's active instance '${profile.host}' (alias '${profile.alias}') ` +
				'has no matching entry in the configured instances; using the default. ' +
				'Add that instance (with its password) to follow it, or set SERVICENOW_FOLLOW_NOW_SDK=false.',
		);
		return null;
	}
	logger.info(
		`Following now-sdk: active instance = '${matchName}' (now-sdk alias '${profile.alias}').`,
	);
	return matchName;
}

/** Read an env var, treating whitespace-only (and unset) as absent.
 * Plugin setup forms may substitute an empty string when a field is left blank,
 * so empty must mean "not provided" the same as unset. */
function envValue(name: string): string | undefined {
	const v = process.env[name];
	if (v === undefined) return undefined;
	const trimmed = v.trim();
	return trimmed === '' ? undefined : trimmed;
}

/**
 * The single-instance FAST PATH: build one basic-auth instance straight from
 * environment variables, no YAML file required. Host setup forms can feed
 * SERVICENOW_URL / _USERNAME / _PASSWORD / _READ_ONLY, so a single-instance
 * user never has to create a file or type a path.
 *
 * Scope is deliberately narrow — basic auth, one instance. OAuth and
 * multi-instance setups stay in YAML (see the docs), because the portable
 * environment-variable interface does not express an instance array.
 *
 * @returns the Environment when SERVICENOW_URL is set, or null when no fast-path
 *   var is present (so the caller falls through to the YAML lookup).
 * @throws Error naming the missing field when SERVICENOW_URL is set but the
 *   credentials are incomplete — a precise message instead of "no config found".
 */
function buildSingleInstanceFromEnv(): Environment | null {
	const url = envValue('SERVICENOW_URL');
	const username = envValue('SERVICENOW_USERNAME');
	const password = envValue('SERVICENOW_PASSWORD');

	// No URL → this path doesn't apply. (Stray creds without a URL also fall
	// through; the enriched no-config error will list what was seen.)
	if (!url) return null;

	const missing: string[] = [];
	if (!username) missing.push('SERVICENOW_USERNAME');
	if (!password) missing.push('SERVICENOW_PASSWORD');
	if (missing.length > 0) {
		throw new Error(
			`SERVICENOW_URL is set (${url}) but the single-instance fast path is ` +
				`missing: ${missing.join(', ')}.\n\n` +
				'Provide the username and password (in the plugin form, or as env ' +
				'vars), or use a YAML config file for OAuth / multi-instance setups.',
		);
	}

	// Derive a valid instance name from the host's first label (e.g.
	// dev123456.service-now.com → "dev123456"); fall back to "default".
	let name = 'default';
	try {
		const label = new URL(url).hostname.split('.')[0];
		if (/^[a-zA-Z0-9_-]+$/.test(label)) name = label;
	} catch {
		// URL parsing errors surface through schema validation below.
	}

	// Parse the read-only flag from a free-text field. Fail SAFE: only explicit
	// false-y words open writes; anything unrecognized stays read-only. Warn on
	// unrecognized non-empty input so a typo like "flase" (meant to enable writes)
	// isn't silently swallowed into read-only.
	const readOnlyEnv = envValue('SERVICENOW_READ_ONLY');
	const FALSEY = /^(0|false|no|off)$/i;
	const TRUEY = /^(1|true|yes|on)$/i;
	let readOnly = true;
	if (readOnlyEnv !== undefined) {
		if (FALSEY.test(readOnlyEnv)) {
			readOnly = false;
		} else if (!TRUEY.test(readOnlyEnv)) {
			logger.warn(
				`SERVICENOW_READ_ONLY="${readOnlyEnv}" is not recognized; defaulting to ` +
					'read-only (writes blocked). Use "false" to allow writes, or "true" for read-only.',
			);
		}
	}

	const candidate = {
		instances: [
			{ name, url, auth: { type: 'basic', username, password }, default: true, readOnly },
		],
	};

	// Validate through the same schema the YAML path uses (single default ⇒ the
	// transform skips the now-sdk probe).
	const result = MultiInstanceConfigSchema.safeParse(candidate);
	if (!result.success) {
		const errors = result.error.errors
			.map((err) => `  - ${err.path.join('.')}: ${err.message}`)
			.join('\n');
		throw new Error(
			`Single-instance fast-path configuration is invalid:\n${errors}\n\n` +
				'Check SERVICENOW_URL (must be an https:// ServiceNow URL) and credentials.',
		);
	}

	return {
		instances: result.data.instances,
		logLevel: (process.env.LOG_LEVEL as Environment['logLevel']) || 'info',
		source: { kind: 'env' },
	};
}

/**
 * Load configuration. Resolution order:
 *   1. SERVICENOW_CONFIG_PATH — an explicit YAML file at any path.
 *   2. SERVICENOW_URL (+ _USERNAME/_PASSWORD) — the single-instance fast path
 *      (basic auth, no file needed; what the plugin form feeds).
 *   3. config/sn-credential.yaml (or .yml) in the working directory.
 * A YAML file (1 or 3) supports single OR multi-instance and OAuth; the fast
 * path (2) is basic-auth single-instance only.
 *
 * now-sdk follow (on by default) is NOT applied here — it would spawn now-sdk
 * (~3s) on the startup/handshake path. loadConfig stays fast and returns the
 * YAML's own default; the follow re-point runs in the background after the
 * server is serving (see resolveNowSdkFollow + index.ts).
 *
 * @throws Error with setup guidance if no configuration is found.
 */
export function loadConfig(): Environment {
	if (cachedConfig) return cachedConfig;

	// 1. Explicit path override (e.g. for a global/out-of-repo registration).
	const customConfigPath = process.env.SERVICENOW_CONFIG_PATH;
	if (customConfigPath && customConfigPath.trim() !== '') {
		const resolvedPath = path.resolve(customConfigPath.trim());
		if (!fs.existsSync(resolvedPath)) {
			throw new Error(`Configuration file not found at SERVICENOW_CONFIG_PATH: ${resolvedPath}`);
		}
		// Both a config file AND the fast-path fields were provided. The file wins
		// (documented precedence); warn so the ignored form values aren't a silent
		// surprise when someone expected them to take effect.
		if (envValue('SERVICENOW_URL')) {
			logger.warn(
				`A config file (${resolvedPath}) and the single-instance fields ` +
					'(SERVICENOW_URL/USERNAME/PASSWORD) are both set. Using the config ' +
					'file; the URL/username/password fields are ignored. Clear the config ' +
					'file field to use them instead.',
			);
		}
		cachedConfig = loadYamlConfig(resolvedPath);
		return cachedConfig;
	}

	// 2. Single-instance fast path from environment variables (plugin form).
	const fromEnv = buildSingleInstanceFromEnv();
	if (fromEnv) {
		cachedConfig = fromEnv;
		return cachedConfig;
	}

	// 3. Default YAML in the working directory.
	const defaultConfigPath = [
		path.resolve('config/sn-credential.yaml'),
		path.resolve('config/sn-credential.yml'),
	].find((p) => fs.existsSync(p));

	if (defaultConfigPath) {
		cachedConfig = loadYamlConfig(defaultConfigPath);
		return cachedConfig;
	}

	// No config anywhere — report exactly what was checked so the fix is obvious
	// regardless of install mode (plugin form vs. standalone YAML). The password
	// is only ever reported as set/unset, never echoed.
	//
	// We distinguish three states per var:
	//   "not set"      — process.env has no entry (plugin not installed / env not passed)
	//   "set but empty" — plugin form installed but field left blank; an empty
	//                     substitution is treated as absent by envValue()
	//   "set"          — a non-empty value reached us
	function varStatus(name: string, redact = false): string {
		const raw = process.env[name];
		if (raw === undefined) return 'not set';
		if (raw.trim() === '') return 'set but empty (plugin field may be blank)';
		return redact ? 'set' : raw;
	}

	const pathVar = process.env.SERVICENOW_CONFIG_PATH;
	const seen = [
		`SERVICENOW_CONFIG_PATH: ${pathVar === undefined ? 'not set' : pathVar.trim() === '' ? 'set but empty' : `set (${pathVar.trim()}) but file not found`}`,
		`SERVICENOW_URL: ${varStatus('SERVICENOW_URL')}`,
		`SERVICENOW_USERNAME: ${varStatus('SERVICENOW_USERNAME', true)}`,
		`SERVICENOW_PASSWORD: ${varStatus('SERVICENOW_PASSWORD', true)}`,
	];
	throw new Error(
		'No ServiceNow configuration found.\n\n' +
			`Working directory: ${process.cwd()}\n` +
			`Checked:\n  - ${seen.join('\n  - ')}\n\n` +
			'Fix it one of these ways:\n' +
			'  • Plugin: open the now-mcp plugin settings and fill in the instance ' +
			'URL, username, and password (single-instance, basic auth).\n' +
			'  • YAML: copy the annotated template to config/sn-credential.yaml (or ' +
			'anywhere, then set SERVICENOW_CONFIG_PATH) for multi-instance or OAuth.\n' +
			`    Template: ${exampleConfigPath()}`,
	);
}

/**
 * Resets the cached configuration (useful for testing)
 */
export function resetConfig(): void {
	cachedConfig = null;
}

// Export schemas for testing
export {
	AuthConfigSchema,
	BasicAuthConfigSchema,
	InstanceConfigSchema,
	MultiInstanceConfigSchema,
	OAuthConfigSchema,
};
