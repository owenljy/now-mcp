/**
 * Shared Zod field builders reused across the tool input schemas.
 *
 * Why this file exists: every tool schema re-declared the same `instance`,
 * `tableName`, and `sys_id` fields inline, and the SDK inlines each field's
 * description + validation messages into the advertised JSON Schema. That
 * duplicated text ships in the tool list on every session. Centralizing the
 * fields here — with short, uniform messages — keeps that always-loaded surface
 * small and the wording consistent.
 *
 * `instanceField` is a shared immutable schema (safe to reuse across objects);
 * the sys_id / table helpers are functions so a caller can pass a label for the
 * (short) validation message.
 */

import { z } from 'zod';

/** Optional target-instance selector present on almost every tool. */
export const instanceField = z
	.string()
	.optional()
	.describe('Target instance; omit for the default.');

/** Table name: non-empty, `[a-z0-9_]` only. */
export function tableNameField() {
	return z
		.string()
		.min(1, 'table name required')
		.regex(/^[a-z0-9_]+$/i, 'letters, numbers, underscores only');
}

/** A 32-char hex sys_id. `label` names the field in the (short) error message. */
export function sysIdField(label = 'sys_id') {
	return z
		.string()
		.length(32, `${label}: 32 chars`)
		.regex(/^[a-f0-9]{32}$/i, `${label}: hex only`);
}

/** Skip the pre-flight field-name validation against the cached table schema. */
export const skipFieldValidationField = z
	.boolean()
	.optional()
	.describe('Skip pre-flight field-name validation against the table schema.');

/** partial = PATCH (only provided fields); full = PUT (replace whole record). */
export const updateTypeField = z
	.enum(['partial', 'full'])
	.default('partial')
	.describe('partial = PATCH (provided fields only); full = PUT (replace record).');

/**
 * Acknowledge that a plain Table API insert is the wrong path for this table and
 * do it anyway. Gates the write-routing guard (see utils/write-routing.ts),
 * which blocks inserts that would bypass a mandatory platform engine — creating
 * duplicate CIs, or a request record no workflow ever picks up.
 */
export const acknowledgeRoutingRiskField = z
	.boolean()
	.optional()
	.default(false)
	.describe('Insert directly even though this table has a required purpose-built API.');

/**
 * Batch failure policy. true (default): finish remaining records after a
 * failure; false: stop before the next wave (records already dispatched in the
 * current wave still complete).
 */
export const continueOnErrorField = z
	.boolean()
	.default(true)
	.describe('On failure: true (default) finishes the rest; false stops before the next wave.');
