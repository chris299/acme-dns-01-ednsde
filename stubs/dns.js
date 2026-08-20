'use strict';

function dnsError(code) {
	const err = new Error(`stub dns: ${code}`);
	err.code = code;
	return err;
}

// A stand-in for lib/dns.js. `spec.txt` is keyed by "<server>|<host>" and may
// hold an array of values, an Error to throw, or a function called with the
// 1-based query count -- which is how a test makes a record appear only after
// a few rounds of polling.
function createStubDns(spec) {
	const soa = new Set(spec.soa || []);
	const soaMinimum = spec.soaMinimum ?? 300;
	const ns = spec.ns || {};
	const addresses = spec.addresses || {};
	const txt = spec.txt || {};
	const calls = { soa: [], nameservers: [], txtAt: [] };
	const txtCounts = new Map();

	return {
		calls,

		async soa(name) {
			calls.soa.push(name);
			return soa.has(name) ? { nsname: `ns.${name}`, minttl: soaMinimum } : null;
		},

		async nameservers(zone) {
			calls.nameservers.push(zone);
			if (!ns[zone]) {
				throw dnsError('ENOTFOUND');
			}
			return ns[zone];
		},

		async addresses(name) {
			return addresses[name] || [];
		},

		// Keyed by "system|<host>", so a test can let the configured resolver
		// see something the nameservers refuse to answer for.
		async txtSystem(host) {
			const key = `system|${host}`;
			calls.txtAt.push(key);
			const count = (txtCounts.get(key) || 0) + 1;
			txtCounts.set(key, count);

			let value = txt[key];
			if (typeof value === 'function') {
				value = value(count);
			}
			if (value instanceof Error) {
				throw value;
			}
			if (!value) {
				throw dnsError('ENOTFOUND');
			}
			return value;
		},

		async txtAt(server, host) {
			calls.txtAt.push(`${server}|${host}`);
			const key = `${server}|${host}`;
			const count = (txtCounts.get(key) || 0) + 1;
			txtCounts.set(key, count);

			let value = txt[key];
			if (typeof value === 'function') {
				value = value(count);
			}
			if (value instanceof Error) {
				throw value;
			}
			if (!value) {
				throw dnsError('ENOTFOUND');
			}
			return value;
		},
	};
}

module.exports = { createStubDns, dnsError };
