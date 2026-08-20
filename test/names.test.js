'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { toAscii, stripWildcards, zoneCandidates, splitHost } = require('../lib/names');

test('toAscii converts IDN to A-labels', () => {
	assert.equal(toAscii('你好.example.com'), 'xn--6qq79v.example.com');
});

test('toAscii lowercases and drops a trailing dot', () => {
	assert.equal(toAscii('Example.COM.'), 'example.com');
});

test('toAscii leaves the underscore and wildcard labels of challenge names alone', () => {
	assert.equal(
		toAscii('_acme-challenge.Foo.example.com'),
		'_acme-challenge.foo.example.com',
	);
	assert.equal(toAscii('*.example.com'), '*.example.com');
});

test('toAscii tolerates empty input', () => {
	assert.equal(toAscii(''), '');
	assert.equal(toAscii(null), '');
	assert.equal(toAscii(undefined), '');
});

test('stripWildcards removes wildcard labels wherever they sit', () => {
	assert.equal(stripWildcards('*.example.com'), 'example.com');
	assert.equal(stripWildcards('ab.*.example.com'), 'ab.example.com');
	assert.equal(stripWildcards('*.foo.example.com'), 'foo.example.com');
});

test('zoneCandidates lists suffixes longest first and leaves out the TLD', () => {
	assert.deepEqual(zoneCandidates('_acme-challenge.foo.example.com'), [
		'_acme-challenge.foo.example.com',
		'foo.example.com',
		'example.com',
	]);
});

test('zoneCandidates keeps a two-label name as its own candidate', () => {
	assert.deepEqual(zoneCandidates('example.com'), ['example.com']);
});

test('splitHost yields an empty prefix on the zone apex', () => {
	assert.deepEqual(splitHost('example.com', 'example.com'), {
		domain: 'example.com',
		prefix: '',
	});
});

test('splitHost separates prefix from zone', () => {
	assert.deepEqual(splitHost('_acme-challenge.foo.example.com', 'example.com'), {
		domain: 'example.com',
		prefix: '_acme-challenge.foo',
	});
});

test('splitHost rejects a zone that is not a suffix of the host', () => {
	assert.throws(
		() => splitHost('_acme-challenge.example.org', 'example.com'),
		/is not a suffix of/,
	);
});

test('splitHost does not treat a shared tail as a suffix', () => {
	// "notexample.com" ends with "example.com" as a string but not as a zone.
	assert.throws(() => splitHost('notexample.com', 'example.com'), /is not a suffix of/);
});
