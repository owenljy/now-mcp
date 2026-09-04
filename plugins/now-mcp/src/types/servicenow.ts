/**
 * ServiceNow API type definitions
 */

/**
 * Base ServiceNow record interface with common system fields
 */
export interface ServiceNowRecord {
	sys_id: string;
	sys_created_on: string;
	sys_created_by: string;
	sys_updated_on: string;
	sys_updated_by: string;
	sys_mod_count: string;
	[key: string]: unknown; // Allow additional fields based on table
}

/**
 * ServiceNow Table API response for queries (multiple records)
 */
export interface TableAPIResponse<T = ServiceNowRecord> {
	result: T[];
}

/**
 * ServiceNow Table API response for single record operations
 */
export interface SingleRecordResponse<T = ServiceNowRecord> {
	result: T;
}

/**
 * ServiceNow error response structure
 */
export interface ServiceNowErrorResponse {
	error: {
		message: string;
		detail?: string;
	};
	status: string;
}

/**
 * Attachment metadata from ServiceNow
 */
export interface AttachmentMetadata {
	sys_id: string;
	file_name: string;
	size_bytes: string;
	size_compressed: string;
	compressed: string;
	content_type: string;
	table_name: string;
	table_sys_id: string;
	sys_created_on: string;
	sys_created_by: string;
	sys_updated_on: string;
	sys_updated_by: string;
	download_link?: string;
}

/**
 * Attachment upload response
 */
export interface AttachmentUploadResponse {
	result: AttachmentMetadata;
}

/**
 * Attachment list response
 */
export interface AttachmentListResponse {
	result: AttachmentMetadata[];
}

/**
 * Virtual Agent message request
 */
export interface VirtualAgentRequest {
	requestId: string;
	userId?: string;
	message: string;
	sessionId?: string;
	clientSessionId?: string;
	context?: {
		conversationId?: string;
		channel?: string;
		[key: string]: unknown;
	};
}

/**
 * Virtual Agent UI element
 */
export interface VirtualAgentUIElement {
	uiType: string;
	value: string;
	label?: string;
	action?: string;
	[key: string]: unknown;
}

/**
 * Virtual Agent response
 */
export interface VirtualAgentResponse {
	body: {
		result: VirtualAgentUIElement[];
		requestId: string;
		sessionId: string;
		clientSessionId?: string;
		completed?: boolean;
	};
}

/**
 * Query options for Table API
 */
export interface QueryOptions {
	query?: string; // Encoded query
	limit?: number;
	offset?: number;
	fields?: string[]; // Specific fields to retrieve
	displayValue?: boolean | 'all'; // Return display values
	excludeReferenceLink?: boolean;
	/** Explicit independent-identity fallback for a confirmed table-wide REST block. */
	allowNowSdkFallback?: boolean;
}

/**
 * Aggregation options for the Stats API
 */
export interface AggregateOptions {
	query?: string; // Encoded query to filter rows before aggregating
	count?: boolean; // Include a row count
	avgFields?: string[]; // Fields to average
	sumFields?: string[]; // Fields to sum
	minFields?: string[]; // Fields to take the minimum of
	maxFields?: string[]; // Fields to take the maximum of
	groupBy?: string[]; // Fields to group by (supports dot-walking)
	having?: string; // Post-aggregation filter (e.g. "count>5")
	orderBy?: string; // Order groups by an aggregate
	displayValue?: boolean | 'all'; // Return display values for group-by fields
}

/**
 * Record creation/update data
 */
export interface RecordData {
	[fieldName: string]: unknown;
}

/**
 * Update operation type
 */
export type UpdateType = 'partial' | 'full';
