/**
 * Best-effort static analysis of a server-side script to extract the
 * ServiceNow table + field names it references, so they can be validated
 * against the live schema BEFORE the script runs (catching typo'd field names
 * the way the create/update tools do).
 *
 * Also provides write-operation detection used to gate execution: scripts that
 * call insert/update/delete require explicit allowWrites: true.
 *
 * Both analyses are heuristic — JS is dynamic, so only HIGH-CONFIDENCE literal
 * references are caught. Dynamic table names (variables) are silently missed.
 */

export interface TableFieldRefs {
	table: string;
	fields: string[];
}

// `var = new GlideRecord('table')` / GlideRecordSecure / GlideAggregate — literal table name.
const GR_DECL =
	/\b(\w+)\s*=\s*new\s+(?:GlideRecord|GlideRecordSecure|GlideAggregate)\s*\(\s*['"]([a-z0-9_]+)['"]\s*\)/g;

// `var = new GlideRecord(varName)` — variable table name; resolved via constant map.
const GR_DECL_VAR =
	/\b(\w+)\s*=\s*new\s+(?:GlideRecord|GlideRecordSecure|GlideAggregate)\s*\(\s*([A-Za-z_]\w*)\s*\)/g;

// String literal assignments: `var/let/const name = 'value'` (declaration) or
// `name = 'value'` (reassignment, negative lookbehind prevents matching `obj.prop = 'v'`).
// Trailing `(?!\s*\+)` excludes concatenated strings like `'sys_' + 'br'` — only
// a standalone literal is a safe constant to propagate.
// Used for constant propagation when resolving GlideRecord(varName).
const STRING_ASSIGN_RE =
	/(?:(?:var|let|const)\s+(\w+)|(?<![.\w])(\w+))\s*=\s*['"]([a-z0-9_]+)['"](?!\s*\+)/g;

// Methods whose FIRST string argument is a field name.
const FIELD_FIRST_ARG = [
	'getValue',
	'setValue',
	'getElement',
	'getDisplayValue',
	'orderBy',
	'orderByDesc',
	'addNotNullQuery',
	'addNullQuery',
	'groupBy',
];

// `var.method('arg'...)` — captures the variable, method, and first string arg.
const CALL_RE = new RegExp(
	`\\b(\\w+)\\.(addEncodedQuery|addQuery|${FIELD_FIRST_ARG.join('|')})\\s*\\(\\s*(['"])([\\s\\S]*?)\\3`,
	'g',
);

// GlideRecord/GlideAggregate API members that are NOT fields. Method *calls* are
// already excluded by the paren check in PROP_RE; this denylist is extra safety
// for the rare case where an API member is referenced without parentheses.
const GR_METHODS = new Set([
	'query',
	'next',
	'_next',
	'hasNext',
	'insert',
	'update',
	'deleteRecord',
	'deleteMultiple',
	'get',
	'getValue',
	'setValue',
	'getElement',
	'getDisplayValue',
	'addQuery',
	'addEncodedQuery',
	'addOrCondition',
	'addNotNullQuery',
	'addNullQuery',
	'orderBy',
	'orderByDesc',
	'groupBy',
	'addAggregate',
	'getAggregate',
	'setLimit',
	'getRowCount',
	'initialize',
	'isValid',
	'isValidRecord',
	'isValidField',
	'canRead',
	'canWrite',
	'canCreate',
	'canDelete',
	'getTableName',
	'getUniqueValue',
	'getEncodedQuery',
	// Introspection members. These appear overwhelmingly in feature-detection
	// guards — `gr.getFields ? gr.getFields() : null` — where the member is read
	// WITHOUT parentheses precisely to test for its existence. PROP_RE's paren
	// check can't help there, so without these entries a defensive script gets
	// `getFields`/`getElements` reported as unknown columns on a real table.
	'getFields',
	'getElements',
	'getRecordClassName',
	'getLabel',
	'getED',
	'getAttribute',
	'getClassDisplayValue',
	'getLink',
	'getPlural',
	'setWorkflow',
	'autoSysFields',
	'setAbortAction',
	'applyEncodedQuery',
	'newRecord',
	'chooseWindow',
	'setValue',
]);

// Direct property access on a tracked var — `gr.short_description = x` (assignment)
// or `gr.number` (read). The optional trailing `(` distinguishes a method CALL
// (excluded) from a field property (kept). This is the idiomatic GlideRecord
// field form that the method-arg patterns above don't see.
const PROP_RE = /\b(\w+)\.([A-Za-z_]\w*)\s*(\()?/g;

// ── Shared: var→table resolution with constant propagation ───────────────────

/**
 * Collect all `var/let/const name = 'literal'` and `name = 'literal'`
 * assignments in a script. Used to resolve variable names in GlideRecord
 * constructors one level deep (constant propagation).
 * Property assignments (`obj.prop = 'v'`) are excluded via negative lookbehind.
 */
function buildConstantMap(script: string): Map<string, string> {
	const map = new Map<string, string>();
	STRING_ASSIGN_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = STRING_ASSIGN_RE.exec(script)) !== null) {
		const name = m[1] ?? m[2]; // group 1 = declaration, group 2 = bare assignment
		const value = m[3];
		if (name) map.set(name, value);
	}
	return map;
}

/**
 * Build a var→table map for all GlideRecord/GlideRecordSecure/GlideAggregate
 * variables in the script. Two passes:
 *   1. Literal: `var gr = new GlideRecord('incident')`
 *   2. Variable: `var t = 'incident'; var gr = new GlideRecord(t)`
 *      — resolved via constant propagation (one level only).
 */
function buildVarTable(script: string): Map<string, string> {
	const constMap = buildConstantMap(script);
	const varTable = new Map<string, string>();
	let m: RegExpExecArray | null;

	GR_DECL.lastIndex = 0;
	while ((m = GR_DECL.exec(script)) !== null) {
		varTable.set(m[1], m[2]);
	}

	GR_DECL_VAR.lastIndex = 0;
	while ((m = GR_DECL_VAR.exec(script)) !== null) {
		const [, grVar, tableVar] = m;
		if (varTable.has(grVar)) continue; // already resolved via literal — literal wins
		const resolved = constMap.get(tableVar);
		if (resolved) varTable.set(grVar, resolved);
	}

	return varTable;
}

// ── Write-operation detection ────────────────────────────────────────────────

// ServiceNow metadata/config tables. A write to any of these bypasses Fluent
// source control and is flagged separately from plain data writes.
const METADATA_TABLES = new Set([
	'sys_business_rule',
	'sys_script_include',
	'sys_ui_action',
	'sys_ui_policy',
	'sys_ui_script',
	'sys_update_xml',
	'sys_update_set',
	'sys_db_object',
	'sys_dictionary',
	'sys_security_acl',
	'sys_app',
	'sys_scope',
	'sys_hub_flow',
	'sys_flow',
	'sys_flow_context',
	'sys_processor',
	'sys_ws_definition',
	'sys_rest_message',
	'sys_rest_message_fn',
	'sys_web_service',
	'sys_script',
	'sys_scheduled_script_execution',
	'sys_trigger',
	'sys_auth_profile',
	'sys_properties',
]);

// GlideRecord write methods — any call to these mutates the instance.
const WRITE_METHOD_RE = /\b(\w+)\.(insert|update|updateMultiple|deleteRecord|deleteMultiple)\s*\(/g;

export interface WriteDetection {
	hasWrites: boolean;
	writeCalls: Array<{ method: string; table?: string }>;
	/** Tables that are known ServiceNow metadata/config tables. */
	metadataTables: string[];
	/**
	 * True when at least one detected write is on a GlideRecord whose table name
	 * could NOT be resolved to a literal (dynamic name, string concatenation,
	 * function return, or property read). In that case the metadata-table
	 * classification is incomplete — a write to a metadata/config table may have
	 * gone unflagged — so callers should treat the result with extra suspicion.
	 */
	lowConfidence: boolean;
	/** How many detected writes have an unresolved table (the low-confidence set). */
	unresolvedWrites: number;
}

/**
 * Detect GlideRecord write operations in a script. Catches literal table names
 * and one level of constant propagation (`var t = 'table'; new GlideRecord(t)`).
 * Concatenation, function returns, and property reads are still missed.
 * Callers should treat this as a BEST-EFFORT gate, not a complete sandbox.
 *
 * When a write is detected but its table can't be resolved, `lowConfidence` is
 * set so the caller can surface that the metadata classification is incomplete
 * rather than silently reporting a clean-looking result.
 */
export function detectWriteOperations(script: string): WriteDetection {
	const varTable = buildVarTable(script);
	const writeCalls: Array<{ method: string; table?: string }> = [];
	const metadataFound = new Set<string>();
	let unresolvedWrites = 0;
	let m: RegExpExecArray | null;

	WRITE_METHOD_RE.lastIndex = 0;
	while ((m = WRITE_METHOD_RE.exec(script)) !== null) {
		const [, varName, method] = m;
		const table = varTable.get(varName);
		writeCalls.push({ method: `${method}()`, table });
		if (table && METADATA_TABLES.has(table)) {
			metadataFound.add(table);
		} else if (!table) {
			unresolvedWrites += 1;
		}
	}

	return {
		hasWrites: writeCalls.length > 0,
		writeCalls,
		metadataTables: [...metadataFound],
		lowConfidence: unresolvedWrites > 0,
		unresolvedWrites,
	};
}

// ── Field extraction ─────────────────────────────────────────────────────────

/** Does an addQuery first-arg look like an encoded query rather than a field? */
function looksEncoded(arg: string): boolean {
	return (
		/[\^=<>!]/.test(arg) ||
		/\b(LIKE|STARTSWITH|ENDSWITH|IN|ISEMPTY|ISNOTEMPTY|BETWEEN|ON)\b/i.test(arg)
	);
}

/**
 * Pull field names out of an encoded query string
 * (e.g. "active=true^priority<=2^ORDERBYDESCsys_created_on" -> active, priority, sys_created_on).
 */
export function parseEncodedQueryFields(encoded: string): string[] {
	const fields: string[] = [];
	for (let clause of encoded.split('^')) {
		clause = clause.trim();
		if (!clause) continue;
		// Order matters: strip the uppercase sort/logical prefixes before matching
		// the (lowercase) field token. Case-sensitive so a field like `order` or
		// `nq_count` isn't mangled — ServiceNow's prefixes are always uppercase.
		clause = clause.replace(/^ORDERBYDESC/, '').replace(/^ORDERBY/, ''); // sort
		clause = clause.replace(/^(?:OR|NQ)/, ''); // logical
		const m = clause.match(/^([a-z][a-z0-9_.]*)/); // leading field token (lowercase)
		if (m) fields.push(m[1]);
	}
	return fields;
}

// `someVar.member(` — a member INVOKED on a tracked GlideRecord variable.
const METHOD_CALL_RE = /\b(\w+)\.([A-Za-z_]\w*)\s*\(/g;

/**
 * Member names the script invokes with parentheses on a tracked GlideRecord
 * variable.
 *
 * Used to reclassify a bare `gr.member` read as a method probe rather than a
 * column. Scoped to tracked variables so an unrelated `obj.foo()` elsewhere in
 * the script can't suppress a genuine `gr.foo` field reference.
 */
function collectCalledMembers(script: string, varTable: Map<string, string>): Set<string> {
	const called = new Set<string>();
	METHOD_CALL_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = METHOD_CALL_RE.exec(script)) !== null) {
		const [, varName, member] = m;
		if (varTable.has(varName)) called.add(member);
	}
	return called;
}

/**
 * Every table the script opens a GlideRecord/GlideAggregate on, whether or not
 * it also names a column.
 *
 * Distinct from extractTableFieldRefs, which drops a table that contributed no
 * fields — correct for a FIELD check, wrong for a VISIBILITY check. The script
 * at the centre of the silent-zero incident was `gr.query(); gr.getRowCount()`:
 * it references no column at all, so a field-keyed extractor reports nothing
 * and the very read that needed the warning would go unwarned.
 */
export function extractReferencedTables(script: string): string[] {
	return [...new Set(buildVarTable(script).values())];
}

/**
 * Extract high-confidence {table, fields[]} references from a script.
 * Fields are only associated with a table when the GlideRecord variable was
 * declared with a literal table name; references on untracked variables are
 * skipped (we can't know their table).
 */
export function extractTableFieldRefs(script: string): TableFieldRefs[] {
	const varTable = buildVarTable(script);
	let m: RegExpExecArray | null;
	if (varTable.size === 0) return [];

	const byTable = new Map<string, Set<string>>();
	const add = (table: string, field: string) => {
		if (!field) return;
		if (!byTable.has(table)) byTable.set(table, new Set());
		byTable.get(table)?.add(field);
	};

	CALL_RE.lastIndex = 0;
	while ((m = CALL_RE.exec(script)) !== null) {
		const [, varName, method, , arg] = m;
		const table = varTable.get(varName);
		if (!table) continue; // unknown variable -> can't attribute to a table

		if (method === 'addEncodedQuery' || (method === 'addQuery' && looksEncoded(arg))) {
			for (const f of parseEncodedQueryFields(arg)) add(table, f);
		} else {
			// addQuery('field', value) or a FIELD_FIRST_ARG method
			add(table, arg);
		}
	}

	// Names this script itself calls as methods on a tracked variable. A
	// feature-detection guard reads the member bare to test for it and then calls
	// it — `gr.getFields ? gr.getFields() : []` — so the bare read is a method
	// probe, not a column. The denylist can only cover members we thought to
	// enumerate; this catches the rest, including instance-specific and custom
	// script-include methods, from the script's own evidence.
	const calledAsMethod = collectCalledMembers(script, varTable);

	// Direct property access: `gr.field = x` and `gr.field` reads (the most common
	// GlideRecord field form). Skip method calls (trailing `(`) and known API members.
	PROP_RE.lastIndex = 0;
	while ((m = PROP_RE.exec(script)) !== null) {
		const [, varName, prop, paren] = m;
		if (paren) continue; // method call, not a field
		if (GR_METHODS.has(prop)) continue; // API member referenced without ()
		if (calledAsMethod.has(prop)) continue; // called with () elsewhere -> a method probe
		const table = varTable.get(varName);
		if (!table) continue; // untracked variable
		add(table, prop);
	}

	return [...byTable.entries()].map(([table, fields]) => ({ table, fields: [...fields] }));
}
