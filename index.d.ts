/**
 * eDNS.de DNS-01 challenge plugin for ACME.js and Greenlock.js.
 */

/** The challenge object ACME.js hands to the plugin. */
export interface Dns01Challenge {
	type: 'dns-01';
	identifier: { type: 'dns'; value: string };
	wildcard?: boolean;
	/** Full name of the challenge record, e.g. `_acme-challenge.foo.example.com`. */
	dnsHost?: string;
	/** Zone, when ACME.js could derive one from `zones()`. */
	dnsZone?: string;
	/** Part of `dnsHost` left of the zone. */
	dnsPrefix?: string;
	/** url-safe base64 SHA-256 over the key authorization. */
	keyAuthorizationDigest?: string;
	/** Deprecated name of `keyAuthorizationDigest`, still filled in by ACME.js. */
	dnsAuthorization?: string;
	[key: string]: unknown;
}

export interface Options {
	/**
	 * eDNS access token, sent as the `X-API-TOKEN` header. It must be assigned
	 * to every zone it is used for, on that zone's DNS-01-Challenge tab.
	 */
	token: string;

	/**
	 * Zones to use instead of determining the zone cut over DNS. Only needed
	 * where the SOA lookup cannot see the truth.
	 */
	zones?: string[];

	/** How long to wait for a record to reach every authoritative nameserver. Default 120000. */
	propagationTimeout?: number;

	/** How long between propagation checks. Default 2000. */
	propagationInterval?: number;

	/**
	 * Where to report progress. Waiting for DNS takes minutes, and without this
	 * the plugin says nothing at all, which is hard to tell from a hang. Silent
	 * when omitted: nothing is ever written to stdout uninvited.
	 */
	log?: (message: string) => void;
}

export interface Presenter {
	init(opts?: unknown): null;
	zones(opts?: {
		dnsHosts?: string[];
		challenge?: { dnsHosts?: string[] };
	}): Promise<string[]>;
	set(data: { challenge: Dns01Challenge }): Promise<true>;
	get(data: {
		challenge: Dns01Challenge;
	}): Promise<{ dnsAuthorization: string; keyAuthorizationDigest: string } | null>;
	remove(data: { challenge: Dns01Challenge }): Promise<true>;

	/** Always 0: `set()` confirms propagation itself. */
	propagationDelay: number;
	/** Always true: ACME.js' own pre-flight over the system resolver adds nothing. */
	skipChallengeTest: boolean;
}

export function create(options: Options): Presenter;
