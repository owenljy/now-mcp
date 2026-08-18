/**
 * Eval fixtures (WS-B §4.3).
 *
 * - TASKS: the curated natural-language ask → expected tool + key params set.
 * - BEFORE_DESCRIPTIONS: the verbose, pre-cleanup descriptions of the three
 *   eval-target tools, frozen here so the before/after delta is reproducible in
 *   a single `node --test` run. The AFTER descriptions are read live from the
 *   built tool modules by the test, so the harness can't drift from shipped code.
 */

/** Tables/fields the param extractor is allowed to recognise. */
export const KNOWN_TABLES = [
  'incident', 'sys_user', 'change_request', 'problem', 'task', 'cmdb_ci',
  'ais_ingest_embedding_stats',
];
export const KNOWN_FIELDS = ['priority', 'state', 'type', 'category', 'urgency', 'impact'];

/**
 * Curated task set. Each maps an ask to the tool an agent should pick and the
 * key params it should lift from the ask. Covers query_records,
 * aggregate_records and get_table_schema (the §4.3 targets), with a few
 * neighbours so the router has realistic competition.
 */
export const TASKS = [
  // --- query_records: retrieve rows ---
  {
    ask: 'Show me the open incidents assigned to the network team',
    expectedTool: 'sn_query_records',
    expectedParams: { tableName: 'incident' },
    hints: { knownTables: KNOWN_TABLES },
  },
  {
    ask: 'Fetch the most recent change_request rows so I can read their descriptions',
    expectedTool: 'sn_query_records',
    expectedParams: { tableName: 'change_request' },
    hints: { knownTables: KNOWN_TABLES },
  },
  {
    ask: 'Retrieve the active sys_user rows with their email addresses',
    expectedTool: 'sn_query_records',
    expectedParams: { tableName: 'sys_user' },
    hints: { knownTables: KNOWN_TABLES },
  },
  {
    ask: 'Pull the unassigned critical incident rows, paginated 50 at a time',
    expectedTool: 'sn_query_records',
    expectedParams: { tableName: 'incident' },
    hints: { knownTables: KNOWN_TABLES },
  },

  // --- aggregate_records: counts / group-by / rollups ---
  {
    ask: 'How many open incidents are there per assignment group?',
    expectedTool: 'sn_aggregate_records',
    expectedParams: { tableName: 'incident' },
    hints: { knownTables: KNOWN_TABLES },
  },
  {
    ask: 'What is the average reassignment count across active incidents?',
    expectedTool: 'sn_aggregate_records',
    expectedParams: { tableName: 'incident' },
    hints: { knownTables: KNOWN_TABLES },
  },
  {
    ask: 'Give me the total count of change_request grouped by type',
    expectedTool: 'sn_aggregate_records',
    expectedParams: { tableName: 'change_request' },
    hints: { knownTables: KNOWN_TABLES },
  },

  // --- get_table_schema: field definitions for one table ---
  {
    ask: 'What fields and data types does the incident table define?',
    expectedTool: 'sn_get_table_schema',
    expectedParams: { tableName: 'incident' },
    hints: { knownTables: KNOWN_TABLES },
  },
  {
    ask: 'Describe the column definitions and constraints of change_request',
    expectedTool: 'sn_get_table_schema',
    expectedParams: { tableName: 'change_request' },
    hints: { knownTables: KNOWN_TABLES },
  },
  {
    ask: 'Which mandatory and readonly fields exist on the sys_user table?',
    expectedTool: 'sn_get_table_schema',
    expectedParams: { tableName: 'sys_user' },
    hints: { knownTables: KNOWN_TABLES },
  },

  // --- aggregate_records: the PR4 steering targets (distribution/count/breakdown/having) ---
  {
    ask: 'What is the total count of incidents grouped by state?',
    expectedTool: 'sn_aggregate_records',
    expectedParams: { tableName: 'incident' },
    hints: { knownTables: KNOWN_TABLES },
  },
  {
    ask: 'How many rows total does ais_ingest_embedding_stats have?',
    expectedTool: 'sn_aggregate_records',
    expectedParams: { tableName: 'ais_ingest_embedding_stats' },
    hints: { knownTables: KNOWN_TABLES },
  },
  {
    ask: 'Give me a breakdown of incidents by category',
    expectedTool: 'sn_aggregate_records',
    expectedParams: { tableName: 'incident' },
    hints: { knownTables: KNOWN_TABLES },
  },
  {
    ask: 'Which assignment groups have more than 5 open incidents?',
    expectedTool: 'sn_aggregate_records',
    expectedParams: { tableName: 'incident' },
    hints: { knownTables: KNOWN_TABLES },
  },

  // --- negative controls: must stay on sn_query_records despite the new
  // aggregate vocabulary — these need the actual row data, not numbers.
  {
    ask: 'Fetch the most recent incident rows so I can read their short descriptions',
    expectedTool: 'sn_query_records',
    expectedParams: { tableName: 'incident' },
    hints: { knownTables: KNOWN_TABLES },
  },
  {
    ask: 'Retrieve the sys_user rows where the email field is empty',
    expectedTool: 'sn_query_records',
    expectedParams: { tableName: 'sys_user' },
    hints: { knownTables: KNOWN_TABLES },
  },
  {
    ask: 'Pull the failed change_request rows and show me their error messages',
    expectedTool: 'sn_query_records',
    expectedParams: { tableName: 'change_request' },
    hints: { knownTables: KNOWN_TABLES },
  },
];

/** Frozen pre-cleanup descriptions of the three eval-target tools. */
export const BEFORE_DESCRIPTIONS = {
  sn_query_records: `What: Read records from any ServiceNow table with filters, field selection, dot-walking, and pagination.
When to use: To retrieve rows of data. For counts/group-by/avg/sum use sn_aggregate_records instead.
Preconditions: Table must exist; the account needs read access to it.
Produces: An array of records (plus pagination metadata, and recovery hints when empty).

Query records from any ServiceNow table with optional filters and pagination.

Encoded Query Examples:
- Query all priority 1 incidents: tableName="incident", query="priority=1"
- Get open incidents for a user: tableName="incident", query="assigned_to=USER_SYS_ID^state=2"
- List all active users: tableName="sys_user", query="active=true"
- Query with pagination: tableName="incident", limit=50, offset=100
- Get specific fields only: tableName="incident", fields=["number", "short_description", "priority"]

Encoded query operators:
- = (equals), != (not equals)
- ^ (AND), ^OR (OR)
- >, <, >=, <= (comparisons)
- LIKE, STARTSWITH, ENDSWITH (string matching)
- IN (list matching)

Dot-walking: traverse reference fields with dots in both queries and fields,
e.g. query="caller_id.department.name=Network", fields=["number","caller_id.name","caller_id.department.manager.email"].

Display values: set displayValue=true for human-readable labels of
reference/choice fields (group name instead of sys_id), or "all" for both.

For counts, group-by, and avg/sum/min/max use sn_aggregate_records
instead — it computes the numbers server-side rather than returning rows.`,

  sn_aggregate_records: `What: Compute counts and avg/sum/min/max over a table via the Stats API, optionally grouped (group-by supports dot-walking).
When to use: For "how many", "per group", or numeric rollups — not when you need the actual rows (use sn_query_records for those).
Preconditions: Table must exist; the account needs read access.
Produces: Aggregate numbers (a single object, or an array of groups when groupBy is set).

Aggregate records from any ServiceNow table using the Stats API — counts and avg/sum/min/max over fields, optionally grouped. Returns computed numbers, not raw rows, so it is far cheaper than querying records and reducing them client-side.

Examples:
- Count P1 incidents by assignment group:
  tableName="incident", query="priority=1", groupBy=["assignment_group"], count=true
- Average reassignment count of active incidents:
  tableName="incident", query="active=true", avgFields=["reassignment_count"]
- Open incidents per caller department (dot-walked group-by):
  tableName="incident", query="active=true", groupBy=["caller_id.department"], count=true
- Only groups with more than 5 records:
  tableName="incident", groupBy=["assignment_group"], count=true, having="count>5"

Set displayValue=true to get readable labels for group-by reference fields.`,

  sn_get_table_schema: `Get detailed schema information for a ServiceNow table including all field definitions, types, and constraints.

This tool enables dynamic discovery of table structure, making it easy to understand what fields are available and their properties without manual documentation lookup.

Features:
- Complete field metadata (name, label, type, mandatory, readonly)
- Field constraints (max length, reference tables)
- Optional inclusion of inherited fields from parent tables
- Cached for performance (15-minute TTL)

Examples:
- Get incident table schema:
  tableName="incident"

- Get schema with inherited fields:
  tableName="incident"
  includeExtended=true

Returns comprehensive field information including data types, labels, constraints, and reference relationships.`,
};

/**
 * The shipped descriptions immediately BEFORE the PR4 steering rewrite
 * (captured verbatim from git HEAD at the PR3 commit, before this session's
 * description edits) — bound to a regression assert so a future edit is
 * compared against what actually shipped last, not a snapshot two
 * generations old. BEFORE_DESCRIPTIONS above stays as-is; it backs a
 * different, still-valid assertion (the original verbose-vs-cleaned-up
 * delta) and swapping its content out from under that test would make it
 * trivially satisfiable in the other direction.
 */
export const BASELINE_DESCRIPTIONS = {
  sn_query_records: `What: List/fetch/read the actual record rows from a ServiceNow table, with filters, field selection, dot-walking, and pagination.
When to use: To retrieve the rows themselves — show me / fetch / find matching records. For counts, group-by, or avg/sum/min/max use sn_aggregate_records instead.
Preconditions: Table must exist; the account needs read access to it.
Produces: An array of the matching records (plus pagination metadata, and recovery hints when empty).

Encoded query goes in the query param (operators: = != ^ ^OR > < >= <= LIKE STARTSWITH ENDSWITH IN ISEMPTY ISNOTEMPTY; dot-walk reference fields, e.g. caller_id.department.name=Network).

Field names in query/fields are checked against the table schema first, because ServiceNow SILENTLY IGNORES an unknown field in an encoded query — priorityy=1 returns the whole table with HTTP 200 and no error. A typo is reported here instead of quietly widening the result; skipFieldValidation:true runs the query as written.

Journal fields (comments, work_notes) read back EMPTY unless displayValue is set — the entry stream with timestamps and authors only exists in the display value. Use displayValue:"all" to get them.

expand pulls fields from referenced records in one request, e.g. expand={"caller_id":["name","email"]} — one level deep, and requires fields to be listed.

A 403 is auto-diagnosed against the table's web-service access flag, so the returned hint distinguishes "this table blocks all REST access regardless of role" from "your account lacks the required role/ACL" — trust that hint over re-investigating roles manually.

Examples:
- tableName="incident", query="priority=1^state=2", fields=["number","short_description"]
- Pagination: limit=50, offset=100 (response.pagination.hasMore / totalMatching guide the next page)`,

  sn_aggregate_records: `What: Compute a count, or avg/sum/min/max, over a table via the Stats API — optionally grouped by one or more fields (dot-walking supported).
When to use: For "how many", "total count", "per group", "grouped by", or numeric rollups — not when you need the actual rows (use sn_query_records for those).
Preconditions: Table must exist; the account needs read access.
Produces: Aggregate numbers (a single object, or an array of groups when groupBy is set). Far cheaper than querying rows and reducing client-side.

having filters post-aggregation (e.g. "count>5"). When grouping by a reference field (assignment_group, caller_id, …), pass displayValue=true so groups come back as names instead of sys_ids.

Field names in query/groupBy/*Fields are checked against the table schema first: ServiceNow silently ignores an unknown field in an encoded query, which would return the count for the WHOLE table as if it were the filtered count. skipFieldValidation:true aggregates as written.

Examples:
- Count P1s per group (as names): tableName="incident", query="priority=1", groupBy=["assignment_group"], count=true, displayValue=true
- Avg over a field: tableName="incident", query="active=true", avgFields=["reassignment_count"]`,
};
