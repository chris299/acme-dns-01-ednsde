'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { create } = require('../lib/presenter');
const { startStubApi, ok } = require('../stubs/api');
const { createStubDns, dnsError } = require('../stubs/dns');

const DIGEST = 'kzGkkjrcHhVWEwoc7bwpFywxKtFhBvOZ0hCEwXVSVAg';
const OTHER_DIGEST = 'Xy7bQeRtY1uIoP2aSdFgH3jKlZxCvBnM4qWeRtY6uIo';
const HOST = '_acme-challenge.foo.example.com';
const NS = ['10.0.0.3', '10.0.0.4'];

// A zone at example.com served by two nameservers, which is the shape of a
// real eDNS zone.
function baseDnsSpec(txt) {
	return {
		soa: ['example.com'],
		ns: { 'example.com': ['ns3.edns.de', 'ns4.edns.de'] },
		addresses: { 'ns3.edns.de': ['10.0.0.3'], 'ns4.edns.de': ['10.0.0.4'] },
		txt: txt || {},
	};
}

function servingEverywhere(host, values) {
	const txt = {};
	for (const server of NS) {
		txt[`${server}|${host}`] = values;
	}
	return txt;
}

async function withPresenter(dnsSpec, handler, run, extraOptions) {
	const stub = await startStubApi(
		handler || (() => ok('addChallengeRecord', 1, 'added')),
	);
	const dns = createStubDns(dnsSpec);
	const presenter = create({
		token: 'secret-token',
		endpoint: stub.endpoint,
		resolver: dns,
		propagationTimeout: 400,
		propagationInterval: 10,
		...extraOptions,
	});
	try {
		await run({ presenter, dns, stub });
	} finally {
		await stub.close();
	}
}

function challenge(overrides) {
	return {
		type: 'dns-01',
		identifier: { type: 'dns', value: 'foo.example.com' },
		wildcard: false,
		dnsHost: HOST,
		keyAuthorizationDigest: DIGEST,
		dnsAuthorization: DIGEST,
		...overrides,
	};
}

test('create refuses to build a presenter without a token', () => {
	assert.throws(() => create({}), /`token` option is required/);
});

test('the presenter announces that it verifies propagation itself', async () => {
	await withPresenter(baseDnsSpec(), null, ({ presenter }) => {
		assert.equal(presenter.propagationDelay, 0);
		assert.equal(presenter.skipChallengeTest, true);
	});
});

test('zones walks up to the zone cut, in the shape acme.js asks', async () => {
	await withPresenter(baseDnsSpec(), null, async ({ presenter }) => {
		const zones = await presenter.zones({
			challenge: { type: 'dns-01', dnsHosts: ['ab.foo.example.com'] },
		});
		assert.deepEqual(zones, ['example.com']);
	});
});

test('zones accepts the shape the test harness asks, including wildcards', async () => {
	await withPresenter(baseDnsSpec(), null, async ({ presenter }) => {
		const zones = await presenter.zones({
			dnsHosts: ['example.com', 'foo.example.com', '*.foo.example.com'],
		});
		assert.deepEqual(zones, ['example.com']);
	});
});

test('zones normalises an IDN host before walking', async () => {
	const spec = baseDnsSpec();
	spec.soa = ['xn--6qq79v.example.com'];
	await withPresenter(spec, null, async ({ presenter, dns }) => {
		const zones = await presenter.zones({ dnsHosts: ['foo.你好.example.com'] });
		assert.deepEqual(zones, ['xn--6qq79v.example.com']);
		assert.ok(dns.calls.soa.every(name => !/[^\x20-\x7e]/.test(name)));
	});
});

test('zones caches a determined zone and does not walk the same host twice', async () => {
	await withPresenter(baseDnsSpec(), null, async ({ presenter, dns }) => {
		await presenter.zones({ dnsHosts: ['ab.foo.example.com'] });
		const afterFirst = dns.calls.soa.length;
		await presenter.zones({ dnsHosts: ['ab.foo.example.com'] });
		assert.equal(dns.calls.soa.length, afterFirst);
	});
});

test('an explicit zones option short-circuits the walk entirely', async () => {
	await withPresenter(
		baseDnsSpec(),
		null,
		async ({ presenter, dns }) => {
			assert.deepEqual(
				await presenter.zones({ dnsHosts: ['ab.foo.example.com'] }),
				['example.com'],
			);
			assert.equal(dns.calls.soa.length, 0);
		},
		{ zones: ['example.com'] },
	);
});

test('zones fails loudly rather than returning a public suffix', async () => {
	const spec = baseDnsSpec();
	spec.soa = [];
	await withPresenter(spec, null, async ({ presenter }) => {
		await assert.rejects(
			() => presenter.zones({ dnsHosts: ['foo.example.com'] }),
			/could not determine the DNS zone/,
		);
	});
});

test('set splits the host into domain and subdomain and waits for propagation', async () => {
	let round = 0;
	const txt = {};
	for (const server of NS) {
		txt[`${server}|${HOST}`] = count => {
			round = Math.max(round, count);
			return count >= 3 ? [DIGEST] : null;
		};
	}

	await withPresenter(
		baseDnsSpec(txt),
		() => ok('addChallengeRecord', 1, 'added'),
		async ({ presenter, stub }) => {
			assert.equal(await presenter.set({ challenge: challenge() }), true);
			assert.deepEqual(stub.requests[0].body, {
				action: 'addChallengeRecord',
				domain: 'example.com',
				subdomain: '_acme-challenge.foo',
				challenge_token: DIGEST,
			});
			assert.ok(round >= 3, 'should have polled until the record showed up');
		},
	);
});

test('set omits the subdomain when the challenge sits on the zone apex', async () => {
	const host = '_acme-challenge.example.com';
	await withPresenter(
		baseDnsSpec(servingEverywhere(host, [DIGEST])),
		() => ok('addChallengeRecord', 1, 'added'),
		async ({ presenter, stub }) => {
			// The zone itself is the challenge host's parent, so the prefix is
			// the ACME label and not empty; a true apex record is what a zone
			// named _acme-challenge.example.com would produce.
			await presenter.set({
				challenge: challenge({ dnsHost: host, dnsZone: 'example.com' }),
			});
			assert.equal(stub.requests[0].body.subdomain, '_acme-challenge');

			const apexSpec = baseDnsSpec(servingEverywhere('example.com', [DIGEST]));
			const apex = create({
				token: 't',
				endpoint: stub.endpoint,
				resolver: createStubDns(apexSpec),
				propagationTimeout: 400,
				propagationInterval: 10,
			});
			await apex.set({
				challenge: challenge({ dnsHost: 'example.com', dnsZone: 'example.com' }),
			});
			assert.equal('subdomain' in stub.requests[1].body, false);
		},
	);
});

test('set trusts the zone acme.js announces and skips the walk', async () => {
	await withPresenter(
		baseDnsSpec(servingEverywhere(HOST, [DIGEST])),
		() => ok('addChallengeRecord', 1, 'added'),
		async ({ presenter, dns }) => {
			await presenter.set({ challenge: challenge({ dnsZone: 'example.com' }) });
			assert.equal(dns.calls.soa.length, 0);
		},
	);
});

test('set gives up with a message that names the SOA minimum', async () => {
	await withPresenter(
		baseDnsSpec(),
		() => ok('addChallengeRecord', 1, 'added'),
		async ({ presenter }) => {
			const err = await presenter.set({ challenge: challenge() }).then(
				() => null,
				e => e,
			);
			assert.match(err.message, /SOA minimum/);
			assert.match(err.message, /dig \+short SOA example\.com/);
			assert.match(err.message, /0 of 2 serving it/);
		},
	);
});

test('a silent nameserver delays the run but does not doom it', async () => {
	const txt = {
		[`10.0.0.3|${HOST}`]: [DIGEST],
		[`10.0.0.4|${HOST}`]: dnsError('ETIMEOUT'),
	};
	await withPresenter(
		baseDnsSpec(txt),
		() => ok('addChallengeRecord', 1, 'added'),
		async ({ presenter }) => {
			const started = Date.now();
			assert.equal(await presenter.set({ challenge: challenge() }), true);
			const elapsed = Date.now() - started;
			assert.ok(
				elapsed >= 180,
				`should have waited out the strict half, waited ${elapsed}ms`,
			);
			assert.ok(
				elapsed < 400,
				`should not have hit the deadline, waited ${elapsed}ms`,
			);
		},
	);
});

test('get picks our own digest out of two values on one host', async () => {
	await withPresenter(
		baseDnsSpec(servingEverywhere(HOST, [OTHER_DIGEST, DIGEST])),
		null,
		async ({ presenter }) => {
			const result = await presenter.get({ challenge: challenge() });
			assert.deepEqual(result, {
				dnsAuthorization: DIGEST,
				keyAuthorizationDigest: DIGEST,
			});
		},
	);
});

test('get returns null when only a foreign digest is present', async () => {
	await withPresenter(
		baseDnsSpec(servingEverywhere(HOST, [OTHER_DIGEST])),
		null,
		async ({ presenter }) => {
			assert.equal(await presenter.get({ challenge: challenge() }), null);
		},
	);
});

test('get finds the host in identifier.value when the harness drops dnsHost', async () => {
	await withPresenter(
		baseDnsSpec(servingEverywhere(HOST, [DIGEST])),
		null,
		async ({ presenter }) => {
			const query = {
				type: 'dns-01',
				identifier: { type: 'dns', value: HOST },
				dnsAuthorization: DIGEST,
				dnsZone: 'example.com',
			};
			const result = await presenter.get({ challenge: query });
			assert.equal(result.dnsAuthorization, DIGEST);
		},
	);
});

test('get returns null after a confirmed removal, though DNS still serves it', async () => {
	// This is docs/adr/0003 in one test: eDNS keeps answering with the removed
	// record for about its TTL, so the DNS answer below stays put on purpose.
	await withPresenter(
		baseDnsSpec(servingEverywhere(HOST, [DIGEST])),
		body =>
			body.action === 'removeChallengeRecord'
				? ok('removeChallengeRecord', 3, 'removed')
				: ok('addChallengeRecord', 1, 'added'),
		async ({ presenter }) => {
			assert.ok(await presenter.get({ challenge: challenge() }));
			await presenter.remove({ challenge: challenge() });
			assert.equal(await presenter.get({ challenge: challenge() }), null);
		},
	);
});

test('a later set makes the same value visible to get again', async () => {
	await withPresenter(
		baseDnsSpec(servingEverywhere(HOST, [DIGEST])),
		body =>
			body.action === 'removeChallengeRecord'
				? ok('removeChallengeRecord', 3, 'removed')
				: ok('addChallengeRecord', 1, 'added'),
		async ({ presenter }) => {
			await presenter.remove({ challenge: challenge() });
			assert.equal(await presenter.get({ challenge: challenge() }), null);
			await presenter.set({ challenge: challenge() });
			assert.ok(await presenter.get({ challenge: challenge() }));
		},
	);
});

test('remove stays quiet when the record was not there', async () => {
	await withPresenter(
		baseDnsSpec(servingEverywhere(HOST, [DIGEST])),
		() => ok('removeChallengeRecord', 5, 'not found'),
		async ({ presenter }) => {
			assert.equal(await presenter.remove({ challenge: challenge() }), true);
		},
	);
});

test('remove does not wait for propagation', async () => {
	await withPresenter(
		baseDnsSpec(),
		() => ok('removeChallengeRecord', 3, 'removed'),
		async ({ presenter }) => {
			const started = Date.now();
			await presenter.remove({ challenge: challenge({ dnsZone: 'example.com' }) });
			assert.ok(Date.now() - started < 200, 'remove must not poll');
		},
	);
});

test('init takes nothing and returns null', async () => {
	await withPresenter(baseDnsSpec(), null, ({ presenter }) => {
		assert.equal(presenter.init({ request: () => {} }), null);
	});
});

test('a nameserver reachable over two address families counts once', async () => {
	const spec = baseDnsSpec(servingEverywhere(HOST, [DIGEST]));
	// Both families announced; only the v4 address is ever queried.
	spec.addresses = {
		'ns3.edns.de': ['10.0.0.3'],
		'ns4.edns.de': ['10.0.0.4'],
	};
	await withPresenter(
		spec,
		() => ok('addChallengeRecord', 1, 'added'),
		async ({ presenter, dns }) => {
			await presenter.set({ challenge: challenge({ dnsZone: 'example.com' }) });
			const queried = new Set(dns.calls.txtAt.map(call => call.split('|')[0]));
			assert.deepEqual([...queried].sort(), ['10.0.0.3', '10.0.0.4']);
		},
	);
});

test('when no nameserver answers at all, the configured resolver takes over', async () => {
	const txt = {
		[`10.0.0.3|${HOST}`]: dnsError('ETIMEOUT'),
		[`10.0.0.4|${HOST}`]: dnsError('ETIMEOUT'),
		[`system|${HOST}`]: [DIGEST],
	};
	await withPresenter(
		baseDnsSpec(txt),
		() => ok('addChallengeRecord', 1, 'added'),
		async ({ presenter }) => {
			const started = Date.now();
			assert.equal(
				await presenter.set({ challenge: challenge({ dnsZone: 'example.com' }) }),
				true,
			);
			// The fallback must engage on the first round, not after the strict
			// half of the budget has been burnt.
			assert.ok(Date.now() - started < 150, 'should not wait out the strict half');
		},
		{ fallbackFirstQuery: 20 },
	);
});

test('the fallback asks late, so an early miss cannot poison the answer', async () => {
	// The record only shows up on the second query. With an immediate first
	// question a caching resolver would hold the NXDOMAIN for the whole SOA
	// minimum, so the wait has to start after the propagation window.
	const txt = {
		[`10.0.0.3|${HOST}`]: dnsError('ETIMEOUT'),
		[`10.0.0.4|${HOST}`]: dnsError('ETIMEOUT'),
		[`system|${HOST}`]: count => (count >= 2 ? [DIGEST] : null),
	};
	const spec = baseDnsSpec(txt);
	spec.soaMinimum = 0.05;
	await withPresenter(
		spec,
		() => ok('addChallengeRecord', 1, 'added'),
		async ({ presenter, dns }) => {
			await presenter.set({ challenge: challenge({ dnsZone: 'example.com' }) });
			const systemQueries = dns.calls.txtAt.filter(call =>
				call.startsWith('system|'),
			);
			assert.equal(systemQueries.length, 2);
		},
		{ fallbackFirstQuery: 20 },
	);
});

test('a blocked port 53 is reported as such, and names the SOA minimum it obeyed', async () => {
	const txt = {
		[`10.0.0.3|${HOST}`]: dnsError('ETIMEOUT'),
		[`10.0.0.4|${HOST}`]: dnsError('ETIMEOUT'),
	};
	const spec = baseDnsSpec(txt);
	spec.soaMinimum = 0.1;
	await withPresenter(
		spec,
		() => ok('addChallengeRecord', 1, 'added'),
		async ({ presenter }) => {
			const err = await presenter
				.set({ challenge: challenge({ dnsZone: 'example.com' }) })
				.then(
					() => null,
					e => e,
				);
			assert.match(err.message, /block outbound DNS on port 53/);
			assert.match(err.message, /10\.0\.0\.3, 10\.0\.0\.4/);
			assert.match(err.message, new RegExp(DIGEST));
			assert.match(err.message, /SOA minimum of 0\.1s/);
		},
		{ fallbackFirstQuery: 20 },
	);
});

test('a failed wait removes the record it had just created', async () => {
	const actions = [];
	await withPresenter(
		baseDnsSpec(),
		body => {
			actions.push(body.action);
			return body.action === 'removeChallengeRecord'
				? ok('removeChallengeRecord', 3, 'removed')
				: ok('addChallengeRecord', 1, 'added');
		},
		async ({ presenter }) => {
			await assert.rejects(() =>
				presenter.set({ challenge: challenge({ dnsZone: 'example.com' }) }),
			);
			assert.deepEqual(actions, ['addChallengeRecord', 'removeChallengeRecord']);
		},
	);
});

test('the propagation failure survives a cleanup that also fails', async () => {
	await withPresenter(
		baseDnsSpec(),
		body =>
			body.action === 'removeChallengeRecord'
				? { status: 500, body: { status: 500, message: 'boom', data: [] } }
				: ok('addChallengeRecord', 1, 'added'),
		async ({ presenter }) => {
			const err = await presenter
				.set({ challenge: challenge({ dnsZone: 'example.com' }) })
				.then(
					() => null,
					e => e,
				);
			assert.match(err.message, /was not served by all authoritative nameservers/);
		},
	);
});

test('get falls back to the configured resolver when no nameserver answers', async () => {
	const txt = {
		[`10.0.0.3|${HOST}`]: dnsError('ETIMEOUT'),
		[`10.0.0.4|${HOST}`]: dnsError('ETIMEOUT'),
		[`system|${HOST}`]: [OTHER_DIGEST, DIGEST],
	};
	await withPresenter(baseDnsSpec(txt), null, async ({ presenter }) => {
		const result = await presenter.get({
			challenge: challenge({ dnsZone: 'example.com' }),
		});
		assert.equal(result.dnsAuthorization, DIGEST);
	});
});

test('get still reports null for a foreign digest seen through the resolver', async () => {
	const txt = {
		[`10.0.0.3|${HOST}`]: dnsError('ETIMEOUT'),
		[`10.0.0.4|${HOST}`]: dnsError('ETIMEOUT'),
		[`system|${HOST}`]: [OTHER_DIGEST],
	};
	await withPresenter(baseDnsSpec(txt), null, async ({ presenter }) => {
		assert.equal(
			await presenter.get({ challenge: challenge({ dnsZone: 'example.com' }) }),
			null,
		);
	});
});

test('a name that already carries other values gets the longer budget', async () => {
	// eDNS answers such a name from its 300s record cache, so the added value
	// only becomes visible once that expires. Here it shows up after a delay
	// that the ordinary budget would not have survived.
	let round = 0;
	const txt = {};
	for (const server of NS) {
		txt[`${server}|${HOST}`] = count => {
			round = Math.max(round, count);
			return count >= 8 ? [OTHER_DIGEST, DIGEST] : [OTHER_DIGEST];
		};
	}
	await withPresenter(
		baseDnsSpec(txt),
		() => ok('addChallengeRecord', 1, 'added'),
		async ({ presenter }) => {
			assert.equal(
				await presenter.set({ challenge: challenge({ dnsZone: 'example.com' }) }),
				true,
			);
			assert.ok(round >= 8, 'should have polled past the ordinary budget');
		},
		// The ordinary budget expires after ~4 polls; the shared-name one does not.
		{ propagationTimeout: 40, sharedNameTimeout: 2000 },
	);
});

test('a fresh name keeps the ordinary budget', async () => {
	// Nothing at the name at all, so there is no cache to wait out and the
	// longer budget must not apply.
	await withPresenter(
		baseDnsSpec(),
		body =>
			body.action === 'removeChallengeRecord'
				? ok('removeChallengeRecord', 3, 'removed')
				: ok('addChallengeRecord', 1, 'added'),
		async ({ presenter }) => {
			const started = Date.now();
			await assert.rejects(() =>
				presenter.set({ challenge: challenge({ dnsZone: 'example.com' }) }),
			);
			assert.ok(
				Date.now() - started < 1000,
				'should not have waited out the shared-name budget',
			);
		},
		{ propagationTimeout: 40, sharedNameTimeout: 60000 },
	);
});

test('the shared-name timeout explains itself in the failure message', async () => {
	const txt = {};
	for (const server of NS) {
		txt[`${server}|${HOST}`] = [OTHER_DIGEST];
	}
	await withPresenter(
		baseDnsSpec(txt),
		() => ok('addChallengeRecord', 1, 'added'),
		async ({ presenter }) => {
			const err = await presenter
				.set({ challenge: challenge({ dnsZone: 'example.com' }) })
				.then(
					() => null,
					e => e,
				);
			assert.match(err.message, /300s record cache/);
			assert.doesNotMatch(err.message, /SOA minimum/);
		},
		{ propagationTimeout: 40, sharedNameTimeout: 120 },
	);
});
