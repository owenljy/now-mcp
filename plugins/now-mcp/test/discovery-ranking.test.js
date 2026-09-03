import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rankItems, rankingTerms, scoreItem } from '../build/utils/discovery-ranking.js';

const order = (items, terms) => rankItems(items, terms).map((r) => r.item.name);

test('an exact name match outranks an alphabetically earlier substring match', () => {
  // The core failure: the instance returns name order, so `incident_alert` sorts
  // ahead of `incident` and the caller sees the wrong table first.
  const items = [
    { name: 'incident_alert', label: 'Incident Alert' },
    { name: 'incident', label: 'Incident' },
    { name: 'alm_hardware_incident', label: 'Hardware Incident' },
  ];
  assert.equal(order(items, ['incident'])[0], 'incident');
});

test('an exact label match beats an incidental substring in a name', () => {
  const items = [
    { name: 'x_foo_task_junk', label: 'Junk' },
    { name: 'sc_task', label: 'task' },
  ];
  assert.equal(order(items, ['task'])[0], 'sc_task');
});

test('a prefix match beats a mid-string match', () => {
  const items = [
    { name: 'sys_user_has_role', label: 'Has Role' },
    { name: 'user_criteria', label: 'User Criteria' },
  ];
  assert.equal(order(items, ['user'])[0], 'user_criteria');
});

test('core/global scope outranks an unrelated store app with the same shape', () => {
  const items = [
    { name: 'x_vendor_incident', label: 'Incident', scope: 'x_vendor_app' },
    { name: 'core_incident', label: 'Incident' },
  ];
  assert.equal(order(items, ['incident'])[0], 'core_incident');
});

test('staging, history, metric and audit satellites are demoted below the base table', () => {
  for (const satellite of [
    'incident_metric',
    'incident_history',
    'incident_ext_staging',
    'sys_audit_incident',
    'incident_archive',
  ]) {
    const items = [{ name: satellite, label: 'Incident' }, { name: 'incident', label: 'Incident' }];
    assert.equal(order(items, ['incident'])[0], 'incident', `${satellite} must not outrank incident`);
  }
});

test('a row matching every keyword outranks one matching a single generic keyword', () => {
  const items = [
    { name: 'a_chat_thing', label: 'Chat Thing', matched: 'chat' },
    { name: 'b_conversation', label: 'Conversation', matched: 'chat,conversation' },
  ];
  assert.equal(order(items, ['chat', 'conversation'])[0], 'b_conversation');
});

test('ties break toward the shorter name — the base table, far more often than not', () => {
  const items = [
    { name: 'task_extended_thing', label: 'X' },
    { name: 'task_sla', label: 'X' },
  ];
  assert.equal(order(items, ['task'])[0], 'task_sla');
});

test('ranking is deterministic — same input, same order, regardless of input order', () => {
  const items = [
    { name: 'incident_alert', label: 'A' },
    { name: 'incident', label: 'Incident' },
    { name: 'incident_task', label: 'B' },
  ];
  const forward = order(items, ['incident']);
  const backward = order([...items].reverse(), ['incident']);
  assert.deepEqual(forward, backward);
});

test('with no search terms, structural signals still apply and nothing throws', () => {
  const items = [
    { name: 'zzz_history', label: 'Z' },
    { name: 'aaa', label: 'A' },
  ];
  assert.equal(order(items, [])[0], 'aaa');
});

test('rankingTerms strips wildcard anchors so exact-match rules can fire', () => {
  // Leaving the `*` in would make "incident*" never equal "incident", silently
  // disabling the highest-value rule for the most common filter form.
  assert.deepEqual(rankingTerms('incident*'), ['incident']);
  assert.deepEqual(rankingTerms('*task'), ['task']);
  assert.deepEqual(rankingTerms('*task*'), ['task']);
});

test('rankingTerms lowercases and merges filter with concept keywords', () => {
  assert.deepEqual(rankingTerms('Incident*', ['Chat', ' Messaging ']), [
    'incident',
    'chat',
    'messaging',
  ]);
});

test('rankingTerms drops empty input rather than emitting a term that matches everything', () => {
  assert.deepEqual(rankingTerms(undefined, undefined), []);
  assert.deepEqual(rankingTerms('**', ['  ']), []);
});

test('scoring is additive and explainable — an exact hit scores above any prefix hit', () => {
  const exact = scoreItem({ name: 'incident', label: 'Incident' }, ['incident']);
  const prefix = scoreItem({ name: 'incident_task', label: 'Incident Task' }, ['incident']);
  const substring = scoreItem({ name: 'x_my_incident', label: 'Mine' }, ['incident']);
  assert.ok(exact > prefix);
  assert.ok(prefix > substring);
});
