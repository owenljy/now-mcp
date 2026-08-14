import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGlideRecordQuery,
  GraphqlService,
  GraphqlUnavailableError,
} from '../build/services/graphql-service.js';

const baseOptions = {
  limit: 10,
  offset: 0,
  fields: ['number', 'state'],
  displayValue: false,
  expand: {},
};

function makeManager(client) {
  return { getClient: () => client };
}

test('builds a GlideRecord query with the encoded query passed through unchanged', () => {
  const q = buildGlideRecordQuery('incident', {
    ...baseOptions,
    query: 'active=true^ORDERBYDESCsys_updated_on',
  });

  assert.match(q, /GlideRecord_Query/);
  assert.match(q, /incident\(/);
  // No query translation: queryConditions takes the same encoded query the Table
  // API takes, so operators and ORDERBY directives carry over verbatim.
  assert.match(q, /queryConditions: "active=true\^ORDERBYDESCsys_updated_on"/);
  assert.match(q, /pagination: \{limit: 10, offset: 0\}/);
  assert.match(q, /_rowCount/);
});

test('requests exactly one of value / displayValue per field, or both for "all"', () => {
  assert.match(buildGlideRecordQuery('incident', baseOptions), /number \{ value \}/);
  assert.match(
    buildGlideRecordQuery('incident', { ...baseOptions, displayValue: true }),
    /number \{ displayValue \}/,
  );
  assert.match(
    buildGlideRecordQuery('incident', { ...baseOptions, displayValue: 'all' }),
    /number \{ value displayValue \}/,
  );
});

test('expanded references select sub-fields through _reference', () => {
  const q = buildGlideRecordQuery('incident', {
    ...baseOptions,
    fields: ['number', 'caller_id'],
    expand: { caller_id: ['name', 'email'] },
  });

  assert.match(q, /caller_id \{ value displayValue _reference \{ name \{ value \} email \{ value \} \} \}/);
});

test('a field named only in expand is still fetched', () => {
  const q = buildGlideRecordQuery('incident', {
    ...baseOptions,
    fields: ['number'],
    expand: { caller_id: ['name'] },
  });

  assert.match(q, /caller_id \{ value displayValue _reference \{ name \{ value \} \} \}/);
});

test('identifiers are rejected rather than escaped', () => {
  // The document is built by interpolation, so anything outside the character
  // class ServiceNow names use would be an injection point.
  assert.throws(
    () => buildGlideRecordQuery('incident', { ...baseOptions, fields: ['number { } evil'] }),
    /Invalid field name/,
  );
  assert.throws(
    () => buildGlideRecordQuery('incident) { evil', baseOptions),
    /Invalid table name/,
  );
});

test('the encoded query is escaped, not interpolated raw', () => {
  const q = buildGlideRecordQuery('incident', {
    ...baseOptions,
    query: 'short_descriptionLIKE"quoted"',
  });

  assert.match(q, /queryConditions: "short_descriptionLIKE\\"quoted\\""/);
});

test('flattens rows into Table-API-shaped records and reports the true total', async () => {
  const client = {
    async post() {
      return {
        data: {
          GlideRecord_Query: {
            incident: {
              _rowCount: 67,
              _results: [{ number: { value: 'INC0000001' }, state: { value: '1' } }],
            },
          },
        },
      };
    },
  };
  const svc = new GraphqlService(makeManager(client));

  const result = await svc.queryRecords('incident', baseOptions);

  assert.deepEqual(result.records, [{ number: 'INC0000001', state: '1' }]);
  // _rowCount is the total matching the query, independent of the page size.
  assert.equal(result.totalCount, 67);
});

test('display_value keys follow the Table API, not GraphQL', async () => {
  const client = {
    async post() {
      return {
        data: {
          GlideRecord_Query: {
            incident: {
              _rowCount: 1,
              _results: [
                {
                  number: { value: 'INC1', displayValue: 'INC1' },
                  caller_id: {
                    value: 'abc',
                    displayValue: 'Fred Luddy',
                    _reference: { email: { value: 'fred@example.com', displayValue: 'fred@example.com' } },
                  },
                },
              ],
            },
          },
        },
      };
    },
  };
  const svc = new GraphqlService(makeManager(client));

  const result = await svc.queryRecords('incident', {
    ...baseOptions,
    displayValue: 'all',
    fields: ['number', 'caller_id'],
    expand: { caller_id: ['email'] },
  });

  assert.deepEqual(result.records[0].number, { value: 'INC1', display_value: 'INC1' });
  assert.equal(result.records[0].caller_id.value, 'abc');
  assert.equal(result.records[0].caller_id.display_value, 'Fred Luddy');
  assert.deepEqual(result.records[0].caller_id.email, {
    value: 'fred@example.com',
    display_value: 'fred@example.com',
  });
});

test('an in-band errors array is treated as a failure despite HTTP 200', async () => {
  // GraphQL reports failures with HTTP 200 and an errors array, so the status
  // code alone would make a failed query look like an empty success.
  const client = {
    async post() {
      return {
        data: null,
        errors: [{ message: "Validation error (UnknownArgument@[...]) : Unknown field argument 'pagination'" }],
      };
    },
  };
  const svc = new GraphqlService(makeManager(client));

  await assert.rejects(() => svc.queryRecords('incident', baseOptions), /GraphQL query failed/);
});

test('a missing GlideRecord namespace is reported as unavailable, not as a query error', async () => {
  const client = {
    async post() {
      return { data: null, errors: [{ message: "Unknown type 'GlideRecord_Query'" }] };
    },
  };
  const svc = new GraphqlService(makeManager(client));

  await assert.rejects(
    () => svc.queryRecords('incident', baseOptions),
    GraphqlUnavailableError,
  );
});

test('a 404 on the endpoint is reported as unavailable so callers can fall back', async () => {
  const client = {
    async post() {
      const error = new Error('Not Found');
      error.statusCode = 404;
      throw error;
    },
  };
  const svc = new GraphqlService(makeManager(client));

  await assert.rejects(
    () => svc.queryRecords('incident', baseOptions),
    GraphqlUnavailableError,
  );
});
