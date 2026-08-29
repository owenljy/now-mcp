import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ServiceNowClient } from '../build/client/servicenow-client.js';

function client() {
	return new ServiceNowClient('https://dev123.service-now.com', {
		type: 'basic',
		username: 'api.user',
		password: 'secret',
	});
}

function response(status, body, headers = {}) {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: status >= 500 ? 'Server Error' : status === 429 ? 'Too Many Requests' : 'OK',
		headers: {
			forEach(callback) {
				for (const [key, value] of Object.entries(headers)) callback(value, key);
			},
		},
		json: async () => body,
		text: async () => (body === undefined ? '' : JSON.stringify(body)),
	};
}

afterEach(() => {
	delete globalThis.fetch;
});

test('a network failure after POST is not replayed and reports an uncertain outcome', async () => {
	let calls = 0;
	globalThis.fetch = async () => {
		calls += 1;
		throw new Error('socket reset');
	};

	await assert.rejects(client().post('/api/now/table/incident', { short_description: 'x' }), (error) => {
		assert.equal(error.code, 'MUTATION_OUTCOME_UNCERTAIN');
		assert.equal(error.servicenowError.outcome, 'uncertain');
		assert.equal(error.servicenowError.retryable, false);
		assert.equal(error.servicenowError.method, 'POST');
		assert.equal(error.servicenowError.endpoint, '/api/now/table/incident');
		return true;
	});
	assert.equal(calls, 1, 'non-idempotent POST must never be replayed automatically');
});

test('a 5xx mutation response is not replayed because commit state is uncertain', async () => {
	let calls = 0;
	globalThis.fetch = async () => {
		calls += 1;
		return response(503, { error: { message: 'upstream failed after dispatch' } });
	};

	await assert.rejects(client().patch(`/api/now/table/incident/${'a'.repeat(32)}`, { active: false }), (error) => {
		assert.equal(error.code, 'MUTATION_OUTCOME_UNCERTAIN');
		assert.match(error.servicenowError.reason, /upstream failed/);
		return true;
	});
	assert.equal(calls, 1);
});

test('a mutation rejected with 429 is not replayed and remains a definite rate-limit error', async () => {
	let calls = 0;
	globalThis.fetch = async () => {
		calls += 1;
		return response(429, { error: { message: 'slow down' } }, { 'retry-after': '0' });
	};

	await assert.rejects(client().post('/api/now/table/incident', { short_description: 'x' }), (error) => {
		assert.equal(error.code, 'RATE_LIMIT_ERROR');
		return true;
	});
	assert.equal(calls, 1);
});

test('safe reads still retry transient failures', async () => {
	let calls = 0;
	globalThis.fetch = async () => {
		calls += 1;
		if (calls === 1) {
			return response(429, { error: { message: 'slow down' } }, { 'retry-after': '0' });
		}
		return response(200, { result: [{ sys_id: 'a'.repeat(32) }] });
	};

	const result = await client().get('/api/now/table/incident');
	assert.equal(calls, 2);
	assert.equal(result.result[0].sys_id, 'a'.repeat(32));
});
