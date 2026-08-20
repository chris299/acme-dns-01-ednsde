'use strict';

const { createApiClient } = require('./api');
const { createDnsClient } = require('./dns');
const { toAscii, stripWildcards, zoneCandidates, splitHost } = require('./names');

// eDNS publishes a new challenge name to all its nameservers in about 23
// seconds, and immediately when the name already carries records. 120 seconds
// is roughly five times that headroom.
const DEFAULT_PROPAGATION_TIMEOUT = 120000;
const DEFAULT_PROPAGATION_INTERVAL = 2000;

// A responding server that has nothing at the name is not an unreachable
// server, and the difference decides what the timeout message may claim.
const EMPTY_CODES = new Set(['ENOTFOUND', 'ENODATA']);

function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// acme.js sets both; keyAuthorizationDigest is the name it asks plugins to
// prefer, dnsAuthorization is marked deprecated but is what the test harness
// fills in.
function digestOf(challenge) {
	return challenge.keyAuthorizationDigest || challenge.dnsAuthorization;
}

// acme.js passes the challenge host as dnsHost. The test harness drops dnsHost
// when it calls get() and puts the host in identifier.value instead -- which in
// a real acme.js challenge holds the bare domain, so dnsHost has to win.
function hostOf(challenge) {
	const raw =
		challenge.dnsHost || (challenge.identifier && challenge.identifier.value) || '';
	return toAscii(stripWildcards(raw));
}

function longestSuffix(zones, host) {
	return zones
		.filter(zone => host === zone || host.endsWith(`.${zone}`))
		.sort((a, b) => b.length - a.length)[0];
}

function create(config) {
	const options = config || {};
	if (!options.token) {
		throw new Error('acme-dns-01-ednsde: the `token` option is required');
	}

	const api = createApiClient({
		token: options.token,
		endpoint: options.endpoint,
		fetch: options.fetch,
	});
	const dnsClient = options.resolver || createDnsClient({});

	const propagationTimeout = options.propagationTimeout || DEFAULT_PROPAGATION_TIMEOUT;
	const propagationInterval =
		options.propagationInterval || DEFAULT_PROPAGATION_INTERVAL;

	// An explicit list wins over the SOA walk, for setups where the walk cannot
	// see the truth. Normalised once here so comparisons are apples to apples.
	const configuredZones = (options.zones || []).map(zone =>
		toAscii(stripWildcards(zone)),
	);

	// Successful zone determinations only. The presenter lives for one run of a
	// scheduled adapter -- seconds to minutes -- in which a zone cut does not
	// move, so no invalidation is needed. Negative results are not cached: a
	// single DNS hiccup must not poison the rest of the run.
	const zoneOfHost = new Map();

	// Hosts and values whose removal the eDNS API has confirmed. See
	// docs/adr/0003 for why get() consults this before it consults DNS.
	const removed = new Set();

	function removalKey(host, digest) {
		return `${host}|${digest}`;
	}

	// Walks up from the host and stops at the first name that owns an SOA --
	// the zone cut. See docs/adr/0001.
	async function walkToZone(host) {
		const candidates = zoneCandidates(host);
		let lastError;
		for (const candidate of candidates) {
			try {
				if (await dnsClient.hasSoa(candidate)) {
					return candidate;
				}
			} catch (err) {
				lastError = err;
			}
		}
		throw new Error(
			`could not determine the DNS zone of "${host}": no name from "${candidates[0]}" up to "${candidates[candidates.length - 1]}" has an SOA record${lastError ? ` (last DNS error: ${lastError.message})` : ''}`,
		);
	}

	async function zoneFor(host, challenge) {
		if (configuredZones.length) {
			const zone = longestSuffix(configuredZones, host);
			if (!zone) {
				throw new Error(
					`none of the configured zones (${configuredZones.join(', ')}) covers "${host}"`,
				);
			}
			return zone;
		}

		// acme.js hands us the zone whenever our own zones() gave it one.
		const announced =
			challenge && challenge.dnsZone
				? toAscii(stripWildcards(challenge.dnsZone))
				: '';
		if (announced && (host === announced || host.endsWith(`.${announced}`))) {
			return announced;
		}

		if (zoneOfHost.has(host)) {
			return zoneOfHost.get(host);
		}
		const zone = await walkToZone(host);
		zoneOfHost.set(host, zone);
		return zone;
	}

	async function authoritativeServers(zone) {
		const names = await dnsClient.nameservers(zone);
		const addresses = await Promise.all(names.map(name => dnsClient.addresses(name)));
		const servers = [...new Set(addresses.flat())];
		if (!servers.length) {
			throw new Error(
				`no nameserver addresses could be resolved for the zone "${zone}"`,
			);
		}
		return servers;
	}

	async function pollOnce(servers, host) {
		return Promise.all(
			servers.map(async server => {
				try {
					return { server, values: await dnsClient.txtAt(server, host) };
				} catch (err) {
					if (err && EMPTY_CODES.has(err.code)) {
						return { server, values: [] };
					}
					return { server, error: err };
				}
			}),
		);
	}

	// Waits until the authoritative nameservers of the zone serve our digest.
	// Asking them directly is the only measurement no cache can spoil -- see
	// docs/adr/0002.
	//
	// An unreachable nameserver counts as "not ready yet" rather than as a
	// failure: for the first half of the budget every server must answer, after
	// that every server that *does* answer must carry the value. A permanently
	// dead nameserver therefore delays the run but does not doom it.
	async function waitForPropagation(zone, host, digest) {
		const servers = await authoritativeServers(zone);
		const start = Date.now();
		const lenientFrom = start + propagationTimeout / 2;
		const deadline = start + propagationTimeout;

		for (;;) {
			const results = await pollOnce(servers, host);
			const answering = results.filter(result => !result.error);
			const serving = answering.filter(result => result.values.includes(digest));

			if (answering.length && serving.length === answering.length) {
				if (answering.length === results.length || Date.now() >= lenientFrom) {
					return;
				}
			}

			if (Date.now() >= deadline) {
				const silent = results
					.filter(result => result.error)
					.map(result => result.server);
				throw new Error(
					`the challenge record for "${host}" was not served by all authoritative nameservers of "${zone}" within ${propagationTimeout / 1000}s (${serving.length} of ${results.length} serving it${silent.length ? `, no answer from ${silent.join(', ')}` : ''}). If this is the first issuance for this name, the likely cause is the zone's SOA minimum: a negative answer for a name that did not exist yet stays cached for that long. Check it with: dig +short SOA ${zone}`,
				);
			}

			await delay(propagationInterval);
		}
	}

	async function locate(challenge) {
		const host = hostOf(challenge);
		if (!host) {
			throw new Error('the challenge carries no DNS host');
		}
		const zone = await zoneFor(host, challenge);
		return { host, zone, ...splitHost(host, zone) };
	}

	const presenter = {
		// acme.js offers its own request helper here. We use the platform's
		// fetch instead, so there is nothing to take.
		init() {
			return null;
		},

		// acme.js asks as zones({ challenge: { dnsHosts } }), the test harness
		// as zones({ dnsHosts }). acme.js also prepends two random characters
		// to every host so that a plugin cannot pass the hosts off as zones.
		async zones(opts) {
			const input = opts || {};
			const hosts =
				input.dnsHosts || (input.challenge && input.challenge.dnsHosts) || [];
			if (configuredZones.length) {
				return [...configuredZones];
			}

			const found = new Set();
			for (const raw of hosts) {
				const host = toAscii(stripWildcards(raw));
				if (!host) {
					continue;
				}
				if (zoneOfHost.has(host)) {
					found.add(zoneOfHost.get(host));
					continue;
				}
				const zone = await walkToZone(host);
				zoneOfHost.set(host, zone);
				found.add(zone);
			}
			return [...found];
		},

		async set(data) {
			const challenge = data.challenge;
			const digest = digestOf(challenge);
			const { host, zone, domain, prefix } = await locate(challenge);

			await api.add(domain, prefix, digest);
			removed.delete(removalKey(host, digest));
			await waitForPropagation(zone, host, digest);
			return true;
		},

		// Returns the record only when an authoritative nameserver carries our
		// exact digest: a SAN certificate over example.com and *.example.com
		// puts two different values on one host, and returning the wrong one
		// would be worse than returning none.
		async get(data) {
			const challenge = data.challenge;
			const digest = digestOf(challenge);
			const host = hostOf(challenge);

			if (removed.has(removalKey(host, digest))) {
				return null;
			}

			const zone = await zoneFor(host, challenge);
			const results = await pollOnce(await authoritativeServers(zone), host);
			const present = results.some(
				result => !result.error && result.values.includes(digest),
			);
			return present
				? { dnsAuthorization: digest, keyAuthorizationDigest: digest }
				: null;
		},

		// Never throws when the record is already gone. acme.js calls remove()
		// during cleanup, including after a challenge that failed earlier, and
		// an exception here would bury the real cause.
		async remove(data) {
			const challenge = data.challenge;
			const digest = digestOf(challenge);
			const { host, domain, prefix } = await locate(challenge);

			await api.remove(domain, prefix, digest);
			removed.add(removalKey(host, digest));
			return true;
		},
	};

	// set() has already confirmed the record on every authoritative nameserver,
	// so acme.js' own pre-flight over the system resolver has nothing left to
	// add -- and would be exposed to negative caching. Adapters that predate
	// this hook ignore both properties; see docs/adr/0002.
	presenter.propagationDelay = 0;
	presenter.skipChallengeTest = true;

	return presenter;
}

module.exports = { create };
