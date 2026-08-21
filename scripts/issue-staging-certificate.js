#!/usr/bin/env node
'use strict';

// Issues a real certificate from Let's Encrypt's staging environment, using
// this plugin for the dns-01 challenges.
//
// The compliance harness proves the plugin sets, reads and removes TXT records.
// It does not prove a certificate comes out: it never talks to a CA, computes
// its own fake key authorizations, and never has Let's Encrypt look up anything.
// This script closes that gap, and it deliberately mirrors how ioBroker.acme
// drives acme.js -- same account creation, same CSR construction, same
// skipChallengeTest handling -- so that a pass here says something about the
// real consumer rather than about this script.
//
//   EDNS_TOKEN=... ACME_EMAIL=you@example.com \
//     node scripts/issue-staging-certificate.js winkler.tel '*.winkler.tel'
//
// Requesting both the apex and its wildcard is the point, not a flourish: both
// challenges live at the same _acme-challenge name with different values, which
// is the case that made the plugin wait out eDNS's 300s record cache.

const { X509Certificate } = require('node:crypto');

const ACME = require('acme');
const Keypairs = require('@root/keypairs');
const CSR = require('@root/csr');
const PEM = require('@root/pem');

const pkg = require('../package.json');

const STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';

function notify(event, message) {
	if (event === 'error' || event === 'warning') {
		console.warn(`  acme ${event}: ${JSON.stringify(message)}`);
	}
}

async function main() {
	const domains = process.argv.slice(2);
	const email = process.env.ACME_EMAIL;
	const token = process.env.EDNS_TOKEN;
	const directoryUrl = process.env.ACME_DIRECTORY_URL || STAGING;

	if (!domains.length) {
		console.error(
			"Usage: EDNS_TOKEN=... ACME_EMAIL=you@example.com node scripts/issue-staging-certificate.js <domain> ['*.domain']",
		);
		process.exit(2);
	}
	if (!token) {
		console.error('The EDNS_TOKEN environment variable is not set.');
		process.exit(2);
	}
	// The address becomes the ACME account contact, so it goes to the CA. It is
	// never defaulted or guessed.
	if (!email) {
		console.error('The ACME_EMAIL environment variable is not set.');
		process.exit(2);
	}
	if (
		!/acme-staging/.test(directoryUrl) &&
		process.env.ACME_ALLOW_PRODUCTION !== 'yes'
	) {
		console.error(
			`Refusing to use ${directoryUrl}: it is not the staging directory. Set ACME_ALLOW_PRODUCTION=yes if that is really the intent.`,
		);
		process.exit(2);
	}

	console.log(`directory  ${directoryUrl}`);
	console.log(`domains    ${domains.join(', ')}`);

	const dns01 = require('../index.js').create({ token });

	const acme = ACME.create({
		maintainerEmail: email,
		packageAgent: `${pkg.name}/${pkg.version}`,
		notify,
		debug: false,
	});

	// init() first, so acme.js knows which challenge types it can check, then
	// skipChallengeTest -- the order ioBroker.acme uses, and it matters.
	await acme.init(directoryUrl);
	if (dns01.skipChallengeTest) {
		acme.skipChallengeTest = true;
		console.log('skipChallengeTest  true (the plugin verifies propagation itself)');
	}

	console.log('\nregistering a fresh ACME account');
	const accountKeypair = await Keypairs.generate({ kty: 'EC', format: 'jwk' });
	const accountKey = accountKeypair.private;
	const account = await acme.accounts.create({
		subscriberEmail: email,
		agreeToTerms: true,
		accountKey,
	});
	console.log(`  account status ${account.status}`);

	console.log('building the CSR');
	const serverKeypair = await Keypairs.generate({ kty: 'RSA', format: 'jwk' });
	const serverPem = await Keypairs.export({ jwk: serverKeypair.private });
	const serverKey = await Keypairs.import({ pem: serverPem });
	const csr = PEM.packBlock({
		type: 'CERTIFICATE REQUEST',
		bytes: await CSR.csr({ jwk: serverKey, domains, encoding: 'der' }),
	});

	console.log('\nrequesting the certificate — the dns-01 challenges run now');
	console.log('  (a second value on one _acme-challenge name waits out a 300s cache)');
	const started = Date.now();
	const pems = await acme.certificates.create({
		account,
		accountKey,
		csr,
		domains,
		challenges: { 'dns-01': dns01 },
	});
	const elapsed = Math.round((Date.now() - started) / 1000);

	if (!pems || !pems.cert) {
		throw new Error('no certificate came back');
	}

	const cert = new X509Certificate(pems.cert);
	const names = (cert.subjectAltName || '')
		.split(',')
		.map(entry => entry.trim().replace(/^DNS:/, ''))
		.filter(Boolean);

	console.log(`\ncertificate issued in ${elapsed}s`);
	console.log(`  subject   ${cert.subject.replace(/\n/g, ' ')}`);
	console.log(`  issuer    ${cert.issuer.replace(/\n/g, ' ')}`);
	console.log(`  valid to  ${cert.validTo}`);
	console.log(`  names     ${names.join(', ')}`);
	console.log(`  chain     ${pems.chain ? `${pems.chain.length} bytes` : 'missing'}`);

	const missing = domains.filter(domain => !names.includes(domain));
	if (missing.length) {
		throw new Error(`the certificate does not cover ${missing.join(', ')}`);
	}
	// A staging certificate signed by the real roots would mean the wrong
	// directory was used, and nobody wants to find that out later.
	if (!/STAGING/i.test(cert.issuer)) {
		throw new Error(`unexpected issuer for a staging run: ${cert.issuer}`);
	}

	console.log('\nPASS every requested name is covered, by the staging CA');
}

main().catch(err => {
	console.error(`\nFAIL ${err.message}`);
	if (err.stack) {
		console.error(err.stack);
	}
	process.exit(1);
});
