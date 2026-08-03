/**
 * Batch operations service for bulk create/update operations
 */

import type { InstanceManager } from '../client/instance-manager.js';
import { batchConcurrency, batchDelayMs } from '../config/batch-config.js';
import type { BatchOperationResult } from '../schemas/batch-schemas.js';
import type { RecordData, ServiceNowRecord } from '../types/servicenow.js';
import { logger } from '../utils/logger.js';
import { validateWriteAccess } from '../utils/validators.js';
import { TableService } from './table-service.js';

export class BatchService {
	private tableService: TableService;
	private instanceManager: InstanceManager;

	constructor(instanceManager: InstanceManager) {
		this.instanceManager = instanceManager;
		this.tableService = new TableService(instanceManager);
	}

	/**
	 * Create multiple records in parallel with controlled concurrency
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

		logger.info(`Batch creating ${records.length} records in ${tableName}`, {
			instance: instance || 'default',
			continueOnError,
		});

		const results: BatchOperationResult['results'] = [];
		let successCount = 0;
		let failureCount = 0;
		const concurrency = batchConcurrency();
		const delayMs = batchDelayMs();

		// Process in batches to avoid overwhelming the server
		for (let i = 0; i < records.length; i += concurrency) {
			const batch = records.slice(i, i + concurrency);
			const batchStartIndex = i;

			logger.debug(`Processing batch ${Math.floor(i / concurrency) + 1}`, {
				batchSize: batch.length,
				startIndex: i,
			});

			// Create promises for all records in this batch
			const batchPromises = batch.map(async (recordData, batchIndex) => {
				const globalIndex = batchStartIndex + batchIndex;

				try {
					const record = await this.tableService.createRecord<ServiceNowRecord>(
						tableName,
						recordData,
						instance,
					);

					// Echo only the sys_id, not the full row. On a large batch the full
					// rows are a big payload that persists in context; the sys_id is the
					// actionable handle — re-read specific rows with query_records.
					results[globalIndex] = {
						index: globalIndex,
						success: true,
						sysId: record.sys_id,
					};

					successCount++;
					return { success: true };
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error);

					results[globalIndex] = {
						index: globalIndex,
						success: false,
						error: errorMessage,
					};

					failureCount++;

					logger.warn(`Failed to create record at index ${globalIndex}`, {
						error: errorMessage,
						tableName,
					});

					if (!continueOnError) {
						throw error;
					}

					return { success: false };
				}
			});

			// Wait for all promises in this batch to complete. The records in THIS
			// batch were already dispatched concurrently and can't be recalled; with
			// continueOnError=false we stop *before scheduling the next batch* so the
			// blast radius is bounded to the in-flight batch rather than every record.
			await Promise.allSettled(batchPromises);

			if (!continueOnError && failureCount > 0) {
				logger.warn(`Batch create stopping after failure (continueOnError=false)`, {
					processed: i + batch.length,
					total: records.length,
				});
				break;
			}

			// Small delay between batches to avoid rate limiting
			if (delayMs > 0 && i + concurrency < records.length) {
				await this.sleep(delayMs);
			}
		}

		logger.info(`Batch create completed: ${successCount} succeeded, ${failureCount} failed`, {
			tableName,
			instance: instance || 'default',
		});

		return {
			success: failureCount === 0,
			successCount,
			failureCount,
			results,
		};
	}

	/**
	 * Update multiple records in parallel with controlled concurrency
	 * @param tableName Name of the table
	 * @param updates Array of update objects with sysId and fields
	 * @param updateType Type of update (partial or full)
	 * @param continueOnError Whether to continue on individual failures
	 * @param instance Optional instance name
	 */
	async batchUpdate(
		tableName: string,
		updates: Array<{ sysId: string; fields: RecordData }>,
		updateType: 'partial' | 'full' = 'partial',
		continueOnError: boolean = true,
		instance?: string,
	): Promise<BatchOperationResult> {
		validateWriteAccess(this.instanceManager, instance);

		logger.info(`Batch updating ${updates.length} records in ${tableName}`, {
			instance: instance || 'default',
			updateType,
			continueOnError,
		});

		const results: BatchOperationResult['results'] = [];
		let successCount = 0;
		let failureCount = 0;
		const concurrency = batchConcurrency();
		const delayMs = batchDelayMs();

		// Process in batches to avoid overwhelming the server
		for (let i = 0; i < updates.length; i += concurrency) {
			const batch = updates.slice(i, i + concurrency);
			const batchStartIndex = i;

			logger.debug(`Processing batch ${Math.floor(i / concurrency) + 1}`, {
				batchSize: batch.length,
				startIndex: i,
			});

			// Create promises for all updates in this batch
			const batchPromises = batch.map(async (update, batchIndex) => {
				const globalIndex = batchStartIndex + batchIndex;

				try {
					const record = await this.tableService.updateRecord<ServiceNowRecord>(
						tableName,
						update.sysId,
						update.fields,
						updateType === 'full',
						instance,
					);

					// Echo only the sys_id, not the full row (see batchCreate) — keeps a
					// large batch result small in context.
					results[globalIndex] = {
						index: globalIndex,
						success: true,
						sysId: record.sys_id,
					};

					successCount++;
					return { success: true };
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error);

					results[globalIndex] = {
						index: globalIndex,
						success: false,
						sysId: update.sysId,
						error: errorMessage,
					};

					failureCount++;

					logger.warn(`Failed to update record at index ${globalIndex}`, {
						error: errorMessage,
						sysId: update.sysId,
						tableName,
					});

					if (!continueOnError) {
						throw error;
					}

					return { success: false };
				}
			});

			// Wait for all promises in this batch to complete. See batchCreate: with
			// continueOnError=false we stop before the next batch (the in-flight batch
			// can't be recalled), bounding the blast radius.
			await Promise.allSettled(batchPromises);

			if (!continueOnError && failureCount > 0) {
				logger.warn(`Batch update stopping after failure (continueOnError=false)`, {
					processed: i + batch.length,
					total: updates.length,
				});
				break;
			}

			// Small delay between batches to avoid rate limiting
			if (delayMs > 0 && i + concurrency < updates.length) {
				await this.sleep(delayMs);
			}
		}

		logger.info(`Batch update completed: ${successCount} succeeded, ${failureCount} failed`, {
			tableName,
			instance: instance || 'default',
		});

		return {
			success: failureCount === 0,
			successCount,
			failureCount,
			results,
		};
	}

	/**
	 * Delete multiple records in parallel with controlled concurrency
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

		logger.info(`Batch deleting ${sysIds.length} records in ${tableName}`, {
			instance: instance || 'default',
			continueOnError,
			verify,
		});

		const results: BatchOperationResult['results'] = [];
		let successCount = 0;
		let failureCount = 0;
		const concurrency = batchConcurrency();
		const delayMs = batchDelayMs();

		// Process in batches to avoid overwhelming the server
		for (let i = 0; i < sysIds.length; i += concurrency) {
			const batch = sysIds.slice(i, i + concurrency);
			const batchStartIndex = i;

			logger.debug(`Processing batch ${Math.floor(i / concurrency) + 1}`, {
				batchSize: batch.length,
				startIndex: i,
			});

			// Create promises for all deletes in this batch
			const batchPromises = batch.map(async (sysId, batchIndex) => {
				const globalIndex = batchStartIndex + batchIndex;

				try {
					await this.tableService.deleteRecord(tableName, sysId, instance);

					// Same read-after-delete check sn_delete_record does for a single
					// record: treat a 404/"not found" on the follow-up read as confirmed
					// deletion, otherwise surface it as a verification failure.
					let verified: boolean | undefined;
					if (verify) {
						try {
							await this.tableService.getRecord(tableName, sysId, ['sys_id'], instance);
							verified = false;
						} catch (verifyError) {
							const text = String(verifyError).toLowerCase();
							if (
								text.includes('404') ||
								text.includes('not found') ||
								text.includes('no record')
							) {
								verified = true;
							} else {
								throw verifyError;
							}
						}
					}

					// Echo only the sys_id, not the full row (see batchCreate).
					results[globalIndex] = {
						index: globalIndex,
						success: true,
						sysId,
						...(verify ? { verified } : {}),
					};

					successCount++;
					return { success: true };
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error);

					results[globalIndex] = {
						index: globalIndex,
						success: false,
						sysId,
						error: errorMessage,
					};

					failureCount++;

					logger.warn(`Failed to delete record at index ${globalIndex}`, {
						error: errorMessage,
						sysId,
						tableName,
					});

					if (!continueOnError) {
						throw error;
					}

					return { success: false };
				}
			});

			// Wait for all promises in this batch to complete. See batchCreate: with
			// continueOnError=false we stop before the next batch (the in-flight batch
			// can't be recalled), bounding the blast radius.
			await Promise.allSettled(batchPromises);

			if (!continueOnError && failureCount > 0) {
				logger.warn(`Batch delete stopping after failure (continueOnError=false)`, {
					processed: i + batch.length,
					total: sysIds.length,
				});
				break;
			}

			// Small delay between batches to avoid rate limiting
			if (delayMs > 0 && i + concurrency < sysIds.length) {
				await this.sleep(delayMs);
			}
		}

		logger.info(`Batch delete completed: ${successCount} succeeded, ${failureCount} failed`, {
			tableName,
			instance: instance || 'default',
		});

		return {
			success: failureCount === 0,
			successCount,
			failureCount,
			results,
		};
	}

	/**
	 * Sleep utility for delays between batches
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
