#!/usr/bin/env node
'use strict';

// Measures how long a challenge record takes to become visible on each
// authoritative nameserver of a zone, by asking those nameservers directly.
//
// It exists because the numbers in the README have to come from somewhere, and
// because "the record never showed up" is a claim worth being able to check
// rather than argue about. It writes to a real zone and always removes what it
// created.
//
//   EDNS_TOKEN=... node scripts/measure-propagation.js winkler.tel
//   EDNS_TOKEN=... node scripts/measure-propagation.js winkler.tel _probe.foo
//
// The second argument is the prefix to test, which is the interesting knob: a
// prefix with two labels exercises a different path in the API than one with a
// single label.

const crypto = require('node:crypto');

const { createApiClient } = require('../lib/api');
const { createDnsClient } = require('../lib/dns');
const { toAscii } = require('../lib/names');

const POLL_INTERVAL = 2000;
const APPEAR_BUDGET = 180000;
// Removal takes about the record TTL, which is longer than a CI job should sit
// idle. We watch a short while and report what we saw rather than waiting it out.
const DISAPPEAR_BUDGET = 60000;

function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function stamp(started) {
	return `${String(Math.round((Date.now() - started) / 100) / 10).padStart(6)}s`;
}

async function serversOf(dns, zone) {
	const names = await dns.nameservers(zone);
	const out = [];
	for (const name of names) {
		for (const address of await dns.addresses(name)) {
			out.push({ name, address });
		}
	}
	return out;
}

// Polls every server until all of them agree with `wanted`, or the budget runs
// out. Reports the moment each one first flips.
async function watch(dns, servers, host, value, wanted, budget, started) {
	const flipped = new Map();
	const deadline = Date.now() + budget;

	while (flipped.size < servers.length && Date.now() < deadline) {
		await Promise.all(
			servers.map(async server => {
				if (flipped.has(server.address)) {
					return;
				}
				let present = false;
				let note = '';
				try {
					present = (await dns.txtAt(server.address, host)).includes(value);
				} catch (err) {
					if (!['ENOTFOUND', 'ENODATA'].includes(err.code)) {
						note = ` (${err.code})`;
					}
				}
				if (present === wanted) {
					flipped.set(server.address, Date.now() - started);
					console.log(
						`  ${stamp(started)}  ${wanted ? 'visible on' : 'gone from'} ${server.name} ${server.address}${note}`,
					);
				}
			}),
		);
		if (flipped.size < servers.length) {
			await delay(POLL_INTERVAL);
		}
	}

	for (const server of servers) {
		if (!flipped.has(server.address)) {
			console.log(
				`  ${stamp(started)}  NOT ${wanted ? 'visible on' : 'gone from'} ${server.name} ${server.address} — gave up`,
			);
		}
	}
	return flipped.size === servers.length;
}

async function main() {
	const zone = toAscii(process.argv[2] || process.env.EDNS_TEST_ZONE || '');
	const prefix = process.argv[3] || `_measure-${crypto.randomBytes(2).toString('hex')}`;
	const token = process.env.EDNS_TOKEN;

	if (!zone) {
		console.error(
			'Usage: EDNS_TOKEN=... node scripts/measure-propagation.js <zone> [prefix]',
		);
		process.exit(2);
	}
	if (!token) {
		console.error('The EDNS_TOKEN environment variable is not set.');
		process.exit(2);
	}

	const value = crypto.randomBytes(32).toString('base64url');
	const host = `${prefix}.${zone}`;
	const api = createApiClient({ token });
	const dns = createDnsClient({});

	const servers = await serversOf(dns, zone);
	console.log(`zone        ${zone}`);
	console.log(`prefix      ${prefix}  (${prefix.split('.').length} label(s))`);
	console.log(`host        ${host}`);
	console.log(`value       ${value} (${value.length} chars)`);
	console.log(`nameservers ${servers.map(s => `${s.name}=${s.address}`).join(', ')}`);
	console.log('');

	let created = false;
	try {
		const started = Date.now();
		await api.add(zone, prefix, value);
		created = true;
		console.log(`  ${stamp(started)}  addChallengeRecord accepted`);

		const appeared = await watch(
			dns,
			servers,
			host,
			value,
			true,
			APPEAR_BUDGET,
			started,
		);
		console.log('');
		console.log(
			appeared
				? 'RESULT appeared on all nameservers'
				: 'RESULT did NOT appear everywhere',
		);

		const removeStarted = Date.now();
		await api.remove(zone, prefix, value);
		created = false;
		console.log('');
		console.log(`  ${stamp(removeStarted)}  removeChallengeRecord accepted`);
		const gone = await watch(
			dns,
			servers,
			host,
			value,
			false,
			DISAPPEAR_BUDGET,
			removeStarted,
		);
		console.log('');
		console.log(
			gone
				? 'RESULT disappeared from all nameservers'
				: `RESULT still served after ${DISAPPEAR_BUDGET / 1000}s (expected: removal takes about the record TTL)`,
		);

		process.exitCode = appeared ? 0 : 1;
	} finally {
		if (created) {
			console.log('cleaning up the record this run created');
			await api.remove(zone, prefix, value).catch(err => {
				console.error(`could not clean up ${host}: ${err.message}`);
				console.error(`remove it by hand, value: ${value}`);
			});
		}
	}
}

main().catch(err => {
	console.error(err.message);
	process.exit(1);
});
