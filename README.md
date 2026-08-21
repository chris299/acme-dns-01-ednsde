# acme-dns-01-ednsde

A DNS-01 challenge plugin for [ACME.js](https://git.rootprojects.org/root/acme.js),
[Greenlock.js](https://git.rootprojects.org/root/greenlock.js) and the
[ioBroker ACME adapter](https://github.com/iobroker-community-adapters/ioBroker.acme), for zones
hosted at [edns.de](https://edns.de).

It solves ACME `dns-01` challenges through the **eDNS challenge API**
(`https://dns-challenge.edns.de`), so Let's Encrypt certificates — wildcards included — can be
issued for eDNS zones without touching the zone by hand.

For Caddy and CertMagic, use the libdns provider instead:
[libdns-ednsde](https://github.com/chris299/libdns-ednsde) and
[caddy-dns-ednsde](https://github.com/chris299/caddy-dns-ednsde). This package is the Node.js
counterpart and talks to the same API.

- **Zero runtime dependencies** — platform `fetch` and `node:dns`, nothing else
- Determines the zone cut itself, so there is no zone list to maintain
- Verifies propagation against the zone's authoritative nameservers before handing back to ACME
- Handles wildcards, SAN certificates with two values on one name, and internationalised domains

## Install

```bash
npm install --save acme-dns-01-ednsde
```

## Getting an access token

1. In the eDNS web interface, go to **SSL-Zertifikate → Automation-API-Verwaltung →
   API-Zugang anlegen** and create a token.
2. Open the zone you want to use it for and select that token on the zone's
   **DNS-01-Challenge** tab.

**Step 2 is easy to miss.** Without it every request for that zone is answered with `401`, with the
_same_ message as an entirely invalid token — the API does not distinguish the two cases. The error
this package raises says so. One token can be assigned to several zones.

## Usage

### ACME.js

```js
const dns01 = require('acme-dns-01-ednsde').create({
  token: process.env.EDNS_TOKEN,
});

await acme.certificates.create({
  account,
  accountKey,
  csr,
  domains,
  challenges: { 'dns-01': dns01 },
});
```

### Greenlock.js

```js
greenlock.manager.defaults({
  challenges: {
    'dns-01': {
      module: 'acme-dns-01-ednsde',
      token: 'xxxx',
    },
  },
});
```

### ioBroker

The adapter ships its own list of DNS providers. Until this plugin is part of it, wire it up by hand:

```bash
cd /opt/iobroker && npm install acme-dns-01-ednsde
```

Then enter the token and your domains in the adapter's configuration dialog, and set
`native.dns01Module` to `acme-dns-01-ednsde` on the object `system.adapter.acme.0` — through the
object editor in admin, because the configuration dialog's provider list does not know this module
yet. **Do not reopen and save the configuration dialog afterwards**, or the form will write the
unknown value away.

`skipChallengeTest` is honoured from adapter version 3.0.0 on. Older versions ignore it and add
their own propagation delay on top: slower, but correct.

## Options

| Option                | Default  | Meaning                                                                 |
| --------------------- | -------- | ----------------------------------------------------------------------- |
| `token`               | required | eDNS access token, sent as `X-API-TOKEN`                                |
| `zones`               | —        | Zones to use instead of determining the zone cut over DNS               |
| `propagationTimeout`  | `120000` | How long to wait for the record to reach every authoritative nameserver |
| `propagationInterval` | `2000`   | How long between propagation checks                                     |
| `log`                 | —        | `(message) => void` for progress; silent when omitted                   |

`zones` is an escape hatch, not something you normally set. The eDNS challenge API has no endpoint
that lists zones, so the plugin finds the zone cut by walking up from the challenge name to the
first name that owns an SOA record. That is correct even for delegated subzones, where the zone cut
is not where the registrable domain ends.

## Behaviour worth knowing

**Propagation is verified, not waited out.** `set()` asks the zone's authoritative nameservers
directly, in a loop, until all of them serve the expected value; only then does it return. Asking
them directly is the only measurement that no cache can spoil. Because of that the plugin reports
`propagationDelay = 0` and `skipChallengeTest = true`, which tells ACME.js its own pre-flight check
over the system resolver has nothing left to add.

**Your zone's SOA minimum matters more than any propagation number.** A challenge name does not
exist before the first issuance, so the first lookup of it returns NXDOMAIN — and that negative
answer is cached for the SOA minimum. Keep it low:

```sh
dig +short SOA example.com | awk '{print "negative TTL:", $NF}'
```

At 86400 a first issuance can stall for a day. At 300 it costs at most five minutes, once.

**Timing, measured against a live zone** (`winkler.tel`, nameservers `ns3`/`ns4.edns.de`, with
`scripts/measure-propagation.js`):

| Operation                                       | Visible on all authoritative nameservers after |
| ----------------------------------------------- | ---------------------------------------------- |
| add, on a name that did not exist before        | 23–27 s                                        |
| **add, on a name that already carries a value** | **~301 s**                                     |
| remove                                          | ~307 s                                         |

Budget for twice that many records: ACME.js runs a dry pass first, with
`_greenlock-dryrun-*` names of its own, before it touches `_acme-challenge`. Measured through the
ioBroker adapter, a certificate covering a domain and its wildcard costs about seven minutes end to
end — two dry-run names at ~23 s each, then the real name twice, the second of which waits out the
cache below.

That middle row is the one to know about. eDNS serves challenge records from a cache with the
record's own 300 s TTL in front of its nameservers, so a _second_ value on a name is invisible until
that cache expires — and a SAN certificate covering both `example.com` and `*.example.com` puts
exactly two values on one name. The plugin notices this on its first check (the name answers, but
with values that are not ours) and extends its wait to cover the TTL. A first issuance for a fresh
name keeps the short budget, so nothing slows down that does not have to.

**`get()` reports `null` right after a removal, even while DNS still serves the record.** That
removal figure above is almost exactly the 300 s record TTL: eDNS keeps answering with the record
until its own cache expires. Once the API has confirmed a removal, the record is gone at the
authority of record, and `get()` says so rather than reporting a cache artefact. This is a
deliberate decision, not a bug — see
[docs/adr/0003](docs/adr/0003-get-antwortet-nach-entfernen-aus-buchhaltung.md). It matters less than
it looks in practice: ACME validation succeeds as long as _some_ TXT record at the name carries the
expected value, so a lingering record from a previous run does no harm.

**A removal never fails.** Removing something that is not there is reported as success, because
cleanup also runs after a challenge that failed earlier and an exception there would bury the real
cause. eDNS also only removes records created through this same API; records added by hand in the
web interface are reported as not found.

**Several values may share one name.** That is what a SAN certificate covering both `example.com`
and `*.example.com` needs, and it works. `get()` matches on the exact expected value rather than on
whatever TXT record happens to come first.

**It is silent unless you give it a `log`.** Waiting for DNS takes tens of seconds at best and five
minutes in the shared-name case above, and a library that writes to stdout uninvited is a nuisance —
so by default nothing is reported, which is unfortunately hard to tell from a hang. Pass `log` and it
says what it is waiting for, how long it will wait, and why:

```js
const dns01 = require('acme-dns-01-ednsde').create({
  token: process.env.EDNS_TOKEN,
  log: message => console.log(`[dns-01] ${message}`),
});
```

**Records from an abandoned run are not cleaned up for you.** The plugin removes a record itself only
when its own propagation wait fails. If the ACME client dies later — between a successful `set()` and
the `remove()` it owes — the value stays, and because eDNS then answers that name from its cache
every later issuance pays the 300 s penalty above. To clear one out, read the values and delete the
ones you recognise:

```bash
dig +short TXT _acme-challenge.example.com
node -e "require('acme-dns-01-ednsde/lib/api').createApiClient({token:process.env.EDNS_TOKEN})
  .remove('example.com','_acme-challenge','<the value>').then(console.log)"
```

Deleting something that is not there is not an error, so this is safe to repeat.

**Internationalised domains are converted to A-labels** before any DNS query or API call.

**Retries.** Connection errors, `429` and `5xx` are retried up to three times with a short backoff.
`4xx` responses are returned immediately.

## Tests

Unit tests need no network and no credentials — the eDNS API and DNS are both stubbed:

```bash
npm test
```

The compliance harness runs against a real zone and a real token, and is therefore separate:

```bash
EDNS_TOKEN=... npm run test:integration winkler.tel
```

It takes about six minutes, and nothing is wrong when it does: it tests three names, two of which
share one `_acme-challenge` host, so one of them waits out the 300 s record cache described above.

The harness proves records get set, read and removed. It does not prove a certificate comes out — it
never talks to a CA. That is a separate run against Let's Encrypt's staging environment, which
mirrors how ioBroker.acme drives ACME.js:

```bash
EDNS_TOKEN=... ACME_EMAIL=you@example.com npm run test:certificate winkler.tel '*.winkler.tel'
```

Apex plus wildcard is the interesting request: both challenges land on one name with different
values.

That run needs `@root/acme` **3.1.1**, which exists as a git tag and was never published to npm; the
published 3.1.0 re-sends both the challenge trigger and the order finalization, and today's Boulder
rejects the repeats with 409 and 403. Fetch it first:

```bash
npm run acme:fixed
```

`acme:fixed` applies upstream's own diff from `patches/`, so it needs no network: that git host is
not reliably reachable, and no other test should depend on it. The mechanism and the evidence are in
[docs/acme-js-incompatibilities.md](docs/acme-js-incompatibilities.md); it matters to anyone using
ACME.js from npm, not only to this plugin.

## Development

`.vscode/launch.json` has configurations for the unit tests, the harness with real and with
shortened timings, the propagation measurement and the certificate run. Breakpoints in
`lib/presenter.js` at `waitDirectly` and `waitThroughResolver` are where the waiting happens.
`integration.js` accepts `EDNS_PROPAGATION_TIMEOUT`, `EDNS_PROPAGATION_INTERVAL` and
`EDNS_SHARED_NAME_TIMEOUT` so stepping through a wait does not mean sitting out a real cache expiry.
The library itself keeps its own defaults.

Note that `get()` is never called by ACME.js — only by the test harness. If you are stepping through
a real issuance, do not wait for it.

## Documentation

- [CONTEXT.md](CONTEXT.md) — the vocabulary this package uses, and what it deliberately avoids
- [docs/adr/](docs/adr/) — why the zone cut is found over DNS, why propagation is verified rather
  than waited out, and why `get()` behaves as it does after a removal

## Licence

MIT © Christoph Winkler

## When direct DNS queries are not possible

Verifying propagation means asking the zone's authoritative nameservers on port 53. Not every host
may: corporate firewalls and providers that intercept DNS block it, and then _no_ external
nameserver answers — not the zone's, not `1.1.1.1`.

The plugin notices this on its first attempt and falls back to whatever resolver the host is
configured to use. That works, but it changes the timing, because a caching resolver holds the
"this name does not exist" answer for the zone's SOA minimum:

- the first question is asked after 30 seconds rather than immediately — an earlier one would only
  cache a miss and make the whole wait pointless
- further questions follow at the SOA minimum, since a sooner one just re-reads that cache
- the time budget comes from the zone's SOA minimum instead of `propagationTimeout`, because a
  shorter one cannot succeed

So a first issuance behind a blocked port 53 takes minutes where a direct check takes about 23
seconds. If you can, allow outbound DNS to the zone's nameservers — and keep the SOA minimum low
either way. Details in [docs/adr/0004](docs/adr/0004-fallback-auf-den-konfigurierten-resolver.md).
