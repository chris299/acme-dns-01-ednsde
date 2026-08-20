'use strict';

const dns = require('node:dns');

// Everything this package needs from DNS, as four operations. It exists as its
// own port so the tests can replace it wholesale: the SOA walk and the
// propagation poll are the parts most worth testing and the parts that would
// otherwise need a network.
//
// Pass a replacement as the `resolver` option of create(). It is deliberately
// undocumented in the README -- it is a test seam, not configuration.
function createDnsClient(options) {
	const timeout = (options && options.timeout) || 5000;

	function resolverFor(servers) {
		const resolver = new dns.promises.Resolver({ timeout, tries: 2 });
		if (servers && servers.length) {
			resolver.setServers(servers);
		}
		return resolver;
	}

	const system = resolverFor(null);

	return {
		// The SOA record of `name`, or null when `name` is not a zone apex:
		// c-ares reads the answer section, and a zone's SOA appears there for
		// the apex alone. For any other name the SOA comes back in the
		// authority section instead, which is exactly the signal the zone walk
		// needs. The record's `minttl` is how long this zone's negative answers
		// are cached, which the propagation fallback has to respect.
		async soa(name) {
			try {
				return await system.resolveSoa(name);
			} catch (err) {
				if (err && (err.code === 'ENOTFOUND' || err.code === 'ENODATA')) {
					return null;
				}
				throw err;
			}
		},

		async nameservers(zone) {
			return system.resolveNs(zone);
		},

		// One address per nameserver, IPv4 preferred. A nameserver reachable
		// over two address families is still one nameserver: counting it twice
		// would inflate the quorum the propagation check waits for, and on a
		// host without IPv6 routing the second entry can never answer.
		async addresses(name) {
			const v4 = await system.resolve4(name).catch(() => []);
			if (v4.length) {
				return [v4[0]];
			}
			const v6 = await system.resolve6(name).catch(() => []);
			return v6.length ? [v6[0]] : [];
		},

		// TXT values at `name` as flat strings, asked of one specific server.
		// resolveTxt hands back an array of chunk arrays; a value split across
		// chunks has to be rejoined before it can be compared to a digest.
		async txtAt(server, name) {
			const records = await resolverFor([server]).resolveTxt(name);
			return records.map(chunks => chunks.join(''));
		},

		// The same question put to whatever resolver the host is configured to
		// use. Needed where talking to nameservers directly is not permitted.
		async txtSystem(name) {
			const records = await system.resolveTxt(name);
			return records.map(chunks => chunks.join(''));
		},
	};
}

module.exports = { createDnsClient };
