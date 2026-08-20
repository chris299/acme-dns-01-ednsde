#!/usr/bin/env node
'use strict';

// Runs the acme-dns-01 compliance harness against a real eDNS zone. This
// authenticates with a real access token and creates records in a real,
// production zone -- there is no separate test zone -- so it is never part of
// the push test run. See .github/workflows/integration.yml.
//
//   EDNS_TOKEN=... node test-integration.js winkler.tel

const tester = require('acme-dns-01-test');

const zone = process.argv[2] || process.env.EDNS_TEST_ZONE;
const token = process.env.EDNS_TOKEN;

if (!zone) {
	console.error('Usage: EDNS_TOKEN=... node test-integration.js <zone>');
	process.exit(2);
}
if (!token) {
	console.error('The EDNS_TOKEN environment variable is not set.');
	process.exit(2);
}

const challenger = require('./index.js').create({ token });

// testZone exercises three names -- the apex, a subdomain, and a wildcard over
// that subdomain. The last two share one challenge host with two different
// digests, which is the SAN case the plugin has to get right.
tester
	.testZone('dns-01', zone, challenger)
	.then(() => {
		console.info('PASS', zone);
	})
	.catch(err => {
		console.error(err.message);
		console.error(err.stack);
		process.exit(1);
	});
