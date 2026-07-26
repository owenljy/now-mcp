/**
 * Attachment service for file operations in ServiceNow
 */

import type { InstanceManager } from '../client/instance-manager.js';
import { API_ENDPOINTS } from '../config/constants.js';
import type {
	AttachmentListResponse,
	AttachmentMetadata,
	AttachmentUploadResponse,
} from '../types/servicenow.js';
import { logger } from '../utils/logger.js';
import {
	validateFileName,
	validateSysId,
	validateTableName,
	validateWriteAccess,
} from '../utils/validators.js';

/**
 * Cap on attachment download size. Downloaded bytes are base64-encoded and held
 * in memory + returned in the tool result, so an unbounded download would blow
 * up memory and context. Override via SERVICENOW_MAX_DOWNLOAD_BYTES.
 */
const MAX_DOWNLOAD_BYTES = (() => {
	const raw = process.env.SERVICENOW_MAX_DOWNLOAD_BYTES;
	const parsed = raw ? Number.parseInt(raw, 10) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 1024 * 1024; // 10 MB
})();

export class AttachmentService {
	constructor(private instanceManager: InstanceManager) {}

	/**
	 * Upload an attachment to a ServiceNow record
	 * @param fileName Name of the file
	 * @param fileContent Base64-encoded file content
	 * @param tableName Name of the table
	 * @param recordSysId System ID of the record to attach to
	 * @param instance Optional instance name (uses default if not specified)
	 */
	async uploadAttachment(
		fileName: string,
		fileContent: string, // Base64-encoded
		tableName: string,
		recordSysId: string,
		instance?: string,
	): Promise<AttachmentMetadata> {
		validateWriteAccess(this.instanceManager, instance);
		validateFileName(fileName);
		validateTableName(tableName);
		validateSysId(recordSysId);

		const client = this.instanceManager.getClient(instance);

		// Decode base64 content to buffer
		const fileBuffer = Buffer.from(fileContent, 'base64');

		logger.debug(`Uploading attachment to ${tableName}/${recordSysId}`, {
			fileName,
			size: fileBuffer.length,
			instance: instance || 'default',
		});

		const response = await client.uploadFile(fileBuffer, fileName, tableName, recordSysId);

		const uploadResponse = response as AttachmentUploadResponse;

		logger.info(`Uploaded attachment ${uploadResponse.result.sys_id}: ${fileName}`, {
			instance: instance || 'default',
		});

		return uploadResponse.result;
	}

	/** Upload already-decoded bytes. Used by local-path input so base64 never enters tool context. */
	async uploadAttachmentBuffer(
		fileName: string,
		fileBuffer: Buffer,
		tableName: string,
		recordSysId: string,
		instance?: string,
	): Promise<AttachmentMetadata> {
		validateWriteAccess(this.instanceManager, instance);
		validateFileName(fileName);
		validateTableName(tableName);
		validateSysId(recordSysId);
		const response = (await this.instanceManager
			.getClient(instance)
			.uploadFile(fileBuffer, fileName, tableName, recordSysId)) as AttachmentUploadResponse;
		return response.result;
	}

	/**
	 * Download an attachment from ServiceNow
	 * @param attachmentSysId System ID of the attachment
	 * @param instance Optional instance name (uses default if not specified)
	 */
	async downloadAttachment(
		attachmentSysId: string,
		instance?: string,
		maxBytes: number = MAX_DOWNLOAD_BYTES,
	): Promise<{
		fileName: string;
		fileContent: string; // Base64-encoded
		contentType: string;
		size: number;
	}> {
		validateSysId(attachmentSysId);

		const client = this.instanceManager.getClient(instance);

		logger.debug(`Downloading attachment ${attachmentSysId}`, {
			instance: instance || 'default',
		});

		// First, get attachment metadata — this gives us the size BEFORE we buffer
		// the whole file, so we can reject oversized downloads up front.
		const metadata = await this.getAttachmentMetadata(attachmentSysId, instance);
		const size = parseInt(metadata.size_bytes, 10);

		if (Number.isFinite(size) && size > maxBytes) {
			throw new Error(
				`Attachment ${attachmentSysId} is ${size} bytes, exceeding the ${maxBytes}-byte download limit. ` +
					`Fetch it out of band or raise SERVICENOW_MAX_DOWNLOAD_BYTES.`,
			);
		}

		// Download the file content
		const fileBuffer = await client.downloadFile(attachmentSysId);

		// Encode to base64
		const fileContent = fileBuffer.toString('base64');

		logger.info(`Downloaded attachment ${attachmentSysId}: ${metadata.file_name}`, {
			instance: instance || 'default',
		});

		return {
			fileName: metadata.file_name,
			fileContent,
			contentType: metadata.content_type,
			// Prefer the actual buffer length; fall back to the metadata value.
			size: Number.isFinite(size) ? size : fileBuffer.length,
		};
	}

	/**
	 * Get attachment metadata without downloading the file
	 * @param attachmentSysId System ID of the attachment
	 * @param instance Optional instance name (uses default if not specified)
	 */
	async getAttachmentMetadata(
		attachmentSysId: string,
		instance?: string,
	): Promise<AttachmentMetadata> {
		validateSysId(attachmentSysId);

		const client = this.instanceManager.getClient(instance);
		const endpoint = `${API_ENDPOINTS.ATTACHMENT}/${attachmentSysId}`;

		logger.debug(`Getting attachment metadata: ${attachmentSysId}`, {
			instance: instance || 'default',
		});

		const response = await client.get<{ result: AttachmentMetadata }>(endpoint);

		return response.result;
	}

	/**
	 * List all attachments for a specific record
	 * @param tableName Name of the table
	 * @param recordSysId System ID of the record
	 * @param instance Optional instance name (uses default if not specified)
	 */
	async listAttachments(
		tableName: string,
		recordSysId: string,
		instance?: string,
	): Promise<AttachmentMetadata[]> {
		validateTableName(tableName);
		validateSysId(recordSysId);

		const client = this.instanceManager.getClient(instance);
		const endpoint = API_ENDPOINTS.ATTACHMENT;

		const params = {
			sysparm_query: `table_name=${tableName}^table_sys_id=${recordSysId}`,
		};

		logger.debug(`Listing attachments for ${tableName}/${recordSysId}`, {
			instance: instance || 'default',
		});

		const response = await client.get<AttachmentListResponse>(endpoint, params);

		logger.info(`Found ${response.result.length} attachments for ${tableName}/${recordSysId}`, {
			instance: instance || 'default',
		});

		return response.result;
	}

	/**
	 * Delete an attachment
	 * @param attachmentSysId System ID of the attachment to delete
	 * @param instance Optional instance name (uses default if not specified)
	 */
	async deleteAttachment(attachmentSysId: string, instance?: string): Promise<void> {
		validateSysId(attachmentSysId);

		const client = this.instanceManager.getClient(instance);
		const endpoint = `${API_ENDPOINTS.ATTACHMENT}/${attachmentSysId}`;

		logger.debug(`Deleting attachment ${attachmentSysId}`, {
			instance: instance || 'default',
		});

		await client.delete(endpoint);

		logger.info(`Deleted attachment ${attachmentSysId}`, {
			instance: instance || 'default',
		});
	}
}
