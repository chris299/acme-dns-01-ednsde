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
//   EDNS_TOKEN=... node scripts/measure-propagation.js winkler.tel _probe _probe.foo
//
// Every argument after the zone is a prefix to test. They are added one after
// another and all kept alive until the end, which is what makes more than one
// interesting: the ACME test harness reuses the same leftmost label across the
// names of one certificate, so a second record can meet a first one that is
// still in place.

const crypto = require('node:crypto');

const { createApiClient } = require('../lib/api');
const { createDnsClient } = require('../lib/dns');
const { toAscii } = require('../lib/names');

const POLL_INTERVAL = 2000;
const APPEAR_BUDGET = Number(process.env.MEASURE_APPEAR_BUDGET || 180000);
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
	const prefixes = process.argv.slice(3);
	if (!prefixes.length) {
		prefixes.push(`_measure-${crypto.randomBytes(2).toString('hex')}`);
	}
	const token = process.env.EDNS_TOKEN;

	if (!zone) {
		console.error(
			'Usage: EDNS_TOKEN=... node scripts/measure-propagation.js <zone> [prefix...]',
		);
		process.exit(2);
	}
	if (!token) {
		console.error('The EDNS_TOKEN environment variable is not set.');
		process.exit(2);
	}

	const api = createApiClient({ token });
	const dns = createDnsClient({});
	const servers = await serversOf(dns, zone);

	console.log(`zone        ${zone}`);
	console.log(`nameservers ${servers.map(s => `${s.name}=${s.address}`).join(', ')}`);

	const created = [];
	let allAppeared = true;

	try {
		for (const prefix of prefixes) {
			const value = crypto.randomBytes(32).toString('base64url');
			const host = `${prefix}.${zone}`;
			console.log('');
			console.log(`── ${host}  (${prefix.split('.').length} label prefix)`);
			console.log(`   value ${value}`);

			const started = Date.now();
			await api.add(zone, prefix, value);
			created.push({ prefix, value, host });
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
			allAppeared = allAppeared && appeared;
			console.log(
				appeared
					? `  RESULT ${host} appeared on all nameservers`
					: `  RESULT ${host} did NOT appear everywhere`,
			);
		}

		console.log('');
		console.log(
			allAppeared
				? 'RESULT all prefixes appeared'
				: 'RESULT at least one prefix never appeared',
		);
		process.exitCode = allAppeared ? 0 : 1;
	} finally {
		for (const record of created) {
			const removeStarted = Date.now();
			const gone = await api
				.remove(zone, record.prefix, record.value)
				.then(() => true)
				.catch(err => {
					console.error(`could not remove ${record.host}: ${err.message}`);
					console.error(`remove it by hand, value: ${record.value}`);
					return false;
				});
			if (gone) {
				console.log(`  ${stamp(removeStarted)}  removed ${record.host}`);
			}
		}
		console.log(
			`removal takes about the record TTL to leave DNS; ${DISAPPEAR_BUDGET / 1000}s of watching is not enough to see it, so this run does not wait.`,
		);
	}
}

main().catch(err => {
	console.error(err.message);
	process.exit(1);
});
