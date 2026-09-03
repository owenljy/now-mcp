import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFailure,
  failureHints,
  zeroResultHints,
  renderHints,
} from '../build/utils/failure-enrichment.js';

test('classifyFailure recognizes the common ServiceNow failure shapes', () => {
  assert.equal(classifyFailure('Request failed with status code 403: Access denied'), '403');
  assert.equal(classifyFailure('404 not found'), '404');
  assert.equal(classifyFailure('401 Unauthorized'), '401');
  assert.equal(classifyFailure('Invalid field name: foo'), 'field_error');
  assert.equal(classifyFailure('something weird happened'), 'unknown');
  // A client-side read-only write block is classified distinctly from a server
  // ACL 403, so it doesn't get a stale YAML-assuming hint tacked on.
  assert.equal(
    classifyFailure("Write operations are not permitted on read-only instance 'prod'."),
    'readonly',
  );
});

test('Table API ACL validation message is classified and recommends mutation diagnostics', () => {
	assert.equal(classifyFailure('ACCESS_DENIED: Failed API level ACL Validation'), '403');
	const hints = failureHints('ACCESS_DENIED: Failed API level ACL Validation', {
		table: 'x_scope_custom',
		operation: 'update',
	});
	assert.match(hints.join('\n'), /sn_diagnose_mutation/);
	assert.match(hints.join('\n'), /secure record access defaults to deny/i);
});

test('403 hints point at ACLs/roles (not read-only, which is a separate class)', () => {
  const hints = failureHints('403 Access denied', { table: 'incident', operation: 'create' });
  const text = hints.join(' ');
  assert.match(text, /ACL/);
  assert.match(text, /incident/);
  // The read-only remediation lives on the write-block message itself, not here.
  assert.doesNotMatch(text, /read-only/i);
});

test('classifyFailure recognizes 403 from the status code even when the message has no keyword', () => {
  // ServiceNow's real error.message for a table-level web-service block is
  // "User Not Authorized" — no "403"/"forbidden"/"access denied" substring.
  // Without the status code this used to classify as 'unknown' and produce no hint.
  assert.equal(classifyFailure('User Not Authorized'), 'unknown');
  assert.equal(classifyFailure('User Not Authorized', 403), '403');
  assert.equal(classifyFailure('some message', 401), '401');
  assert.equal(classifyFailure('some message', 404), '404');
  assert.equal(classifyFailure('some message', 400), '400');
});

test('403 hint via statusCode alone (no keyword in the message) still fires', () => {
  const hints = failureHints('User Not Authorized', {
    table: 'sn_grc_indicator',
    operation: 'query',
    statusCode: 403,
  });
  assert.match(hints.join(' '), /ACL/);
});

test('403 with wsAccess:disabled explains the table-level block, not a role guess', () => {
  const hints = failureHints('User Not Authorized', {
    table: 'sn_grc_indicator',
    operation: 'query',
    statusCode: 403,
    wsAccess: 'disabled',
    // read_access on: a background script CAN see this table, so recommending
    // one is sound here.
    readAccess: 'enabled',
  });
  const text = hints.join(' ');
  assert.match(text, /ws_access/);
  assert.match(text, /web service/i);
  assert.match(text, /sn_execute_background_script/);
  assert.match(text, /now-sdk query/);
  assert.doesNotMatch(text, /likely an acl.*lack the required role/i);
});

test('403 with ws_access AND read_access off warns that a global script returns a false empty', () => {
  // The regression this guards: the old hint recommended a background script on
  // ws_access alone. On a read_access=false table that script returns zero rows
  // and reports success, which was read as "the table is empty" — producing a
  // wrong root cause and a retracted recommendation.
  const hints = failureHints('User Not Authorized', {
    table: 'sn_ai_observe_scoring_provider',
    operation: 'query',
    statusCode: 403,
    wsAccess: 'disabled',
    readAccess: 'disabled',
    owningScope: 'sn_ai_observe',
  });
  const text = hints.join(' ');
  assert.match(text, /read_access/);
  assert.match(text, /ZERO ROWS/i);
  assert.match(text, /owning application scope|sn_ai_observe/i);
  assert.match(text, /not.*conclusive|do NOT treat an empty result/i);
  // It must not present an unqualified background script as the way to read this.
  assert.doesNotMatch(
    text,
    /GlideRecordSecure is not gated by ws_access\) or now-sdk query will return real rows/,
  );
});

test('403 with ws_access off and read_access unknown refuses to nominate a transport', () => {
  const hints = failureHints('User Not Authorized', {
    table: 'x_mystery_table',
    operation: 'query',
    statusCode: 403,
    wsAccess: 'disabled',
    readAccess: 'unknown',
  });
  const text = hints.join(' ');
  assert.match(text, /could not be determined|unknown/i);
  assert.match(text, /zero rows silently/i);
});

test('403 with unknown access metadata says the safe transport cannot be determined', () => {
  const hints = failureHints('User Not Authorized', {
    table: 'x_mystery_table',
    operation: 'query',
    statusCode: 403,
    wsAccess: 'unknown',
    readAccess: 'unknown',
  });
  const text = hints.join(' ');
  assert.match(text, /Likely an ACL/);
  assert.match(text, /could not be read|cannot be determined/i);
});

test('403 with wsAccess:enabled keeps the ACL/role hint and notes ws_access is not the cause', () => {
  const hints = failureHints('403 Access denied', {
    table: 'incident',
    operation: 'query',
    statusCode: 403,
    wsAccess: 'enabled',
  });
  const text = hints.join(' ');
  assert.match(text, /ACL/);
  assert.match(text, /Web-service access.*enabled/i);
});

test('read-only write block gets no extra hint (message is already source-aware)', () => {
  const hints = failureHints(
    "Write operations are not permitted on read-only instance 'prod'. Set ...",
    { table: 'incident', operation: 'create' },
  );
  assert.deepEqual(hints, []);
});

test('field_error hints point at the schema tool', () => {
  const hints = failureHints('Invalid field', { table: 'incident' });
  assert.match(hints.join(' '), /sn_get_table_schema/);
});

test('unknown failures produce no hints', () => {
  assert.deepEqual(failureHints('totally opaque error', {}), []);
});

test('delete failures avoid unsupported UI-only conclusions and recommend diagnostics', () => {
  const hints = failureHints('403 Access denied', {
    table: 'sn_grc_indicator',
    operation: 'delete',
  });
  const text = hints.join(' ');
  assert.match(text, /authenticated API user/i);
  assert.match(text, /sn_diagnose_mutation/);
  assert.match(text, /does not prove.*UI-only/i);
});

test('zeroResultHints suggest broadening with the query echoed', () => {
  const hints = zeroResultHints({ table: 'incident', query: 'priority=1^state=99' });
  assert.match(hints.join(' '), /broaden/i);
  assert.match(hints.join(' '), /priority=1\^state=99/);
});

test('the groupBy suggestion is withheld on a free-text field', () => {
  // The regression this guards: a LIKE on an 8000-char message column used to
  // be answered with groupBy on that column — one group per row, the exact
  // call sn_aggregate_records blocks for sys_id.
  const hints = zeroResultHints({
    table: 'sn_aia_message',
    query: 'user_messageLIKEasset security score',
    fieldMeta: { user_message: { type: 'string', maxLength: 8000 } },
  });
  assert.ok(!hints.join(' ').includes('groupBy'), 'no groupBy suggestion on free text');
  assert.match(hints.join(' '), /broaden/i, 'the generic recovery hint still fires');
});

test('the groupBy suggestion fires on a bounded field', () => {
  const hints = zeroResultHints({
    table: 'incident',
    query: 'category=hardware',
    fieldMeta: { category: { type: 'string', maxLength: 40 } },
  });
  assert.match(hints.join(' '), /groupBy:\["category"\]/);
});

test('the groupBy suggestion skips a free-text clause to reach a groupable one', () => {
  const hints = zeroResultHints({
    table: 'incident',
    query: 'short_descriptionLIKEvpn^priority=1',
    fieldMeta: {
      short_description: { type: 'string', maxLength: 160 },
      priority: { type: 'integer', maxLength: 40 },
    },
  });
  const text = hints.join(' ');
  assert.match(text, /groupBy:\["priority"\]/);
  assert.ok(!text.includes('short_description"]'), 'the prose column is not the one suggested');
});

test('without fieldMeta the groupBy suggestion is withheld, not guessed', () => {
  const hints = zeroResultHints({ table: 'incident', query: 'category=hardware' });
  assert.ok(!hints.join(' ').includes('groupBy'));
});

test('renderHints formats or returns null', () => {
  assert.equal(renderHints([]), null);
  assert.match(renderHints(['a', 'b']), /Hints:\n- a\n- b/);
});
