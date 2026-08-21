#!/usr/bin/env node
'use strict';

// Brings the installed @root/acme up to 3.1.1, which npm does not have. See
// patches/README.md for what the patch is and why it lives here rather than in
// package.json.
//
// Idempotent: running it twice is fine, and it refuses rather than guesses if
// it finds a version it was not written against.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PATCH = path.join('patches', 'root-acme-3.1.1.diff');
const TARGET = path.join('node_modules', '@root', 'acme', 'acme.js');
const EXPECTED_VERSION = '3.1.0';
// A marker the patch introduces and 3.1.0 does not have anywhere. Its presence
// means the work is already done. ('order._orderUrl' would be wrong: 3.1.0
// already sets that property, it just never polls it.)
const MARKER = 'function finalizeOrder';

function fail(message) {
	console.error(`acme:fixed: ${message}`);
	process.exit(1);
}

if (!fs.existsSync(TARGET)) {
	fail(`${TARGET} is missing — run npm install first`);
}

if (fs.readFileSync(TARGET, 'utf8').includes(MARKER)) {
	console.log('@root/acme is already at 3.1.1 behaviour; nothing to do');
	process.exit(0);
}

const installed = require(
	path.resolve('node_modules', '@root', 'acme', 'package.json'),
).version;
if (installed !== EXPECTED_VERSION) {
	fail(
		`the patch was written against @root/acme ${EXPECTED_VERSION}, found ${installed}. Check patches/README.md before touching this.`,
	);
}

try {
	execFileSync('git', ['apply', '--verbose', PATCH], { stdio: 'inherit' });
} catch {
	fail(`could not apply ${PATCH}`);
}

if (!fs.readFileSync(TARGET, 'utf8').includes(MARKER)) {
	fail('the patch applied but the expected change is not there');
}

// The patched acme.js is byte-identical to upstream v3.1.1, and upstream's own
// 3.1.1 release is that file plus this version bump. Leaving the manifest at
// 3.1.0 would make `npm ls` report a version whose behaviour is not installed,
// which is exactly the kind of thing that costs somebody an afternoon.
const manifestPath = path.join('node_modules', '@root', 'acme', 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.version = '3.1.1';
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`@root/acme ${installed} patched to upstream 3.1.1 (polls with POST-as-GET)`);
