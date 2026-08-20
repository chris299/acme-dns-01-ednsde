'use strict';

const { domainToASCII } = require('node:url');

// The eDNS challenge API, and every DNS query we make, need A-labels. Unicode
// domains arrive straight from user configuration -- ioBroker's own example
// config uses one -- so normalising here is not a theoretical nicety.
// domainToASCII lowercases, converts IDN, and leaves the '*' and '_' labels
// that challenge names are made of untouched.
function toAscii(name) {
	const trimmed = String(name ?? '')
		.trim()
		.replace(/\.+$/, '');
	if (!trimmed) {
		return '';
	}
	return domainToASCII(trimmed) || trimmed.toLowerCase();
}

// Wildcard identifiers reach zones() as 'ab.*.example.com' and, from the test
// harness, as '*.foo.example.com'. A '*' is never part of a zone name, and the
// TXT record for a wildcard lives at the same host as the bare domain's.
function stripWildcards(name) {
	return name
		.split('.')
		.filter(label => label !== '*')
		.join('.');
}

// Zone candidates for a host, longest first. The single-label TLD is left out
// deliberately: 'com' and 'co.uk' do have SOA records, and returning one of
// them as the zone would be worse than failing.
function zoneCandidates(host) {
	const labels = host.split('.').filter(Boolean);
	const out = [];
	for (let i = 0; i <= labels.length - 2; i += 1) {
		out.push(labels.slice(i).join('.'));
	}
	return out;
}

// Splits a host into what the eDNS API calls domain and subdomain. A host that
// *is* the zone apex yields an empty prefix, which the caller must then omit
// from the request rather than send as an empty string.
function splitHost(host, zone) {
	if (host === zone) {
		return { domain: zone, prefix: '' };
	}
	if (!host.endsWith(`.${zone}`)) {
		throw new Error(
			`the zone "${zone}" is not a suffix of the challenge host "${host}"`,
		);
	}
	return { domain: zone, prefix: host.slice(0, -(zone.length + 1)) };
}

module.exports = { toAscii, stripWildcards, zoneCandidates, splitHost };
