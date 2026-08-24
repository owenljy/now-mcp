import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_GROUPABLE_STRING_LENGTH,
  UNIQUE_COLUMNS,
  isGroupableField,
} from '../build/utils/groupability.js';

test('bounded types group regardless of declared length', () => {
  assert.equal(isGroupableField('active', { type: 'boolean', maxLength: 40 }), true);
  assert.equal(isGroupableField('state', { type: 'integer', maxLength: 40 }), true);
  assert.equal(isGroupableField('assignment_group', { type: 'reference', maxLength: 32 }), true);
  assert.equal(isGroupableField('contact_type', { type: 'choice', maxLength: 40 }), true);
});

test('a string field is judged by max_length, because the type alone cannot tell prose from a label', () => {
  // incident.category: choice-backed, 40 chars — the case the length test exists to admit.
  assert.equal(isGroupableField('category', { type: 'string', maxLength: 40 }), true);
  // sn_aia_message.user_message: 8000-char free text — one group per row.
  assert.equal(isGroupableField('user_message', { type: 'string', maxLength: 8000 }), false);
  // short_description (160) and title (255) are both prose by convention.
  assert.equal(isGroupableField('short_description', { type: 'string', maxLength: 160 }), false);
  assert.equal(isGroupableField('title', { type: 'string', maxLength: 255 }), false);
  // Boundary is inclusive.
  assert.equal(
    isGroupableField('x', { type: 'string', maxLength: MAX_GROUPABLE_STRING_LENGTH }),
    true,
  );
  assert.equal(
    isGroupableField('x', { type: 'string', maxLength: MAX_GROUPABLE_STRING_LENGTH + 1 }),
    false,
  );
});

test('a string field with no declared length is not assumed short', () => {
  assert.equal(isGroupableField('mystery', { type: 'string' }), false);
});

test('unique-per-row columns are refused even when their type looks groupable', () => {
  // number is a 40-char string — it would pass the length test on type alone.
  assert.equal(isGroupableField('number', { type: 'string', maxLength: 40 }), false);
  for (const name of UNIQUE_COLUMNS) {
    assert.equal(isGroupableField(name, { type: 'string', maxLength: 40 }), false, name);
  }
});

test('prose, continuous and opaque types never group', () => {
  for (const type of [
    'journal',
    'journal_input',
    'html',
    'script',
    'xml',
    'json',
    'GUID',
    'document_id',
    'glide_date_time',
    'decimal',
    'currency',
    'compressed',
  ]) {
    assert.equal(isGroupableField('f', { type }), false, type);
  }
});

test('an unresolved field returns false rather than guessing', () => {
  assert.equal(isGroupableField('caller_id.department.name', undefined), false);
});
