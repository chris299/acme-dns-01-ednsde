# ACME.js against today's Let's Encrypt

`scripts/issue-staging-certificate.js` currently does not get a certificate, and the reason is not
in this package. ACME.js (`acme@3.0.3` → `@root/acme@3.1.0`, unchanged since April 2022) re-sends two
requests that current Boulder rejects. Both are races, which is why they bite some people and not
others, and why the ioBroker adapter appears to work until it doesn't.

Recorded here because the failure looks like a plugin bug and is not one: in both places the
challenge plugin has already finished and is never consulted again.

## 1. The challenge trigger, answered with 409

`ACME._postChallenge` (`acme.js:844`) POSTs `{}` to the challenge URL and pipes the response straight
into `checkResult`. Boulder answers that first trigger with the challenge still `pending` —
validation is queued, not done. ACME.js treats that as impossible:

```js
// This state should never occur
if ('pending' === resp.body.status) {
    ...
    return ACME._wait(RETRY_INTERVAL).then(respondToChallenge);   // triggers a second time
}
```

Boulder answers the second trigger with **409**, because the challenge is no longer pending. ACME.js
reads the problem document's `status` field as if it were a challenge status and fails with
`(E_STATE_UKN) challenge state for '...': '409'`.

**Mitigation, one line in the consumer:** `acme.retryInterval = 25000`. The retry then lands after
validation has finished, and Boulder does accept a POST to an already-valid challenge — measured:
`pending` → `valid`, no 409. The default of 1000 ms is what loses the race.

## 2. Order finalization, answered with 403

`ACME._pollOrderStatus` (`acme.js:1010`) POSTs the CSR to the finalize URL, and on `processing` waits
and **POSTs the CSR again**:

```js
if ('processing' === resp.body.status) {
  return ACME._wait().then(pollCert); // pollCert re-POSTs the CSR to _finalizeUrl
}
```

RFC 8555 §7.4 says to poll the _order_ URL, not to finalize twice. Boulder rejects the second
finalize on an order that has moved to `valid`:

```
urn:ietf:params:acme:error:orderNotReady
Order's status ("valid") is not acceptable for finalization
status 403
```

ACME.js again reads `403` as a status and fails with `Didn't finalize order: Unhandled status '403'`.

**No timing knob helps here.** A second finalize is wrong whatever the delay; the fix is to poll the
order URL. Whether the first finalize returns `valid` outright is a race, which is why the same
adapter version issues certificates for some users and not others.

This is [ioBroker.acme issue #49](https://github.com/iobroker-community-adapters/ioBroker.acme/issues/49)
verbatim, open since 2023.

## What this means for this package

Nothing about the DNS side is in doubt. The debug log of a failing run shows the plugin handed ACME.js
exactly what it should:

```
dnsHost: _acme-challenge.winkler.tel
dnsZone: winkler.tel
dnsPrefix: _acme-challenge
keyAuthorizationDigest: phQ5dRfRi0XFo8uDOEWFWXBSckvieu0njIhn_pz8pro
```

and with mitigation 1 in place the challenge reaches `valid`, meaning Let's Encrypt itself looked up
the TXT record this plugin had published and accepted it. That is the strongest statement about the
plugin the staging run can make; what fails afterwards is the client's bookkeeping around the
certificate it has already earned.

The adapter's maintainers know the library is a problem —
[issue #169](https://github.com/iobroker-community-adapters/ioBroker.acme/issues/169) discusses
replacing it, with `acme-client` named as a candidate and forking `acme` as another. These findings
belong in that conversation.
