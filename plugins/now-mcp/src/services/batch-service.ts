/**
 * Batch operations service for bulk create/update/delete.
 *
 * Transport: the Table Batch API (`/api/now/v1/batch`) sends one wave of
 * records as ONE HTTP request instead of one request per record. Waves are still
 * sized by `batchConcurrency()`, which keeps the documented `continueOnError`
 * contract intact — a failure stops the next wave, and only records already
 * dispatched in the current wave complete.
 *
 * Instances without the batch endpoint (404/405) fall back to the original
 * looped path. The fallback is decided on the FIRST wave, before anything has
 * been written, so restarting from scratch cannot double-apply a write.
 *
 * Still not transactional: the batch endpoint executes sub-requests
 * independently and reports a status per sub-request. A partial failure leaves
 * the successful records applied, exactly as the looped path did.
 */

import type { InstanceManager } from '../client/instance-manager.js';
import { batchConcurrency, batchDelayMs } from '../config/batch-config.js';
import { API_ENDPOINTS } from '../config/constants.js';
import type { BatchOperationResult } from '../schemas/batch-schemas.js';
import type { RecordData, ServiceNowRecord } from '../types/servicenow.js';
import { logger } from '../utils/logger.js';
import {
	type BatchSubRequest,
	type BatchSubResponse,
	isBatchEndpointUnavailable,
} from '../utils/native-batch.js';
import { transactionScopeParam } from '../utils/transaction-scope.js';
import { validateWriteAccess } from '../utils/validators.js';
import {
	fieldMismatches,
	NOT_PERSISTED_MESSAGE,
	VERIFICATION_EVIDENCE_FIELDS,
} from '../utils/write-verification.js';
import type { SchemaService } from './schema-service.js';
import { TableService } from './table-service.js';

/** Counterpart of NOT_PERSISTED_MESSAGE for a record that survived a delete. */
const NOT_DELETED = 'Delete returned success, but the record still exists.';

/** One entry of a batch result, before counting. */
type ResultEntry = BatchOperationResult['results'][number];

/**
 * Per-instance memo of whether the batch endpoint exists, so an instance that
 * lacks it is probed once per process rather than on every batch call.
 */
const batchEndpointAvailable = new Map<string, boolean>();

/** Exported for tests: forget what we learned about endpoint availability. */
export function resetBatchEndpointCache(): void {
	batchEndpointAvailable.clear();
}

export class BatchService {
	private tableService: TableService;
	private instanceManager: InstanceManager;

	constructor(
		instanceManager: InstanceManager,
		private schemaService?: SchemaService,
	) {
		this.instanceManager = instanceManager;
		this.tableService = new TableService(instanceManager, schemaService);
	}

	/**
	 * Run `items` through the native batch endpoint in waves, mapping each item
	 * to one sub-request and each sub-response back to a result entry.
	 *
	 * Returns null when the endpoint turns out to be unavailable on the first
	 * wave — the signal for the caller to use its looped fallback. Any later
	 * failure is a real error and propagates.
	 */
	private async runWaves<T>(
		items: T[],
		instanceName: string,
		toRequest: (item: T, index: number) => BatchSubRequest,
		interpret: (item: T, index: number, response: BatchSubResponse | undefined) => ResultEntry,
		continueOnError: boolean,
		instance?: string,
	): Promise<BatchOperationResult | null> {
		if (batchEndpointAvailable.get(instanceName) === false) return null;

		const client = this.instanceManager.getClient(instance);
		const concurrency = batchConcurrency();
		const delayMs = batchDelayMs();

		const results: ResultEntry[] = [];
		let successCount = 0;
		let failureCount = 0;

		for (let i = 0; i < items.length; i += concurrency) {
			const wave = items.slice(i, i + concurrency);
			const requests = wave.map((item, offset) => toRequest(item, i + offset));

			let outcome: Awaited<ReturnType<typeof client.batch>>;
			try {
				outcome = await client.batch(requests);
			} catch (error) {
				// Endpoint absent: nothing in this wave ran. Only safe to report on the
				// very first wave — after that, earlier waves are already applied and
				// restarting would re-apply them.
				if (i === 0 && isBatchEndpointUnavailable(error)) {
					batchEndpointAvailable.set(instanceName, false);
					logger.info('Table Batch API unavailable — using looped single calls', {
						instance: instanceName,
					});
					return null;
				}
				throw error;
			}

			batchEndpointAvailable.set(instanceName, true);

			for (const [offset, item] of wave.entries()) {
				const index = i + offset;
				const entry = interpret(item, index, outcome.responses.get(requests[offset].id));
				results[index] = entry;
				if (entry.success) successCount++;
				else failureCount++;
			}

			if (!continueOnError && failureCount > 0) {
				logger.warn('Batch stopping after failure (continueOnError=false)', {
					processed: i + wave.length,
					total: items.length,
				});
				break;
			}

			if (delayMs > 0 && i + concurrency < items.length) {
				await this.sleep(delayMs);
			}
		}

		return { success: failureCount === 0, successCount, failureCount, results };
	}

	/**
	 * Turn a sub-response into a result entry. `undefined` means the sub-request
	 * was never serviced, which must read as a failure — treating a missing
	 * response as success is precisely how a malformed batch envelope would look
	 * like a silent no-op.
	 */
	private static entryFor(
		index: number,
		response: BatchSubResponse | undefined,
		sysIdFrom: (body: unknown) => string | undefined,
		fallbackSysId?: string,
	): ResultEntry {
		if (!response) {
			return {
				index,
				success: false,
				...(fallbackSysId ? { sysId: fallbackSysId } : {}),
				error: 'Not serviced by the batch request.',
			};
		}
		if (response.statusCode >= 400) {
			return {
				index,
				success: false,
				...(fallbackSysId ? { sysId: fallbackSysId } : {}),
				error: response.error ?? `HTTP ${response.statusCode}`,
			};
		}
		// Echo only the sys_id, not the full row: on a large batch the rows are a
		// big payload that then persists in the model's context, while the sys_id is
		// the actionable handle — re-read specific rows with sn_query_records.
		const sysId = sysIdFrom(response.body) ?? fallbackSysId;
		return { index, success: true, ...(sysId ? { sysId } : {}) };
	}

	/** Pull sys_id out of a Table API single-record response body. */
	private static sysIdOfResult(body: unknown): string | undefined {
		const result = (body as { result?: { sys_id?: unknown } } | undefined)?.result;
		return typeof result?.sys_id === 'string' ? result.sys_id : undefined;
	}

	/**
	 * Create multiple records
	 * @param tableName Name of the table
	 * @param records Array of record data objects
	 * @param continueOnError Whether to continue on individual failures
	 * @param instance Optional instance name
	 */
	async batchCreate(
		tableName: string,
		records: RecordData[],
		continueOnError: boolean = true,
		instance?: string,
	): Promise<BatchOperationResult> {
		validateWriteAccess(this.instanceManager, instance);

		const resolved = this.instanceManager.resolveInstance(instance);
		logger.info(`Batch creating ${records.length} records in ${tableName}`, {
			instance: resolved.name,
			continueOnError,
		});

		// Resolved once for the whole call (same table for every record), not
		// per-record — see transaction-scope.ts.
		const scopeParam = await transactionScopeParam(this.schemaService, tableName, instance);

		const native = await this.runWaves(
			records,
			resolved.name,
			(data, index) => ({
				id: `c${index}`,
				method: 'POST',
				// Same reference-link stripping as the single-record create path.
				url: `${API_ENDPOINTS.TABLE_RECORD(tableName)}?sysparm_exclude_reference_link=true${scopeParam}`,
				body: data,
			}),
			(_data, index, response) =>
				BatchService.entryFor(index, response, BatchService.sysIdOfResult),
			continueOnError,
			instance,
		);
		if (native) {
			logger.info(
				`Batch create completed: ${native.successCount} succeeded, ${native.failureCount} failed`,
				{ tableName, instance: resolved.name, transport: 'batch-api' },
			);
			return native;
		}

		return this.loopedWaves(
			records,
			continueOnError,
			async (data, index) => {
				const record = await this.tableService.createRecord<ServiceNowRecord>(
					tableName,
					data,
					instance,
				);
				return { index, success: true, sysId: record.sys_id };
			},
			(_data, index, message) => ({ index, success: false, error: message }),
		);
	}

	/**
	 * Update multiple records
	 * @param tableName Name of the table
	 * @param updates Array of update objects with sysId and fields
	 * @param updateType Type of update (partial or full)
	 * @param continueOnError Whether to continue on individual failures
	 * @param verify Whether to read every updated record back and confirm the
	 *               requested values persisted (one extra batched request)
	 * @param instance Optional instance name
	 */
	async batchUpdate(
		tableName: string,
		updates: Array<{ sysId: string; fields: RecordData }>,
		updateType: 'partial' | 'full' = 'partial',
		continueOnError: boolean = true,
		verify: boolean = false,
		instance?: string,
	): Promise<BatchOperationResult> {
		validateWriteAccess(this.instanceManager, instance);

		const resolved = this.instanceManager.resolveInstance(instance);
		logger.info(`Batch updating ${updates.length} records in ${tableName}`, {
			instance: resolved.name,
			updateType,
			continueOnError,
			verify,
		});

		// Resolved once for the whole call (same table for every record), not
		// per-record — see transaction-scope.ts.
		const scopeParam = await transactionScopeParam(this.schemaService, tableName, instance);

		const native = await this.runWaves(
			updates,
			resolved.name,
			(update, index) => ({
				id: `u${index}`,
				method: updateType === 'full' ? 'PUT' : 'PATCH',
				url: `${API_ENDPOINTS.TABLE_RECORD_BY_ID(tableName, update.sysId)}?sysparm_exclude_reference_link=true${scopeParam}`,
				body: update.fields,
			}),
			(update, index, response) =>
				BatchService.entryFor(index, response, BatchService.sysIdOfResult, update.sysId),
			continueOnError,
			instance,
		);
		if (native) {
			if (verify) await this.verifyUpdatedInBatch(tableName, updates, native, instance);
			logger.info(
				`Batch update completed: ${native.successCount} succeeded, ${native.failureCount} failed`,
				{ tableName, instance: resolved.name, transport: 'batch-api' },
			);
			return native;
		}

		return this.loopedWaves(
			updates,
			continueOnError,
			async (update, index) => {
				const record = await this.tableService.updateRecord<ServiceNowRecord>(
					tableName,
					update.sysId,
					update.fields,
					updateType === 'full',
					instance,
				);
				if (verify) {
					const reread = await this.tableService.getRecord(
						tableName,
						update.sysId,
						[...VERIFICATION_EVIDENCE_FIELDS, ...Object.keys(update.fields)],
						instance,
					);
					const mismatches = fieldMismatches(update.fields, reread);
					if (mismatches.length > 0) {
						return {
							index,
							success: false,
							sysId: update.sysId,
							verified: false,
							mismatches,
							record: reread,
							error: NOT_PERSISTED_MESSAGE,
						};
					}
					return { index, success: true, sysId: update.sysId, verified: true };
				}
				return { index, success: true, sysId: record.sys_id };
			},
			(update, index, message) => ({
				index,
				success: false,
				sysId: update.sysId,
				error: message,
			}),
		);
	}

	/**
	 * Delete multiple records
	 * @param tableName Name of the table
	 * @param sysIds Array of sys_ids to delete
	 * @param continueOnError Whether to continue on individual failures
	 * @param verify Whether to do a read-after-delete check per record
	 * @param instance Optional instance name
	 */
	async batchDelete(
		tableName: string,
		sysIds: string[],
		continueOnError: boolean = true,
		verify: boolean = false,
		instance?: string,
	): Promise<BatchOperationResult> {
		validateWriteAccess(this.instanceManager, instance);

		const resolved = this.instanceManager.resolveInstance(instance);
		logger.info(`Batch deleting ${sysIds.length} records in ${tableName}`, {
			instance: resolved.name,
			continueOnError,
			verify,
		});

		const native = await this.runWaves(
			sysIds,
			resolved.name,
			(sysId, index) => ({
				id: `d${index}`,
				method: 'DELETE',
				url: API_ENDPOINTS.TABLE_RECORD_BY_ID(tableName, sysId),
			}),
			(sysId, index, response) => BatchService.entryFor(index, response, () => undefined, sysId),
			continueOnError,
			instance,
		);

		if (native) {
			if (verify) await this.verifyDeletedInBatch(tableName, native, instance);
			logger.info(
				`Batch delete completed: ${native.successCount} succeeded, ${native.failureCount} failed`,
				{ tableName, instance: resolved.name, transport: 'batch-api' },
			);
			return native;
		}

		return this.loopedWaves(
			sysIds,
			continueOnError,
			async (sysId, index) => {
				await this.tableService.deleteRecord(tableName, sysId, instance);
				if (verify) {
					const gone = await this.readBackConfirmsDeletion(tableName, sysId, instance);
					// Same verdict as the batched path: a record that survived is a
					// failure, not a success carrying verified:false.
					if (!gone) {
						return { index, success: false, sysId, verified: false, error: NOT_DELETED };
					}
					return { index, success: true, sysId, verified: true };
				}
				return { index, success: true, sysId };
			},
			(sysId, index, message) => ({ index, success: false, sysId, error: message }),
		);
	}

	/**
	 * Read back every successfully-updated record in ONE extra batch request and
	 * compare the requested values against what the row now holds.
	 *
	 * This is the check that makes verification affordable for any number of
	 * records: the single-record path pays one extra round trip, and so does a
	 * fifty-record batch. A row whose values did not persist is flipped to a
	 * failure carrying the mismatching fields — ServiceNow answers a write refused
	 * by an ACL or aborted by a business rule with 200 and an echoed row, so
	 * reporting success for it is the one outcome the caller must never be handed.
	 */
	private async verifyUpdatedInBatch(
		tableName: string,
		updates: Array<{ sysId: string; fields: RecordData }>,
		result: BatchOperationResult,
		instance?: string,
	): Promise<void> {
		const updated = result.results.filter((r) => r?.success && r.sysId);
		if (updated.length === 0) return;

		const client = this.instanceManager.getClient(instance);
		const requests: BatchSubRequest[] = updated.map((entry) => {
			const fields = [...VERIFICATION_EVIDENCE_FIELDS, ...Object.keys(updates[entry.index].fields)];
			return {
				id: `v${entry.index}`,
				method: 'GET',
				url:
					`${API_ENDPOINTS.TABLE_RECORD_BY_ID(tableName, entry.sysId as string)}` +
					`?sysparm_exclude_reference_link=true&sysparm_fields=${fields.join(',')}`,
			};
		});

		let outcome: Awaited<ReturnType<typeof client.batch>>;
		try {
			outcome = await client.batch(requests);
		} catch (error) {
			// Verification is an assurance step, not the operation — a failed probe
			// must not turn completed updates into reported failures.
			logger.warn('Batch update verification could not run', {
				tableName,
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}

		for (const entry of updated) {
			const response = outcome.responses.get(`v${entry.index}`);
			const row = (response?.body as { result?: Record<string, unknown> } | undefined)?.result;
			// An unreadable row is not evidence of a failed write (the caller may hold
			// write but not read access), so it stays a success with no verdict.
			if (!response || response.statusCode >= 400 || !row) {
				logger.warn('Batch update verification returned no row', {
					tableName,
					sysId: entry.sysId,
					statusCode: response?.statusCode,
				});
				continue;
			}
			const mismatches = fieldMismatches(updates[entry.index].fields, row);
			entry.verified = mismatches.length === 0;
			if (mismatches.length > 0) {
				entry.success = false;
				entry.mismatches = mismatches;
				entry.record = row;
				entry.error = NOT_PERSISTED_MESSAGE;
				result.successCount--;
				result.failureCount++;
			}
		}
		result.success = result.failureCount === 0;
	}

	/**
	 * Read back every successfully-deleted record in ONE extra batch request and
	 * stamp `verified` on each entry.
	 *
	 * This is why verification can now default to on for any batch size: the old
	 * looped path paid one additional round trip per record, which made verifying
	 * a 50-record delete cost 50 extra requests. Here it costs one.
	 *
	 * A record that reads back successfully was NOT deleted — the API returned
	 * without error but the row survived (a business rule restored it, or the
	 * delete was silently refused). That flips the entry to a failure, because
	 * reporting a successful delete for a record still present is the one outcome
	 * the caller must never be handed.
	 */
	private async verifyDeletedInBatch(
		tableName: string,
		result: BatchOperationResult,
		instance?: string,
	): Promise<void> {
		const deleted = result.results.filter((r) => r?.success && r.sysId);
		if (deleted.length === 0) return;

		const client = this.instanceManager.getClient(instance);
		const requests: BatchSubRequest[] = deleted.map((entry) => ({
			id: `v${entry.index}`,
			method: 'GET',
			url: `${API_ENDPOINTS.TABLE_RECORD_BY_ID(tableName, entry.sysId as string)}?sysparm_fields=sys_id`,
		}));

		let outcome: Awaited<ReturnType<typeof client.batch>>;
		try {
			outcome = await client.batch(requests);
		} catch (error) {
			// Verification is an assurance step, not the operation — a failed probe
			// must not turn completed deletes into reported failures.
			logger.warn('Batch delete verification could not run', {
				tableName,
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}

		for (const entry of deleted) {
			const response = outcome.responses.get(`v${entry.index}`);
			// 404 (or any 4xx on the read-back) is the record being gone, as intended.
			const stillPresent = response !== undefined && response.statusCode < 400;
			entry.verified = !stillPresent;
			if (stillPresent) {
				entry.success = false;
				entry.error = 'Delete returned success, but the record still exists.';
				result.successCount--;
				result.failureCount++;
			}
		}
		result.success = result.failureCount === 0;
	}

	/**
	 * Read a record back after deleting it. A 404/"not found" is the confirmation
	 * that it is gone; anything else means it survived.
	 */
	private async readBackConfirmsDeletion(
		tableName: string,
		sysId: string,
		instance?: string,
	): Promise<boolean> {
		try {
			await this.tableService.getRecord(tableName, sysId, ['sys_id'], instance);
			return false;
		} catch (error) {
			const text = String(error).toLowerCase();
			if (text.includes('404') || text.includes('not found') || text.includes('no record')) {
				return true;
			}
			throw error;
		}
	}

	/**
	 * Fallback transport: the original one-request-per-record loop, run in
	 * concurrency-bounded waves. Kept for instances without the batch endpoint.
	 *
	 * Counts are derived from each entry's own `success` flag rather than from
	 * "attempt did not throw": a verification read-back that finds the write did
	 * not persist returns a FAILURE entry without throwing, and counting it as a
	 * success is exactly the silent failure this path is meant to surface.
	 */
	private async loopedWaves<T>(
		items: T[],
		continueOnError: boolean,
		attempt: (item: T, index: number) => Promise<ResultEntry>,
		onFailure: (item: T, index: number, message: string) => ResultEntry,
	): Promise<BatchOperationResult> {
		const results: ResultEntry[] = [];
		let successCount = 0;
		let failureCount = 0;
		const concurrency = batchConcurrency();
		const delayMs = batchDelayMs();

		for (let i = 0; i < items.length; i += concurrency) {
			const wave = items.slice(i, i + concurrency);

			const promises = wave.map(async (item, offset) => {
				const index = i + offset;
				try {
					const entry = await attempt(item, index);
					results[index] = entry;
					if (entry.success) successCount++;
					else failureCount++;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					results[index] = onFailure(item, index, message);
					failureCount++;
					logger.warn(`Batch operation failed at index ${index}`, { error: message });
					if (!continueOnError) throw error;
				}
			});

			// The records in THIS wave were already dispatched concurrently and can't
			// be recalled; with continueOnError=false we stop *before scheduling the
			// next wave*, bounding the blast radius to the in-flight wave.
			await Promise.allSettled(promises);

			if (!continueOnError && failureCount > 0) break;

			if (delayMs > 0 && i + concurrency < items.length) {
				await this.sleep(delayMs);
			}
		}

		return { success: failureCount === 0, successCount, failureCount, results };
	}

	/**
	 * Sleep utility for delays between waves
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
