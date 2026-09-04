import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTableFieldRefs, extractReferencedReadTables, extractReferencedTables, parseEncodedQueryFields, detectWriteOperations } from '../build/utils/script-analysis.js';

function refsFor(script, table) {
  const r = extractTableFieldRefs(script).find((x) => x.table === table);
  return r ? r.fields.sort() : [];
}

test('extracts table + fields from a GlideRecord with addQuery/setValue', () => {
  const script = `
    var gr = new GlideRecord('incident');
    gr.addQuery('priority', 1);
    gr.addQuery('assigned_to', gs.getUserID());
    gr.query();
    while (gr.next()) { gr.setValue('state', 6); gr.update(); }
  `;
  const tables = extractTableFieldRefs(script).map((r) => r.table);
  assert.deepEqual(tables, ['incident']);
  assert.deepEqual(refsFor(script, 'incident'), ['assigned_to', 'priority', 'state']);
});

test('parses fields out of an encoded query (addEncodedQuery + addQuery single-arg)', () => {
  const script = `
    var gr = new GlideRecord('incident');
    gr.addEncodedQuery('active=true^priority<=2^ORDERBYDESCsys_created_on');
    gr.addQuery('caller_id=javascript:gs.getUserID()');
  `;
  assert.deepEqual(refsFor(script, 'incident'), ['active', 'caller_id', 'priority', 'sys_created_on']);
});

test('attributes fields to the correct table across multiple GlideRecords', () => {
  const script = `
    var inc = new GlideRecord('incident');
    inc.addQuery('priority', 1);
    var usr = new GlideRecord('sys_user');
    usr.getValue('email');
  `;
  assert.deepEqual(refsFor(script, 'incident'), ['priority']);
  assert.deepEqual(refsFor(script, 'sys_user'), ['email']);
});

test('handles GlideAggregate groupBy and ignores untracked variables', () => {
  const script = `
    var ga = new GlideAggregate('incident');
    ga.groupBy('assignment_group');
    ga.addAggregate('COUNT');
    somethingElse.addQuery('not_a_tracked_var');
  `;
  // groupBy field captured; addAggregate('COUNT') NOT treated as a field;
  // untracked variable refs skipped.
  assert.deepEqual(refsFor(script, 'incident'), ['assignment_group']);
});

test('dot-walked field is kept as-is (validation checks the first segment)', () => {
  const script = `
    var gr = new GlideRecord('incident');
    gr.addQuery('caller_id.department.name', 'Network');
  `;
  assert.deepEqual(refsFor(script, 'incident'), ['caller_id.department.name']);
});

test('extracts fields from direct property ASSIGNMENT (the create-record form)', () => {
  // The canonical "create a record" script — none of these use string-arg methods.
  const script = `
    var gr = new GlideRecord('incident');
    gr.initialize();
    gr.short_description = 'Test from MCP';
    gr.urgency = 3;
    gr.impact = 3;
    var sysId = gr.insert();
  `;
  assert.deepEqual(refsFor(script, 'incident'), ['impact', 'short_description', 'urgency']);
});

test('extracts fields from direct property READS, ignores method calls', () => {
  const script = `
    var gr = new GlideRecord('incident');
    gr.addQuery('active', true);
    gr.setLimit(5);
    gr.query();
    while (gr.next()) {
      gs.log('INC: ' + gr.number + ' - ' + gr.short_description);
    }
    var n = gr.getRowCount();
  `;
  // active (addQuery) + number + short_description (reads); query/next/setLimit/
  // getRowCount/insert are method calls and must NOT be treated as fields.
  assert.deepEqual(refsFor(script, 'incident'), ['active', 'number', 'short_description']);
});

test('property access on an untracked variable is ignored', () => {
  const script = `
    var gr = new GlideRecord('incident');
    gr.priority = 1;
    other.some_field = 2;     // 'other' is not a tracked GlideRecord
    gs.log(payload.title);    // neither is 'payload'
  `;
  assert.deepEqual(refsFor(script, 'incident'), ['priority']);
});

test('returns nothing when there is no GlideRecord declaration', () => {
  assert.deepEqual(extractTableFieldRefs('gs.info("hello"); var x = 1 + 2;'), []);
});

// ── constant propagation in extractTableFieldRefs ────────────────────────────

test('constant propagation: resolves GlideRecord(varName) via var declaration', () => {
  const script = `
    var tableName = 'incident';
    var gr = new GlideRecord(tableName);
    gr.addQuery('priority', 1);
    gr.query();
  `;
  assert.deepEqual(refsFor(script, 'incident'), ['priority']);
});

test('constant propagation: bare reassignment (no var/let/const)', () => {
  const script = `
    var t;
    t = 'sys_user';
    var gr = new GlideRecord(t);
    gr.getValue('email');
    gr.query();
  `;
  assert.deepEqual(refsFor(script, 'sys_user'), ['email']);
});

test('constant propagation: literal wins over variable when both resolve the same gr var', () => {
  // If somehow a var is declared with literal AND variable form, literal takes priority.
  const script = `
    var table = 'sys_user';
    var gr = new GlideRecord('incident');
    gr.addQuery('active', true);
  `;
  assert.deepEqual(refsFor(script, 'incident'), ['active']);
  assert.deepEqual(refsFor(script, 'sys_user'), []);
});

test('constant propagation: does not resolve property access (obj.prop = "table")', () => {
  // obj.prop = 'table' must NOT be treated as a constant for the variable `prop`.
  const script = `
    config.table = 'incident';
    var gr = new GlideRecord(table);
    gr.addQuery('active', true);
  `;
  // `table` variable is not set to 'incident' — property assignment must be ignored.
  assert.deepEqual(extractTableFieldRefs(script), []);
});

// ── detectWriteOperations ────────────────────────────────────────────────────

test('detectWriteOperations: no writes returns hasWrites=false', () => {
  const script = `
    var gr = new GlideRecord('incident');
    gr.addQuery('active', true);
    gr.query();
    while (gr.next()) { log(gr.number); }
  `;
  const r = detectWriteOperations(script);
  assert.equal(r.hasWrites, false);
  assert.deepEqual(r.writeCalls, []);
  assert.deepEqual(r.metadataTables, []);
});

test('detectWriteOperations: detects insert on a data table', () => {
  const script = `
    var gr = new GlideRecord('incident');
    gr.short_description = 'test';
    gr.insert();
  `;
  const r = detectWriteOperations(script);
  assert.equal(r.hasWrites, true);
  assert.equal(r.writeCalls.length, 1);
  assert.equal(r.writeCalls[0].method, 'insert()');
  assert.equal(r.writeCalls[0].table, 'incident');
  assert.deepEqual(r.metadataTables, []);
  // Resolved literal table => high confidence.
  assert.equal(r.lowConfidence, false);
  assert.equal(r.unresolvedWrites, 0);
});

test('detectWriteOperations: flags metadata table write separately', () => {
  const script = `
    var gr = new GlideRecord('sys_business_rule');
    gr.name = 'My Rule';
    gr.insert();
  `;
  const r = detectWriteOperations(script);
  assert.equal(r.hasWrites, true);
  assert.deepEqual(r.metadataTables, ['sys_business_rule']);
});

test('detectWriteOperations: constant propagation catches var t = "metadata"; new GlideRecord(t)', () => {
  const script = `
    var tableName = 'sys_script_include';
    var gr = new GlideRecord(tableName);
    gr.name = 'MyHelper';
    gr.insert();
  `;
  const r = detectWriteOperations(script);
  assert.equal(r.hasWrites, true);
  assert.deepEqual(r.metadataTables, ['sys_script_include']);
});

test('detectWriteOperations: write detected but table unknown for truly dynamic reference', () => {
  // Concatenation — cannot be resolved statically.
  const script = `
    var t = 'sys_' + 'business_rule';
    var gr = new GlideRecord(t);
    gr.insert();
  `;
  const r = detectWriteOperations(script);
  assert.equal(r.hasWrites, true);
  // Table is unknown (undefined) — we know a write happened but not which table.
  assert.equal(r.writeCalls[0].table, undefined);
  assert.deepEqual(r.metadataTables, []);
  // Unresolved table => low confidence, so callers can warn instead of
  // silently reporting a clean (empty metadataTables) result.
  assert.equal(r.lowConfidence, true);
  assert.equal(r.unresolvedWrites, 1);
});

test('detectWriteOperations: mixed resolved + unresolved writes are counted correctly', () => {
  const script = `
    var known = new GlideRecord('incident');
    known.insert();
    var dyn = new GlideRecord(computeTable());
    dyn.update();
    dyn.deleteRecord();
  `;
  const r = detectWriteOperations(script);
  assert.equal(r.hasWrites, true);
  assert.equal(r.writeCalls.length, 3);
  assert.equal(r.lowConfidence, true);
  // The two writes on the function-returned table are unresolved; the insert is not.
  assert.equal(r.unresolvedWrites, 2);
});

test('detectWriteOperations: all-literal writes stay high confidence', () => {
  const script = `
    var a = new GlideRecord('incident');
    a.insert();
    var b = new GlideRecord('problem');
    b.update();
  `;
  const r = detectWriteOperations(script);
  assert.equal(r.lowConfidence, false);
  assert.equal(r.unresolvedWrites, 0);
});

test('parseEncodedQueryFields strips operators, sort, and logical prefixes', () => {
  assert.deepEqual(
    parseEncodedQueryFields('active=true^ORpriority=1^NQstate!=6^ORDERBYnumber'),
    ['active', 'priority', 'state', 'number']
  );
});

// ── introspection members are not columns ────────────────────────────────────

test('feature-detection guards on getFields/getElements are not reported as fields', () => {
  // `gr.getFields ? ... : ...` reads the member WITHOUT parens precisely to test
  // for its existence, so PROP_RE's paren check cannot exclude it. These are API
  // members, and reporting them as unknown columns on a real table sends the
  // reader chasing a schema problem that does not exist.
  const script = `
    var gr = new GlideRecord('incident');
    gr.query();
    while (gr.next()) {
      var fields = gr.getFields ? gr.getFields() : null;
      var els = gr.getElements ? gr.getElements() : null;
      gs.info(gr.number);
    }
  `;
  assert.deepEqual(refsFor(script, 'incident'), ['number']);
});

test('a bare member that this script calls elsewhere is treated as a method, not a column', () => {
  // The denylist can only cover members we enumerated. A script that calls
  // gr.someCustomProbe() and also tests for it bare is giving us the evidence
  // directly — use it rather than guessing the member is a column.
  const script = `
    var gr = new GlideRecord('incident');
    if (gr.someCustomProbe) { gr.someCustomProbe(); }
    gr.short_description = 'x';
  `;
  assert.deepEqual(refsFor(script, 'incident'), ['short_description']);
});

test('a genuinely unknown column is still reported (the check must not over-suppress)', () => {
  // The suppression above must not swallow real typos: model_categories is never
  // called as a method, so it stays a field reference for the schema check.
  const script = `
    var gr = new GlideRecord('incident');
    gr.addQuery('model_categories', 'x');
    var f = gr.getFields ? gr.getFields() : null;
  `;
  assert.deepEqual(refsFor(script, 'incident'), ['model_categories']);
});

test('a method call on an UNTRACKED variable does not suppress a real field of the same name', () => {
  // collectCalledMembers is scoped to tracked GlideRecord vars so an unrelated
  // helper.state() elsewhere cannot hide gr.state.
  const script = `
    var helper = new SomeHelper();
    helper.state();
    var gr = new GlideRecord('incident');
    gs.info(gr.state);
  `;
  assert.deepEqual(refsFor(script, 'incident'), ['state']);
});

// ── extractReferencedTables ──────────────────────────────────────────────────

test('extractReferencedTables reports a table that names no column', () => {
  // The field-keyed extractor drops this table because the script references no
  // column — but a row-count probe is precisely the read whose zero result gets
  // believed, so a visibility check must still see the table.
  const script = "var gr = new GlideRecord('sn_ai_observe_scoring_provider'); gr.query(); gs.info(gr.getRowCount());";
  assert.deepEqual(extractTableFieldRefs(script), []);
  assert.deepEqual(extractReferencedTables(script), ['sn_ai_observe_scoring_provider']);
});

test('extractReferencedTables de-duplicates and covers GlideAggregate', () => {
  const script = `
    var a = new GlideRecord('incident');
    var b = new GlideRecord('incident');
    var c = new GlideAggregate('sys_user');
  `;
  assert.deepEqual(extractReferencedTables(script).sort(), ['incident', 'sys_user']);
});

test('extractReferencedReadTables excludes write-only records and includes actual reads', () => {
  const script = `
    var created = new GlideRecord('x_acme_widget');
    created.initialize();
    created.setValue('name', 'new');
    created.insert();
    var queried = new GlideRecord('incident');
    queried.addActiveQuery();
    queried.query();
    while (queried.next()) { gs.info(queried.number); }
  `;

  assert.deepEqual(extractReferencedReadTables(script), ['incident']);
});
