'use strict';

const http = require('node:http');

// A stand-in for the eDNS challenge API. `handler` is called with the parsed
// request body and the 1-based attempt number and returns { status, body },
// which lets a test script a 429-then-200 sequence as easily as a flat 401.
async function startStubApi(handler) {
	const requests = [];

	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on('data', chunk => chunks.push(chunk));
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8');
			let body;
			try {
				body = JSON.parse(raw);
			} catch {
				body = raw;
			}
			requests.push({ method: req.method, headers: req.headers, body });

			const out = handler(body, requests.length);
			res.writeHead(out.status, { 'content-type': 'application/json' });
			res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
		});
	});

	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

	return {
		endpoint: `http://127.0.0.1:${server.address().port}`,
		requests,
		close: () => new Promise(resolve => server.close(resolve)),
	};
}

// The shape of a successful eDNS response: status and message in the envelope,
// the interesting part in `data`.
function ok(action, resultCode, result) {
	return {
		status: 200,
		body: {
			status: 200,
			message: 'OK',
			data: { action, result: result || 'ok', result_code: resultCode },
		},
	};
}

// On every error the API answers with `data` as an empty array.
function fail(status, message) {
	return { status, body: { status, message, data: [] } };
}

module.exports = { startStubApi, ok, fail };
