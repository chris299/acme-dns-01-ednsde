# ACME.js against today's Let's Encrypt

**Resolved, and not by us: the fix already exists upstream and was never published.** Keep reading
only if you need the detail; the summary is that `@root/acme` **3.1.1** in git fixes both problems and
npm still serves **3.1.0**.

The version npm hands you re-sends two requests that current Boulder rejects. Both are races, which
is why they bite some people and not others, and why the ioBroker adapter appears to work until it
doesn't. Recorded here because the failure looks like a plugin bug and is not one: in both places the
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

## The fix: @root/acme 3.1.1, tagged but unpublished

The [acme.js repository](https://git.rootprojects.org/root/acme.js) is at **3.1.1**
(tag `v3.1.1`, commit `45fd6962f259c6399de05589848d68be42894316`). The commit before it —
`0aa939a2`, _"Bug fix: Polling status using POST-as-GET wherever possible"_, 2021-04-08, merged from
`sam-lord` — fixes exactly the two failures above:

- `_postChallenge`: a `pending` challenge now goes to `pollStatus` (POST-as-GET) instead of
  triggering the challenge a second time.
- `_pollOrderStatus`: split into `finalizeOrder()`, which POSTs the CSR once, and `pollStatus()`,
  which POST-as-GETs `order._orderUrl` as RFC 8555 §7.4 asks.

It was tagged in May 2021 and never published to npm. So there is nothing to invent and nothing to
fork — the working code exists. Verified end to end against Let's Encrypt staging with 3.1.1 in
place: `pending` → `valid` for the challenge, `processing` → `valid` for the order, and a certificate
`CN=*.winkler.tel` issued by `(STAGING) Dastardly Durum YR1`.

## Depending on it is the hard part

Pointing npm at the git tag works, and is fragile. The first attempt installed fine; the second
failed outright:

```
npm error fatal: unable to access 'https://git.rootprojects.org/root/acme.js.git/':
gnutls_handshake() failed: The TLS connection was non-properly terminated.
```

That Gitea is one self-hosted server, and a dependency on it turns every install into a coin flip.
This repository therefore keeps it out of `package.json` altogether: `npm run acme:fixed` fetches it
on demand, and only the certificate workflow does so, with retries. Nothing else — not the unit
tests, not the compliance harness, not a consumer of this package — ever reaches for it.

For ioBroker.acme the same approach is not available: its users install the adapter, not a workflow.
The realistic options there, in increasing order of commitment:

1. **Publish 3.1.1 to npm under a scoped name** and depend on that. It is the upstream author's own
   tagged release, unmodified, MPL-2.0, so this is redistribution rather than a fork — but somebody
   has to own the namespace.
2. **Vendor the patched file** in the adapter, with its licence. No new dependency, but a copy to
   keep track of.
3. **Replace ACME.js**, which is what the maintainers already prefer in
   [issue #169](https://github.com/iobroker-community-adapters/ioBroker.acme/issues/169), with
   `acme-client` named as the candidate.

### A fourth option: replace the two functions at run time

Both broken functions are plain properties on the object `require('acme')` returns, and both are
writable and configurable. Everything they need is reachable from outside the package —
`@root/acme/utils.js` exports `_jwsRequest`, `@root/acme/errors.js` the error constructors,
`@root/encoding/bytes.js` the buffer helpers — so a consumer can assign the 3.1.1 versions over the
3.1.0 ones before calling `ACME.create()`.

That needs no network, no `postinstall`, no mutation of `node_modules`, and it survives
`npm ci --ignore-scripts`. Verified against **unpatched** 3.1.0 (`grep -c 'function finalizeOrder'`
→ 0) with the replacement injected through `node --require`:

| Certificate         | Authorization                          | Result         |
| ------------------- | -------------------------------------- | -------------- |
| `*.winkler.tel`     | reused, so only finalization exercised | issued in 61 s |
| `probe.winkler.tel` | fresh, so the full challenge cycle ran | issued in 61 s |

The second row matters: a name never authorized before forces the challenge trigger that answers
409 on 3.1.0, so both fixes are covered, not just the finalization one.

The cost is that the consumer then carries about 180 lines of somebody else's code, copied from a
release that was tagged and never shipped, and has to remember to drop it if the library is ever
replaced or updated. Which is a real liability, and exactly why the choice belongs to whoever
maintains the consumer rather than to whoever noticed the bug.

None of that is this package's problem to solve, and none of it blocks it: the plugin implements
ACME.js' documented challenge interface, and does so correctly whichever version of ACME.js is
driving it.

## What this means for this package

Nothing about the DNS side is in doubt. The debug log of a failing run shows the plugin handed ACME.js
exactly what it should:

```
dnsHost: _acme-challenge.winkler.tel
dnsZone: winkler.tel
dnsPrefix: _acme-challenge
keyAuthorizationDigest: phQ5dRfRi0XFo8uDOEWFWXBSckvieu0njIhn_pz8pro
```

and with 3.1.1 in place a certificate comes out. Even before that, the challenge reached `valid`,
meaning Let's Encrypt itself looked up the TXT record this plugin had published and accepted it.

The adapter's maintainers know the library is a problem —
[issue #169](https://github.com/iobroker-community-adapters/ioBroker.acme/issues/169) discusses
replacing it, with `acme-client` named as a candidate and forking `acme` as another. These findings
belong in that conversation.
