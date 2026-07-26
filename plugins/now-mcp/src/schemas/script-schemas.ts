/**
 * Zod schemas for script execution validation
 */

import { z } from 'zod';
import { instanceField } from './common.js';

/**
 * Schema for executing arbitrary background scripts via the configured transport.
 */
export const ExecuteBackgroundScriptSchema = z.object({
	instance: instanceField,
	script: z
		.string()
		.min(1, 'Script code is required')
		.describe('JavaScript code to execute on the server'),
	timeout: z
		.number()
		.min(1000, 'Timeout must be at least 1000ms')
		.max(120000, 'Timeout cannot exceed 120000ms (2 minutes)')
		.optional()
		.default(60000)
		.describe('Maximum execution time in milliseconds (default: 60000ms)'),
	allowWrites: z
		.boolean()
		.optional()
		.default(false)
		.describe(
			'Permit write operations (insert/update/delete). Scripts containing writes are blocked by default — set this to true to explicitly approve execution. Writes to metadata/config tables are flagged separately in the response.',
		),
	allowMetadataWrites: z
		.boolean()
		.optional()
		.default(false)
		.describe(
			'Second, explicit approval required for writes to metadata/security/config tables such as sys_security_acl. Requires allowWrites:true. Prefer Fluent source control.',
		),
	resultMode: z
		.enum(['raw', 'json'])
		.optional()
		.default('raw')
		.describe(
			"Use 'json' when the script's final log line is a JSON object. If it contains success:false or ok:false, the MCP call is marked as an application failure even though the script transport completed.",
		),
	mirrorOutputToSystemLog: z
		.boolean()
		.optional()
		.default(false)
		.describe(
			'Also write captured output to syslog. Disabled by default to avoid contaminating diagnostics.',
		),
});

export type ExecuteBackgroundScriptInput = z.infer<typeof ExecuteBackgroundScriptSchema>;
