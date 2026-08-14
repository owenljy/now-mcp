import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractQueryFields } from '../build/utils/encoded-query.js';

test('extracts fields from simple AND/OR conditions', () => {
  assert.deepEqual(extractQueryFields('priority=1'), ['priority']);
  assert.deepEqual(extractQueryFields('priority=1^state=2'), ['priority', 'state']);
  assert.deepEqual(extractQueryFields('priority=1^ORstate=2'), ['priority', 'state']);
  assert.deepEqual(extractQueryFields('active=true^NQpriority=1'), ['active', 'priority']);
});

test('a field name beginning with the OR marker is not mangled', () => {
  // `^ORoriginal_field=2` is `^OR` + `original_field=2`, and `^origin_table=x` is
  // `^` + `origin_table=x`. Both must survive the separator split intact.
  assert.deepEqual(extractQueryFields('a=1^ORoriginal_field=2'), ['a', 'original_field']);
  assert.deepEqual(extractQueryFields('a=1^origin_table=x'), ['a', 'origin_table']);
});

test('word operators are split off the field name', () => {
  assert.deepEqual(extractQueryFields('commentsISNOTEMPTY'), ['comments']);
  assert.deepEqual(extractQueryFields('short_descriptionISEMPTY'), ['short_description']);
  assert.deepEqual(extractQueryFields('short_descriptionLIKEemail'), ['short_description']);
  assert.deepEqual(extractQueryFields('numberSTARTSWITHINC'), ['number']);
  assert.deepEqual(extractQueryFields('stateIN1,2,3'), ['state']);
  assert.deepEqual(extractQueryFields('priority!=1'), ['priority']);
  assert.deepEqual(extractQueryFields('sys_mod_count>=5'), ['sys_mod_count']);
});

test('the earliest operator wins when a value contains operator-like text', () => {
  // LIKE at 17 must win over the IN inside "INCIDENT" at 21.
  assert.deepEqual(extractQueryFields('short_descriptionLIKEINCIDENT'), ['short_description']);
});

test('ORDERBY / ORDERBYDESC / GROUPBY fields are extracted', () => {
  assert.deepEqual(extractQueryFields('active=true^ORDERBYDESCsys_updated_on'), [
    'active',
    'sys_updated_on',
  ]);
  assert.deepEqual(extractQueryFields('^ORDERBYnumber'), ['number']);
  assert.deepEqual(extractQueryFields('GROUPBYassignment_group'), ['assignment_group']);
});

test('dot-walked references are returned whole for the caller to validate', () => {
  assert.deepEqual(extractQueryFields('caller_id.department.name=Network'), [
    'caller_id.department.name',
  ]);
});

test('date expressions with javascript: values keep the field only', () => {
  assert.deepEqual(
    extractQueryFields(
      'sys_created_onONLast 30 days@javascript:gs.beginningOfLast30Days()@javascript:gs.endOfLast30Days()',
    ),
    ['sys_created_on'],
  );
});

test('related-list and join sub-syntax is skipped rather than guessed at', () => {
  // RLQUERY's operand is not a column on this table; reporting it as an unknown
  // field would block a legitimate query.
  assert.deepEqual(extractQueryFields('RLQUERYtask_ci.ci_item,>=1^ENDRLQUERY'), []);
});

test('empty and separator-only input yields nothing', () => {
  assert.deepEqual(extractQueryFields(undefined), []);
  assert.deepEqual(extractQueryFields(''), []);
  assert.deepEqual(extractQueryFields('^^'), []);
  assert.deepEqual(extractQueryFields('^EQ'), []);
});

test('duplicate references are reported once', () => {
  assert.deepEqual(extractQueryFields('priority=1^ORpriority=2'), ['priority']);
});

test('a clause with no operator is skipped, not treated as a field', () => {
  assert.deepEqual(extractQueryFields('justsometext'), []);
});
