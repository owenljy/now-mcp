/**
 * Input validation utilities
 */

import type { InstanceManager } from '../client/instance-manager.js';
import { readOnlyRemediation } from '../config/environment.js';
import { AccessDeniedError, ServiceNowError, ValidationError } from '../types/errors.js';
import { assertTableAllowed } from './table-access.js';

/**
 * Validates a ServiceNow sys_id format (32-character hexadecimal)
 */
export function validateSysId(sysId: string): void {
	const sysIdPattern = /^[a-f0-9]{32}$/i;

	if (!sysIdPattern.test(sysId)) {
		throw new ValidationError(
			`Invalid sys_id format: "${sysId}". Expected 32-character hexadecimal string.`,
			{ sysId, expectedPattern: sysIdPattern.source },
		);
	}
}

/**
 * Validates a table name (basic validation)
 */
export function validateTableName(tableName: string): void {
	if (!tableName || tableName.trim().length === 0) {
		throw new ValidationError('Table name cannot be empty');
	}

	// Table names should only contain alphanumeric characters and underscores
	const tableNamePattern = /^[a-z0-9_]+$/i;

	if (!tableNamePattern.test(tableName)) {
		throw new ValidationError(
			`Invalid table name: "${tableName}". Table names should only contain letters, numbers, and underscores.`,
			{ tableName, expectedPattern: tableNamePattern.source },
		);
	}

	// Defense-in-depth: gate every table operation through the allow/deny lists.
	assertTableAllowed(tableName);
}

// Obviously-malicious content we refuse to pass through. These are XSS-oriented:
// the query itself is sent as a REST query parameter (not rendered as HTML), so
// this is defense-in-depth against a value being reflected somewhere downstream.
// NOTE: we intentionally do NOT block "javascript:" — ServiceNow encoded queries
// (and this server's natural-language translation) legitimately use glide
// expressions like "javascript:gs.beginningOfToday()".
const DANGEROUS_QUERY_PATTERNS = [
	/<script/i,
	/on\w+\s*=/i, // HTML event handlers like onclick=
	/eval\(/i,
];

// Splits an encoded query into its conditions. Conditions are joined by "^",
// optionally with a logical marker (^OR / ^NQ / ^EQ) that is part of the
// separator, not of the condition text.
const CONDITION_SEPARATOR = /\^(?:OR|NQ|EQ)?/;

// Matches a leading "<field><operator>" so we can isolate the value that follows.
// The field token is lowercase ([a-z0-9_.]) to mirror real ServiceNow column
// names; this is what keeps a benign field name (e.g. `execution_plan`) from
// being scanned as if it were payload — the historical `on\w+=` false positive
// (`...on_plan=`). Longer word operators are listed before their prefixes so the
// alternation is greedy where it matters (STARTSWITH before nothing, >= before >).
const FIELD_OPERATOR =
	/^[a-z0-9_.]+(?:!=|>=|<=|=|>|<|STARTSWITH|ENDSWITH|NOT LIKE|LIKE|NOT IN|IN|SAMEAS|NSAMEAS|INSTANCEOF|BETWEEN|DYNAMIC|ANYTHING|ISNOTEMPTY|ISEMPTY|VALCHANGES|CHANGES)/;

/**
 * Extracts the segments of an encoded query that should be scanned for dangerous
 * content. For a well-formed `field<op>value` condition, only the value is
 * returned — field names and operators are structure, not payload. For a segment
 * that doesn't parse as a condition (e.g. a raw `<script>...` or `eval(...)`
 * blob), the whole segment is returned so genuine injection attempts are still
 * caught.
 */
function extractScannableSegments(query: string): string[] {
	const segments: string[] = [];

	for (const condition of query.split(CONDITION_SEPARATOR)) {
		if (!condition) {
			continue;
		}

		const match = FIELD_OPERATOR.exec(condition);
		if (match) {
			// A recognized condition: scan only the value that follows the operator.
			segments.push(condition.slice(match[0].length));
		} else {
			// Not a parseable condition — scan the raw text conservatively.
			segments.push(condition);
		}
	}

	return segments;
}

/**
 * Sanitizes an encoded query to prevent basic injection attempts.
 *
 * ServiceNow's encoded queries are generally safe, but we scan for obviously
 * malicious content as defense-in-depth. Crucially, the scan is applied to the
 * VALUE portion of each condition, never to field names or operators — otherwise
 * a legitimate field name whose characters happen to form an XSS signature (the
 * classic `execution_plan=` → `on_plan=` collision with `on\w+=`) gets rejected.
 */
export function sanitizeQuery(query: string): string {
	if (!query) {
		return query;
	}

	const sanitized = query.trim();

	for (const segment of extractScannableSegments(sanitized)) {
		for (const pattern of DANGEROUS_QUERY_PATTERNS) {
			if (pattern.test(segment)) {
				throw new ValidationError('Query contains potentially dangerous content', {
					query: sanitized,
				});
			}
		}
	}

	return sanitized;
}

/**
 * Validates pagination parameters
 */
export function validatePagination(limit?: number, offset?: number): void {
	if (limit !== undefined) {
		if (limit < 1 || limit > 10000) {
			throw new ValidationError(`Invalid limit: ${limit}. Limit must be between 1 and 10000.`, {
				limit,
				min: 1,
				max: 10000,
			});
		}
	}

	if (offset !== undefined) {
		if (offset < 0) {
			throw new ValidationError(`Invalid offset: ${offset}. Offset must be 0 or greater.`, {
				offset,
				min: 0,
			});
		}
	}
}

/**
 * Validates file name for attachments
 */
export function validateFileName(fileName: string): void {
	if (!fileName || fileName.trim().length === 0) {
		throw new ValidationError('File name cannot be empty');
	}

	// Check for path traversal attempts
	if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
		throw new ValidationError(
			`Invalid file name: "${fileName}". File names cannot contain path separators or parent directory references.`,
			{ fileName },
		);
	}

	// Check for reasonable length (ServiceNow supports up to 100 characters)
	if (fileName.length > 100) {
		throw new ValidationError(
			`File name too long: "${fileName}". Maximum length is 100 characters.`,
			{ fileName, maxLength: 100 },
		);
	}
}

/**
 * Validates write access for a given instance
 * Throws AccessDeniedError if instance is configured as read-only
 * Note: readOnly defaults to true if not explicitly set to false
 */
export function validateWriteAccess(instanceManager: InstanceManager, instanceName?: string): void {
	// Optional-call keeps lightweight service mocks/backward-compatible manager
	// implementations working; the real InstanceManager always provides it.
	if (!instanceName && instanceManager.isDefaultAlignmentPending?.()) {
		throw new ServiceNowError(
			'Default instance alignment with now-sdk is still resolving. Nothing was sent. ' +
				'Retry shortly, or pass an explicit instance name to write to a known target.',
			503,
			{
				operationType: 'write',
				defaultAlignmentPending: true,
				currentDefault: instanceManager.getDefaultInstance(),
			},
			'DEFAULT_ALIGNMENT_PENDING',
		);
	}
	const config = instanceManager.getConfig(instanceName);
	// Default to read-only (true) if not explicitly set to false
	const isReadOnly = config.readOnly !== false;

	if (isReadOnly) {
		// Point at the EXACT place to flip read-only, based on where this config
		// came from (plugin form / env vs a specific YAML file) — so the caller
		// doesn't have to go hunting for a config that may not even be a YAML.
		const suggestion = readOnlyRemediation(instanceManager.getConfigSource(), config.name);
		throw new AccessDeniedError(
			`Write operations are not permitted on read-only instance '${config.name}'. ${suggestion}`,
			{
				instance: config.name,
				operationType: 'write',
				readOnlyExplicit: config.readOnly === true,
				readOnlyDefault: config.readOnly === undefined,
				suggestion,
			},
		);
	}
}
