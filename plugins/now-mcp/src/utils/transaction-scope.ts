/**
 * sysparm_transaction_scope helper for writes into scoped-app tables.
 *
 * Without it, a write to a scoped table still lands in that table, but runs
 * under the caller's own session scope (typically global for an integration
 * user) — so a before-insert/update business rule that checks
 * gs.getCurrentScopeName() sees the wrong scope even though the row itself is
 * correctly placed. sysparm_transaction_scope runs the whole request in the
 * target app's scope instead.
 */

import type { SchemaService } from '../services/schema-service.js';
import { logger } from './logger.js';

/**
 * Query-string suffix (including the leading "&") to append to a Table API
 * write endpoint, or '' when the table is global or its scope can't be
 * resolved (no SchemaService wired, no read access, network failure). Never
 * throws — scope resolution is advisory and must never block the write that
 * asked for it, the same posture SchemaService.resolveTableScope itself takes.
 * The try/catch here is defense-in-depth for that same invariant, independent
 * of whether the callee honors it.
 */
export async function transactionScopeParam(
	schemaService: SchemaService | undefined,
	tableName: string,
	instance?: string,
): Promise<string> {
	if (!schemaService) return '';
	try {
		const scope = await schemaService.resolveTableScope(tableName, instance);
		return scope.scoped && scope.scopeSysId
			? `&sysparm_transaction_scope=${encodeURIComponent(scope.scopeSysId)}`
			: '';
	} catch (error) {
		logger.debug(`Transaction-scope resolution skipped for ${tableName}`, {
			error: error instanceof Error ? error.message : String(error),
		});
		return '';
	}
}
