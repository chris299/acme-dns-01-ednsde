'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApiClient, ApiError } = require('../lib/api');
const { startStubApi, ok, fail } = require('../stubs/api');

const DIGEST = 'kzGkkjrcHhVWEwoc7bwpFywxKtFhBvOZ0hCEwXVSVAg';

async function withStub(handler, run) {
	const stub = await startStubApi(handler);
	try {
		await run(
			stub,
			createApiClient({ token: 'secret-token', endpoint: stub.endpoint }),
		);
	} finally {
		await stub.close();
	}
}

test('add sends the action, domain, subdomain and token header', async () => {
	await withStub(
		() => ok('addChallengeRecord', 1, 'added'),
		async (stub, api) => {
			assert.equal(
				await api.add('example.com', '_acme-challenge.foo', DIGEST),
				true,
			);
			assert.equal(stub.requests.length, 1);
			assert.equal(stub.requests[0].method, 'POST');
			assert.equal(stub.requests[0].headers['x-api-token'], 'secret-token');
			assert.deepEqual(stub.requests[0].body, {
				action: 'addChallengeRecord',
				domain: 'example.com',
				subdomain: '_acme-challenge.foo',
				challenge_token: DIGEST,
			});
		},
	);
});

test('add omits subdomain entirely on the zone apex', async () => {
	await withStub(
		() => ok('addChallengeRecord', 1, 'added'),
		async (stub, api) => {
			await api.add('example.com', '', DIGEST);
			assert.equal('subdomain' in stub.requests[0].body, false);
		},
	);
});

test('add treats an already existing record as created', async () => {
	await withStub(
		() => ok('addChallengeRecord', 2, 'already exists'),
		async (stub, api) => {
			assert.equal(await api.add('example.com', '_acme-challenge', DIGEST), true);
		},
	);
});

test('add rejects a result code it does not expect', async () => {
	await withStub(
		() => ok('addChallengeRecord', 5, 'not found'),
		async (stub, api) => {
			await assert.rejects(
				() => api.add('example.com', '', DIGEST),
				/unexpected result_code 5/,
			);
		},
	);
});

test('remove reports a deleted record', async () => {
	await withStub(
		() => ok('removeChallengeRecord', 3, 'removed'),
		async (stub, api) => {
			assert.equal(await api.remove('example.com', '', DIGEST), true);
		},
	);
});

test('remove reports a record that DNS had already dropped', async () => {
	await withStub(
		() => ok('removeChallengeRecord', 4, 'already removed'),
		async (stub, api) => {
			assert.equal(await api.remove('example.com', '', DIGEST), true);
		},
	);
});

test('remove returns false, and does not throw, when there is nothing to delete', async () => {
	await withStub(
		() => ok('removeChallengeRecord', 5, 'not found'),
		async (stub, api) => {
			assert.equal(await api.remove('example.com', '', DIGEST), false);
		},
	);
});

test('a 401 carries the hint about zone assignment and is not retried', async () => {
	await withStub(
		() => fail(401, 'unauthorized'),
		async (stub, api) => {
			const err = await api.add('example.com', '', DIGEST).then(
				() => null,
				e => e,
			);
			assert.ok(err instanceof ApiError);
			assert.equal(err.statusCode, 401);
			assert.match(err.message, /assigned to this zone/);
			assert.equal(stub.requests.length, 1);
		},
	);
});

test('a 400 is not retried', async () => {
	await withStub(
		() => fail(400, 'bad request'),
		async (stub, api) => {
			await assert.rejects(() => api.add('example.com', '', DIGEST), /HTTP 400/);
			assert.equal(stub.requests.length, 1);
		},
	);
});

test('a 429 is retried and the later success is returned', async () => {
	await withStub(
		(body, attempt) =>
			attempt < 3 ? fail(429, 'slow down') : ok('addChallengeRecord', 1, 'added'),
		async (stub, api) => {
			assert.equal(await api.add('example.com', '', DIGEST), true);
			assert.equal(stub.requests.length, 3);
		},
	);
});

test('a persistent 500 gives up after three attempts', async () => {
	await withStub(
		() => fail(500, 'boom'),
		async (stub, api) => {
			await assert.rejects(() => api.add('example.com', '', DIGEST), /HTTP 500/);
			assert.equal(stub.requests.length, 3);
		},
	);
});

test('a value outside the length bounds never reaches the network', async () => {
	await withStub(
		() => ok('addChallengeRecord', 1, 'added'),
		async (stub, api) => {
			await assert.rejects(
				() => api.add('example.com', '', 'tooshort'),
				/between 10 and 64/,
			);
			await assert.rejects(
				() => api.add('example.com', '', 'x'.repeat(65)),
				/between 10 and 64/,
			);
			assert.equal(stub.requests.length, 0);
		},
	);
});

test('a value containing whitespace never reaches the network', async () => {
	await withStub(
		() => ok('addChallengeRecord', 1, 'added'),
		async (stub, api) => {
			await assert.rejects(
				() => api.add('example.com', '', 'has a space in it'),
				/must not contain whitespace/,
			);
			assert.equal(stub.requests.length, 0);
		},
	);
});

test('a 43-character ACME digest is inside the bounds', async () => {
	assert.equal(DIGEST.length, 43);
	await withStub(
		() => ok('addChallengeRecord', 1, 'added'),
		async (stub, api) => {
			assert.equal(await api.add('example.com', '', DIGEST), true);
		},
	);
});
