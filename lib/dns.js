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
		// Resolves only when `name` is a zone apex: c-ares reads the answer
		// section, and a zone's SOA appears there for the apex alone. For any
		// other name the SOA comes back in the authority section instead, and
		// this rejects -- which is exactly the signal the walk needs.
		async hasSoa(name) {
			try {
				await system.resolveSoa(name);
				return true;
			} catch (err) {
				if (err && (err.code === 'ENOTFOUND' || err.code === 'ENODATA')) {
					return false;
				}
				throw err;
			}
		},

		async nameservers(zone) {
			return system.resolveNs(zone);
		},

		async addresses(name) {
			const [v4, v6] = await Promise.all([
				system.resolve4(name).catch(() => []),
				system.resolve6(name).catch(() => []),
			]);
			return [...v4, ...v6];
		},

		// TXT values at `name` as flat strings, asked of one specific server.
		// resolveTxt hands back an array of chunk arrays; a value split across
		// chunks has to be rejoined before it can be compared to a digest.
		async txtAt(server, name) {
			const records = await resolverFor([server]).resolveTxt(name);
			return records.map(chunks => chunks.join(''));
		},
	};
}

module.exports = { createDnsClient };
