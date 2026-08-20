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

**Timing, measured against a live zone** (`winkler.tel`, nameservers `ns3`/`ns4.edns.de`):

| Operation                                | Visible on all authoritative nameservers after |
| ---------------------------------------- | ---------------------------------------------- |
| add, on a name that did not exist before | ~23 s                                          |
| add, on a name that already has records  | immediately                                    |
| remove                                   | ~307 s                                         |

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

## Documentation

- [CONTEXT.md](CONTEXT.md) — the vocabulary this package uses, and what it deliberately avoids
- [docs/adr/](docs/adr/) — why the zone cut is found over DNS, why propagation is verified rather
  than waited out, and why `get()` behaves as it does after a removal

## Licence

MIT © Christoph Winkler
