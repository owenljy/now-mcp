/**
 * Thin bridge to the ServiceNow Fluent SDK CLI (now-sdk).
 *
 * The MCP can't (and shouldn't) read now-sdk's stored credentials — they live
 * in the OS keychain. But it CAN drive the CLI's own commands. This module
 * exposes now-sdk's auth profiles and version, and the pure parsers/helpers to
 * check whether the MCP's configured instance lines up with a now-sdk profile
 * (catching the classic "deployed to dev, queried prod" mistake).
 */

import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { abortable } from './deadline.js';
import { type ProcessResult, runProcess } from './subprocess.js';

export interface NowSdkQueryOptions {
	authProfile?: string;
	signal?: AbortSignal;
	query?: string;
	limit?: number;
	offset?: number;
	fields?: string[];
	displayValue?: boolean | 'all';
	excludeReferenceLink?: boolean;
}

export interface NowSdkQuerySuccess {
	ok: true;
	records: Record<string, unknown>[];
	hasMore: boolean;
	nextOffset: number | null;
	profile: string;
}

export interface NowSdkQueryFailure {
	ok: false;
	reason: string;
}

export type NowSdkQueryResult = NowSdkQuerySuccess | NowSdkQueryFailure;

export interface AuthProfile {
	alias: string;
	host: string;
	type?: string;
	username?: string;
	isDefault: boolean;
}

export interface InstanceAlignment {
	instance: string;
	url: string;
	matchedProfile: string | null; // now-sdk alias whose host matches, if any
	aligned: boolean;
}

/** A parsed semantic version: `4.8.0` → { major: 4, minor: 8, patch: 0 }. */
export interface SemVer {
	major: number;
	minor: number;
	patch: number;
}

/**
 * Parse a now-sdk version string into a SemVer. Tolerant of leading `v`,
 * trailing pre-release/build metadata, and surrounding whitespace. Returns
 * null if no `major.minor` can be found.
 */
export function parseSemVer(version: string | null | undefined): SemVer | null {
	if (!version) return null;
	const m = version.trim().match(/(\d+)\.(\d+)(?:\.(\d+))?/);
	if (!m) return null;
	return {
		major: Number(m[1]),
		minor: Number(m[2]),
		patch: m[3] ? Number(m[3]) : 0,
	};
}

/** Compare two SemVers: negative if a<b, 0 if equal, positive if a>b. */
export function compareSemVer(a: SemVer, b: SemVer): number {
	return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** True if `version` is >= the `>=x.y.z` constraint. Unknown version → false. */
export function satisfiesAtLeast(version: SemVer | null, constraint: string): boolean {
	if (!version) return false;
	const min = parseSemVer(constraint.replace(/^>=/, ''));
	if (!min) return false;
	return compareSemVer(version, min) >= 0;
}

/**
 * The now-sdk release whose `auth --list` text format `parseAuthList` is known
 * to match: a `[now-sdk] Listing all credentials:` preamble, a `*[alias]`
 * default marker, then indented `host/type/username/default` kv lines. This is
 * VERIFIED against 4.8.0, which ignores `-o json` and prints only this human
 * text — so we keep parsing text rather than asking for JSON. The version guard
 * lets callers know when a newer now-sdk might have changed the format out from
 * under the parser.
 */
export const AUTH_LIST_PARSED_VERSION: SemVer = { major: 4, minor: 8, patch: 0 };

/**
 * Guard around the `parseAuthList` text-format assumptions. Returns whether the
 * detected now-sdk version is one whose `auth --list` output we've verified the
 * parser against. A `null` version (now-sdk absent/unprobeable) is treated as
 * unverified. Newer majors are flagged because the format could drift.
 */
export function isAuthListFormatVerified(version: SemVer | null): boolean {
	if (!version) return false;
	// Same major as the verified release: trust the text parser.
	return version.major === AUTH_LIST_PARSED_VERSION.major;
}

/**
 * Minimum now-sdk version each capability the MCP/skill might lean on appeared
 * in. Resolved to booleans against the detected version by `resolveFeatures`,
 * so callers stop *assuming* now-sdk can do something the installed CLI can't.
 *
 * Keys are constraint strings (`>=x.y.z`) so the map is self-documenting in the
 * `sdk_status` output. Add a feature by adding a constraint here.
 */
export const NOW_SDK_FEATURE_CONSTRAINTS: Record<string, string> = {
	// `now-sdk query -o json` (instance read substrate for Fluent authoring).
	query: '>=4.8.0',
	// `now-sdk transform` by sys_id (instance→Fluent capture by record id).
	transformById: '>=4.7.0',
};

/**
 * Resolve {@link NOW_SDK_FEATURE_CONSTRAINTS} to booleans for a detected
 * version. An unknown version (now-sdk absent/unparseable) resolves every
 * feature to `false` — the safe default of assuming nothing.
 */
export function resolveFeatures(version: SemVer | null): Record<string, boolean> {
	const resolved: Record<string, boolean> = {};
	for (const [feature, constraint] of Object.entries(NOW_SDK_FEATURE_CONSTRAINTS)) {
		resolved[feature] = satisfiesAtLeast(version, constraint);
	}
	return resolved;
}

/** Normalize a host for comparison: drop protocol, trailing slash, lowercase. */
export function normalizeHost(url: string): string {
	return url
		.trim()
		.replace(/^https?:\/\//i, '')
		.replace(/\/+$/, '')
		.toLowerCase();
}

/**
 * Parse the output of `now-sdk auth --list` into structured profiles.
 *
 * VERIFIED FACT (4.8.0): `auth --list -o json` ignores `-o json` and prints
 * only human text — a `[now-sdk] Listing all credentials:` preamble, then per
 * credential:
 *   *[alias]           (a leading '*' marks the default)
 *         host = https://...
 *         type = basic
 *         username = admin
 *         default = Yes|No
 * So we parse text, not JSON. The preamble (and any non-`[alias]`/non-kv line)
 * is skipped. Callers can gate these assumptions with
 * {@link isAuthListFormatVerified}.
 */
export function parseAuthList(output: string): AuthProfile[] {
	const profiles: AuthProfile[] = [];
	let current: AuthProfile | null = null;

	for (const rawLine of output.split('\n')) {
		const line = rawLine.trim();
		const aliasMatch = line.match(/^(\*?)\[(.+)\]$/);
		if (aliasMatch) {
			if (current) profiles.push(current);
			current = { alias: aliasMatch[2], host: '', isDefault: aliasMatch[1] === '*' };
			continue;
		}
		if (!current) continue;

		const kv = line.match(/^(host|type|username|default)\s*=\s*(.+)$/i);
		if (!kv) continue;
		const key = kv[1].toLowerCase();
		const value = kv[2].trim();
		if (key === 'host') current.host = value;
		else if (key === 'type') current.type = value;
		else if (key === 'username') current.username = value;
		else if (key === 'default' && /^yes$/i.test(value)) current.isDefault = true;
	}
	if (current) profiles.push(current);

	return profiles;
}

/**
 * Compare the MCP's configured instances against now-sdk auth profiles.
 */
export function computeAlignment(
	configured: Array<{ name: string; url: string }>,
	profiles: AuthProfile[],
): InstanceAlignment[] {
	return configured.map(({ name, url }) => {
		const host = normalizeHost(url);
		const match = profiles.find((p) => normalizeHost(p.host) === host);
		return {
			instance: name,
			url,
			matchedProfile: match ? match.alias : null,
			aligned: Boolean(match),
		};
	});
}

// Bounded timeouts so a missing/slow now-sdk can never stall MCP startup. The
// version probe is the most startup-critical, so it gets the shortest budget.
const DEFAULT_TIMEOUT_MS = 5_000;
const VERSION_TIMEOUT_MS = 2_000;

async function runNowSdk(
	args: string[],
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
	signal?: AbortSignal,
): Promise<ProcessResult> {
	return runProcess('now-sdk', args, { timeoutMs, signal });
}

/**
 * Parse the machine-readable envelope emitted by `now-sdk query -o json`.
 * Kept pure both for contract tests and so malformed CLI output fails closed.
 */
export function parseNowSdkQueryOutput(output: string): Omit<NowSdkQuerySuccess, 'profile'> | null {
	try {
		const parsed = JSON.parse(output.trim()) as {
			ok?: unknown;
			records?: unknown;
			hasMore?: unknown;
			nextOffset?: unknown;
		};
		if (parsed.ok !== true || !Array.isArray(parsed.records)) return null;
		if (
			!parsed.records.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row))
		) {
			return null;
		}
		return {
			ok: true,
			records: parsed.records as Record<string, unknown>[],
			hasMore: parsed.hasMore === true,
			nextOffset:
				typeof parsed.nextOffset === 'number' && Number.isFinite(parsed.nextOffset)
					? parsed.nextOffset
					: null,
		};
	} catch {
		return null;
	}
}

/**
 * Execute the CLI's independent, read-only query path with an explicit auth
 * alias. Arguments are passed directly to spawnSync (never through a shell).
 */
export async function runNowSdkQuery(
	profile: string,
	table: string,
	options: NowSdkQueryOptions = {},
): Promise<NowSdkQueryResult> {
	const requestTimeoutMs = 30_000;
	const args = [
		'query',
		table,
		'--query',
		options.query || 'sys_idISNOTEMPTY',
		'--limit',
		String(options.limit ?? 100),
		'--offset',
		String(options.offset ?? 0),
		'--auth',
		profile,
		'--timeout',
		String(requestTimeoutMs),
		'--output',
		'json',
	];
	if (options.fields?.length) args.push('--fields', options.fields.join(','));
	if (options.displayValue !== undefined) {
		args.push('--display-value', String(options.displayValue));
	}
	if (options.excludeReferenceLink === false) args.push('--no-exclude-reference-link');

	// Give the process a small shutdown margin beyond now-sdk's own request bound.
	const result = await runNowSdk(args, requestTimeoutMs + 5_000, options.signal);
	if (!result.ok) {
		// Classify, never echo CLI output: it can contain record data or auth material.
		const diagnostic = `${result.stdout}\n${result.stderr}`;
		const reason = /user name or password invalid|authentication failed|\b401\b/i.test(diagnostic)
			? 'selected now-sdk profile authentication failed; update its credentials or explicitly bind another profile'
			: /access denied|not authorized|\b403\b/i.test(diagnostic)
				? 'selected now-sdk profile was denied access'
				: `now-sdk query failed (${result.reason ?? 'exit_failed'})`;
		return { ok: false, reason };
	}
	const parsed = parseNowSdkQueryOutput(result.stdout);
	if (!parsed) return { ok: false, reason: 'now-sdk query returned an invalid JSON envelope' };
	return { ...parsed, profile };
}

/**
 * Run a query only when a now-sdk credential is proven to target the same host
 * as the selected MCP instance. This prevents a recovery path from silently
 * reading a different environment.
 */
export async function queryNowSdkWithAlignedProfile(
	instanceUrl: string,
	table: string,
	options: NowSdkQueryOptions = {},
): Promise<NowSdkQueryResult> {
	if (options.signal?.aborted) return { ok: false, reason: 'now-sdk query cancelled' };
	const version = parseSemVer(await abortable(getNowSdkVersion(), options.signal));
	if (!resolveFeatures(version).query) {
		return { ok: false, reason: 'now-sdk query is unavailable (requires now-sdk >=4.8.0)' };
	}
	if (!isAuthListFormatVerified(version)) {
		return { ok: false, reason: 'installed now-sdk auth-list format is not verified' };
	}
	const selection = selectAlignedProfile(
		await abortable(listNowSdkProfiles(), options.signal),
		instanceUrl,
		options.authProfile,
	);
	if (!selection.ok) return selection;
	return runNowSdkQuery(selection.profile.alias, table, options);
}

export function selectAlignedProfile(
	profiles: AuthProfile[],
	instanceUrl: string,
	alias?: string,
): { ok: true; profile: AuthProfile } | NowSdkQueryFailure {
	const matched = profiles.filter((p) => normalizeHost(p.host) === normalizeHost(instanceUrl));
	if (alias) {
		const profile = matched.find((p) => p.alias === alias);
		return profile
			? { ok: true, profile }
			: {
					ok: false,
					reason:
						'configured nowSdkProfile is missing or does not match the selected instance host',
				};
	}
	if (matched.length === 1) return { ok: true, profile: matched[0] };
	return {
		ok: false,
		reason: matched.length
			? 'multiple now-sdk profiles match this host; set nowSdkProfile explicitly in the instance configuration'
			: 'no now-sdk auth profile matches the selected MCP instance',
	};
}

// Probe `now-sdk --version` once per process — presence and version don't change
// mid-session. This single cached probe answers BOTH "is it available?" and
// "what version?", so we never spawn --version more than once (it was being run
// by isNowSdkAvailable AND getNowSdkVersion, sometimes several times per call).
let versionProbe: Promise<{ available: boolean; version: string | null }> | null = null;

function probeVersion(): Promise<{ available: boolean; version: string | null }> {
	if (versionProbe !== null) return versionProbe;
	versionProbe = runNowSdk(['--version'], VERSION_TIMEOUT_MS).then((res) => ({
		available: res.ok,
		version: res.ok ? res.stdout.trim().split('\n').pop()?.trim() || null : null,
	}));
	return versionProbe;
}

/** True if the now-sdk CLI is available on PATH (cached probe). */
export function isNowSdkAvailable(): boolean {
	return (process.env.PATH ?? '').split(delimiter).some((directory) => {
		try {
			accessSync(
				join(directory, process.platform === 'win32' ? 'now-sdk.cmd' : 'now-sdk'),
				constants.X_OK,
			);
			return true;
		} catch {
			return false;
		}
	});
}

export async function getNowSdkVersion(): Promise<string | null> {
	return (await probeVersion()).version;
}

// `now-sdk auth --list` spawns a JVM-backed CLI that costs ~2.8s per call, and
// several code paths (alignment, follow, sdk_status) need the profile list in
// one session. Cache it briefly so we pay that once. TTL is short so a mid-
// session `now-sdk auth --use/--add` is still picked up within a minute.
const PROFILE_CACHE_TTL_MS = 60_000;
let profileCache: { at: number; profiles: AuthProfile[] } | null = null;
let profileProbe: Promise<AuthProfile[]> | null = null;

export async function listNowSdkProfiles(): Promise<AuthProfile[]> {
	const now = Date.now();
	if (profileCache && now - profileCache.at < PROFILE_CACHE_TTL_MS) {
		return profileCache.profiles;
	}
	if (!profileProbe)
		profileProbe = runNowSdk(['auth', '--list'])
			.then((res) => {
				if (!res.ok) return [];
				const profiles = parseAuthList(res.stdout);
				profileCache = { at: Date.now(), profiles };
				return profiles;
			})
			.finally(() => {
				profileProbe = null;
			});
	return profileProbe;
}

/**
 * Resolve a single now-sdk auth profile: by alias if given, otherwise the
 * default profile (or the only one if there's exactly one). Returns null if no
 * unambiguous match. Used to derive the MCP's target instance URL from now-sdk
 * so both point at the same instance.
 */
/**
 * Pick the default profile from an already-fetched list (default flag, else the
 * sole profile). Pure — lets callers that already have the profile list avoid a
 * second `now-sdk auth --list` spawn.
 */
export function pickDefaultProfile(profiles: AuthProfile[], alias?: string): AuthProfile | null {
	if (alias) return profiles.find((p) => p.alias === alias) || null;
	const def = profiles.find((p) => p.isDefault);
	if (def) return def;
	return profiles.length === 1 ? profiles[0] : null;
}

export async function resolveProfile(alias?: string): Promise<AuthProfile | null> {
	return pickDefaultProfile(await listNowSdkProfiles(), alias);
}

/**
 * Find which configured instance matches a host (by normalized host).
 * Pure helper — used to re-point the active YAML instance to whatever now-sdk
 * is currently set to. Returns the instance name, or null if none match.
 */
export function findInstanceByHost(
	instances: Array<{ name: string; url: string }>,
	host: string,
): string | null {
	const target = normalizeHost(host);
	const match = instances.find((i) => normalizeHost(i.url) === target);
	return match ? match.name : null;
}

/**
 * Summary of whether the MCP's DEFAULT instance lines up with the instance
 * now-sdk is currently connected to (its default auth profile).
 */
export interface DefaultAlignment {
	nowSdkAvailable: boolean;
	nowSdkDefaultProfile: string | null;
	nowSdkDefaultHost: string | null;
	mcpDefaultInstance: string;
	/**
	 * True when no switch is warranted: either the MCP default already matches
	 * now-sdk's default, OR the situation is indeterminate (now-sdk absent, no
	 * default profile, or its host matches no configured instance). In all of
	 * these the caller should NOT prompt to switch.
	 */
	defaultAligned: boolean;
	/** Configured instance name to switch to, or null when none is warranted. */
	recommendedDefaultInstance: string | null;
}

/**
 * Pure core of the default-alignment check: given now-sdk's default profile (or
 * null), the configured instances, and the MCP's current default, decide whether
 * a switch should be recommended. Indeterminate cases report `defaultAligned:
 * true` / `recommendedDefaultInstance: null` so callers never nag.
 */
export function deriveDefaultAlignment(
	profile: AuthProfile | null,
	configured: Array<{ name: string; url: string }>,
	mcpDefaultInstance: string,
	nowSdkAvailable: boolean,
): DefaultAlignment {
	const base = {
		nowSdkAvailable,
		nowSdkDefaultProfile: profile ? profile.alias : null,
		nowSdkDefaultHost: profile ? profile.host : null,
		mcpDefaultInstance,
	};

	if (!nowSdkAvailable || !profile) {
		return { ...base, defaultAligned: true, recommendedDefaultInstance: null };
	}

	const match = findInstanceByHost(configured, profile.host);
	if (!match) {
		// now-sdk points at an instance we don't have configured — can't switch.
		return { ...base, defaultAligned: true, recommendedDefaultInstance: null };
	}

	const aligned = match === mcpDefaultInstance;
	return {
		...base,
		defaultAligned: aligned,
		recommendedDefaultInstance: aligned ? null : match,
	};
}

/**
 * Live default-alignment check: probes now-sdk for its default profile and
 * compares against the MCP's current default instance.
 */
export async function getDefaultAlignment(
	configured: Array<{ name: string; url: string }>,
	mcpDefaultInstance: string,
): Promise<DefaultAlignment> {
	const available = isNowSdkAvailable();
	const profile = available ? await resolveProfile() : null;
	return deriveDefaultAlignment(profile, configured, mcpDefaultInstance, available);
}
