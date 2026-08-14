/**
 * ServiceNow REST API endpoint patterns and constants
 */

// API Endpoint Patterns
export const API_ENDPOINTS = {
	// Table API
	TABLE: '/api/now/table',
	TABLE_RECORD: (tableName: string) => `/api/now/table/${tableName}`,
	TABLE_RECORD_BY_ID: (tableName: string, sysId: string) => `/api/now/table/${tableName}/${sysId}`,

	// Aggregate API (counts, group-by, avg/sum/min/max)
	STATS: (tableName: string) => `/api/now/stats/${tableName}`,

	// Table Batch API — many Table API calls in one request. Verified present on
	// a Zurich-era instance; callers fall back to looped single calls on 404/405.
	BATCH: '/api/now/v1/batch',

	// GraphQL (GlideRecord namespace) — read channel only. Writes stay on the
	// Table API, which confirms them in its response; a GraphQL mutation can
	// report success with a null result and needs a re-read to verify.
	GRAPHQL: '/api/now/graphql',

	// Attachment API
	ATTACHMENT: '/api/now/attachment',
	ATTACHMENT_FILE: '/api/now/attachment/file',
	ATTACHMENT_UPLOAD: '/api/now/attachment/upload',
	ATTACHMENT_BY_ID: (sysId: string) => `/api/now/attachment/${sysId}`,
	ATTACHMENT_FILE_BY_ID: (sysId: string) => `/api/now/attachment/${sysId}/file`,
} as const;

// Common ServiceNow table names
export const COMMON_TABLES = {
	INCIDENT: 'incident',
	REQUEST: 'sc_request',
	REQUEST_ITEM: 'sc_req_item',
	CHANGE_REQUEST: 'change_request',
	PROBLEM: 'problem',
	USER: 'sys_user',
	USER_GROUP: 'sys_user_group',
	CMDB_CI: 'cmdb_ci',
	CMDB_CI_SERVER: 'cmdb_ci_server',
	KB_KNOWLEDGE: 'kb_knowledge',
	TASK: 'task',
} as const;

// ServiceNow query operators
export const QUERY_OPERATORS = {
	EQUALS: '=',
	NOT_EQUALS: '!=',
	AND: '^',
	OR: '^OR',
	NEW_QUERY: '^NQ',
	LIKE: 'LIKE',
	NOT_LIKE: 'NOTLIKE',
	IN: 'IN',
	NOT_IN: 'NOT IN',
	STARTS_WITH: 'STARTSWITH',
	ENDS_WITH: 'ENDSWITH',
	CONTAINS: 'LIKE',
	GREATER_THAN: '>',
	LESS_THAN: '<',
	GREATER_THAN_OR_EQUAL: '>=',
	LESS_THAN_OR_EQUAL: '<=',
} as const;

// HTTP request configuration
export const HTTP_CONFIG = {
	TIMEOUT: 30000, // 30 seconds for regular requests
	ATTACHMENT_TIMEOUT: 60000, // 60 seconds for file operations
	MAX_RETRIES: 3,
	RETRY_DELAY: 1000, // Base delay in ms for exponential backoff
	RATE_LIMIT_DELAY: 2000, // Delay when rate limited
} as const;

// ServiceNow field names
export const SYSTEM_FIELDS = {
	SYS_ID: 'sys_id',
	SYS_CREATED_ON: 'sys_created_on',
	SYS_CREATED_BY: 'sys_created_by',
	SYS_UPDATED_ON: 'sys_updated_on',
	SYS_UPDATED_BY: 'sys_updated_by',
	SYS_MOD_COUNT: 'sys_mod_count',
} as const;

// Default query parameters
export const DEFAULT_QUERY_PARAMS = {
	LIMIT: 100,
	MAX_LIMIT: 10000,
	OFFSET: 0,
} as const;
