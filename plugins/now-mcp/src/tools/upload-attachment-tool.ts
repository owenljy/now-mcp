/**
 * MCP tool for uploading attachments to ServiceNow records
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { UploadAttachmentSchema } from '../schemas/attachment-schemas.js';
import { UploadAttachmentOutputSchema } from '../schemas/output-schemas.js';
import type { AttachmentService } from '../services/attachment-service.js';
import type { AttachmentMetadata } from '../types/servicenow.js';
import { toolError } from '../utils/error-handler.js';
import { logger } from '../utils/logger.js';
import { toolResult } from '../utils/tool-response.js';

const MAX_UPLOAD_BYTES = (() => {
	const parsed = Number.parseInt(process.env.SERVICENOW_MAX_UPLOAD_BYTES ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 1024 * 1024;
})();

export const UPLOAD_ATTACHMENT_TOOL = {
	name: 'sn_upload_attachment',
	title: 'Upload attachment',
	description: `What: Attach a file to a ServiceNow record. Provide exactly one of filePath (preferred) or base64 fileContent. Local paths are resolved by the now-mcp server process.
When to use: To add a file to an existing record.
Preconditions: Write-enabled instance (readOnly: false); the target record must exist.
Produces: Attachment metadata (sys_id, size, content type).`,
	inputSchema: UploadAttachmentSchema,
	outputSchema: UploadAttachmentOutputSchema,
};

export function createUploadAttachmentTool(attachmentService: AttachmentService) {
	return {
		...UPLOAD_ATTACHMENT_TOOL,
		handler: async (params: unknown) => {
			let tableName: string | undefined;
			try {
				// Validate input
				const validated = UploadAttachmentSchema.parse(params);
				tableName = validated.tableName;

				let fileName = validated.fileName;
				let bytesRead: number;
				let attachment: AttachmentMetadata;
				if (validated.filePath) {
					const resolvedPath = await realpath(validated.filePath);
					const fileStat = await stat(resolvedPath);
					if (!fileStat.isFile())
						throw new Error('filePath must resolve to a regular file, not a directory.');
					if (fileStat.size > MAX_UPLOAD_BYTES) {
						throw new Error(
							`Local file is ${fileStat.size} bytes, exceeding the ${MAX_UPLOAD_BYTES}-byte upload limit.`,
						);
					}
					fileName ??= basename(resolvedPath);
					const fileBuffer = await readFile(resolvedPath);
					bytesRead = fileBuffer.length;
					attachment = await attachmentService.uploadAttachmentBuffer(
						fileName,
						fileBuffer,
						validated.tableName,
						validated.recordSysId,
						validated.instance,
					);
				} else {
					fileName = validated.fileName as string;
					bytesRead = Buffer.from(validated.fileContent as string, 'base64').length;
					if (bytesRead > MAX_UPLOAD_BYTES) {
						throw new Error(
							`Decoded file is ${bytesRead} bytes, exceeding the ${MAX_UPLOAD_BYTES}-byte upload limit.`,
						);
					}
					attachment = await attachmentService.uploadAttachment(
						fileName,
						validated.fileContent as string,
						validated.tableName,
						validated.recordSysId,
						validated.instance,
					);
				}

				logger.info(`Uploading attachment ${fileName}`, {
					table: validated.tableName,
					record: validated.recordSysId,
					bytesRead,
				});
				const verified = await attachmentService.getAttachmentMetadata(
					attachment.sys_id,
					validated.instance,
				);

				// Format response for LLM
				const response = {
					success: true,
					message:
						'Attachment persisted and metadata verified. Downstream Business Rules, flows, events, and async processing were not verified.',
					bytesRead,
					verification: 'verified',
					attachment: {
						sys_id: verified.sys_id,
						file_name: verified.file_name,
						size_bytes: verified.size_bytes,
						content_type: verified.content_type,
						table_name: verified.table_name,
						table_sys_id: verified.table_sys_id,
						created_on: verified.sys_created_on,
					},
				};

				return toolResult(
					response,
					`attachment persisted and metadata verified: ${verified.file_name} (${verified.size_bytes} bytes); downstream automation not verified`,
					{
						meta: {
							instance: validated.instance || 'default',
							transport: 'attachment_api',
							endpoint: '/api/now/attachment/upload',
							verification: 'verified',
						},
					},
				);
			} catch (error) {
				logger.error('Error uploading attachment', error);
				return toolError(error, { table: tableName, operation: 'upload attachment' });
			}
		},
	};
}
