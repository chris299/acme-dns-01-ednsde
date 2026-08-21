# patches/

## `root-acme-3.1.1.diff`

Brings the installed `@root/acme` **3.1.0** — the newest version on npm — up to **3.1.1**, which
exists only as a git tag in the
[acme.js repository](https://git.rootprojects.org/root/acme.js) and was never published.

This is not our change. It is upstream commit `0aa939a2`, _"Bug fix: Polling status using POST-as-GET
wherever possible"_ (2021-04-08, merged from `sam-lord`), released as tag `v3.1.1`
(`45fd6962f259c6399de05589848d68be42894316`) in May 2021. The diff touches `acme.js` only; the rest of
the 3.1.1 release is a version bump, and the new code uses no helpers 3.1.0 does not already have.

Without it, Let's Encrypt refuses to issue: 3.1.0 re-sends the challenge trigger and re-sends the
order finalization, and today's Boulder answers those repeats with 409 and 403.
[docs/acme-js-incompatibilities.md](../docs/acme-js-incompatibilities.md) has the mechanism and the
evidence.

Applied by `npm run acme:fixed`, which is needed only for `npm run test:certificate`. Nothing else in
this repository uses ACME.js, and the published package has no runtime dependencies at all.

### Why a patch rather than a dependency

Pointing npm at the git tag works when that host answers, and it often does not. In one session it
installed once, then failed three times in a row with

```
fatal: unable to access 'https://git.rootprojects.org/root/acme.js.git/':
gnutls_handshake() failed: The TLS connection was non-properly terminated.
```

and shortly after stopped answering plain HTTPS as well. A patch in the repository needs no network
and cannot rot away with someone else's server.

`@root/acme` is MPL-2.0. This directory carries a diff against it, not a copy, and the licence stays
with the package it patches.
