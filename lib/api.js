'use strict';

// The production eDNS challenge API.
const DEFAULT_ENDPOINT = 'https://dns-challenge.edns.de';

// The only two actions the API understands.
const ACTION_ADD = 'addChallengeRecord';
const ACTION_REMOVE = 'removeChallengeRecord';

// Result codes reported in data.result_code on an HTTP 200 response.
const RESULT_ADDED = 1; // a new challenge record was created
const RESULT_ALREADY_EXISTS = 2; // an identical call was made before
const RESULT_REMOVED = 3; // the challenge record was deleted
const RESULT_ALREADY_REMOVED = 4; // already gone from DNS; only the marker was cleared
const RESULT_NOT_FOUND = 5; // no API-created record with this value exists

// Bounds the API enforces with a 400. Checked up front so the caller gets a
// useful message instead. An ACME digest is 43 characters and always fits.
const MIN_VALUE_LENGTH = 10;
const MAX_VALUE_LENGTH = 64;

// Retry budget for transient failures, kept well under a second in total.
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF = 200;

class ApiError extends Error {
	constructor(statusCode, message, hint) {
		super(`edns api: HTTP ${statusCode}: ${message}${hint ? ` -- ${hint}` : ''}`);
		this.name = 'ApiError';
		this.statusCode = statusCode;
		this.apiMessage = message;
		this.hint = hint;
	}
}

// Advice the API itself does not give. The 401 case matters most: an invalid
// token and a token that is merely not assigned to the zone are
// indistinguishable in the response.
function hintFor(status) {
	if (status === 401) {
		return "the access token must be valid and assigned to this zone on the zone's DNS-01-Challenge tab in the eDNS web interface";
	}
	if (status === 400) {
		return 'this is a malformed request and will not succeed on retry';
	}
	return '';
}

function retryableStatus(status) {
	return status === 429 || status >= 500;
}

function validateValue(value) {
	if (
		typeof value !== 'string' ||
		value.length < MIN_VALUE_LENGTH ||
		value.length > MAX_VALUE_LENGTH
	) {
		throw new Error(
			`challenge value must be between ${MIN_VALUE_LENGTH} and ${MAX_VALUE_LENGTH} characters, got ${
				typeof value === 'string' ? value.length : typeof value
			}`,
		);
	}
	if (/\s/.test(value)) {
		throw new Error('challenge value must not contain whitespace');
	}
}

function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function createApiClient(options) {
	const token = options.token;
	const endpoint = String(options.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
	const fetchImpl = options.fetch || globalThis.fetch;

	// One API call, retrying transient failures. Subdomain is omitted for
	// records on the zone apex: sending it as an empty string is answered
	// with a 400.
	async function call(action, domain, prefix, value) {
		validateValue(value);

		const body = JSON.stringify(
			prefix
				? { action, domain, subdomain: prefix, challenge_token: value }
				: { action, domain, challenge_token: value },
		);

		let lastError;
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
			if (attempt > 1) {
				await delay((attempt - 1) * RETRY_BACKOFF);
			}

			let response;
			try {
				response = await fetchImpl(endpoint, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'X-API-TOKEN': token },
					body,
				});
			} catch (err) {
				lastError = new Error(`calling the eDNS challenge API: ${err.message}`);
				continue;
			}

			const text = await response.text();
			let envelope;
			try {
				envelope = JSON.parse(text);
			} catch {
				lastError = new Error(
					`decoding the response (HTTP ${response.status}): not JSON`,
				);
				if (!retryableStatus(response.status)) {
					throw lastError;
				}
				continue;
			}

			if (response.status !== 200) {
				const err = new ApiError(
					response.status,
					envelope.message,
					hintFor(response.status),
				);
				if (!retryableStatus(response.status)) {
					throw err;
				}
				lastError = err;
				continue;
			}

			return envelope.data;
		}
		throw lastError;
	}

	return {
		// Returns true when the zone ended up as requested.
		async add(domain, prefix, value) {
			const data = await call(ACTION_ADD, domain, prefix, value);
			if (
				data.result_code === RESULT_ADDED ||
				data.result_code === RESULT_ALREADY_EXISTS
			) {
				return true;
			}
			throw new Error(
				`edns api: unexpected result_code ${data.result_code} ("${data.result}") for ${ACTION_ADD}`,
			);
		},

		// Returns true when the record was deleted, false when there was
		// nothing to delete. Not finding it is not an error: removal runs in
		// cleanup, including after a challenge that never got that far.
		async remove(domain, prefix, value) {
			const data = await call(ACTION_REMOVE, domain, prefix, value);
			if (
				data.result_code === RESULT_REMOVED ||
				data.result_code === RESULT_ALREADY_REMOVED
			) {
				return true;
			}
			if (data.result_code === RESULT_NOT_FOUND) {
				return false;
			}
			throw new Error(
				`edns api: unexpected result_code ${data.result_code} ("${data.result}") for ${ACTION_REMOVE}`,
			);
		},
	};
}

module.exports = {
	createApiClient,
	ApiError,
	DEFAULT_ENDPOINT,
	MIN_VALUE_LENGTH,
	MAX_VALUE_LENGTH,
};
