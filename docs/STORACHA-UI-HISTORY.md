# The Storacha UI, and where each piece went

The browser side of this project — a widget that logged into Storacha, managed spaces and
backed a database up, and a UCAN delegation example built around it — is older than the
copy this package ships, and its pieces are now scattered: this repository, a branch of
it, a separate repository, and the history of the app it was born in. Storacha has
accepted no uploads since May 2026
(see [STORACHA-SUNSET.md](STORACHA-SUNSET.md)), so none of
it can be exercised end to end any more.

This page records what existed, what it did, and where each piece is today. It does not
decide what to keep.

## What the widget did

The component was a self-contained Svelte panel, not a floating button. Its own
documentation, written in the app it was born in, described:

- creating a Storacha account by email, or logging in with a private key and a delegation proof;
- auto-login on later visits from credentials in `localStorage`;
- listing, creating and switching spaces, and showing the current one;
- one-click backup of an OrbitDB database, block by block, with metadata and a live block count;
- listing the backups in a space, newest first, and opening one's metadata.

It also carried a roadmap that never landed: encrypting the stored credentials,
restoring a backup into a fresh OrbitDB, **backup and restore through a delegated UCAN**,
and an OrbitDB `StorachaStorage`.

The full text is not lost. It lives in the history of
[NiKrause/simple-todo](https://github.com/NiKrause/simple-todo), one commit before the
deletion:

```sh
git show ba62779~1:docs/StorachaIntegration.md
git show ba62779~1:src/lib/StorachaIntegration.svelte   # 802 lines
```

## How it travelled

| When | What |
|---|---|
| 2025-08-13 | This repository starts as a **Node library** — `b3436b4` adds `lib/orbitdb-storacha-bridge.js`, three demo scripts, one test and `docs/ARCHITECTURE.md`. No Svelte. |
| 2025-08-15 | The widget is written in **simple-todo**, `fd5dfec` ("added storacha integration with credential login, backup and space management"), documented a day later in `7f4945f`. |
| 2025-09-06 | A **copy** arrives here as `src/components/StorachaIntegration.svelte` (`9b5aa56`). The two have drifted apart since; the copy is 965 lines against the original's 802. |
| 2025-11-23 | The UCAN delegation example leaves the mainline: `40bc9ae` moves `examples/svelte/ucan-delegation` to the branch `feature/ucan-delegation-example`. |
| 2026-05-27 | **simple-todo deletes the original** and its documentation — `ba62779`, the same commit that removed Storacha from that app and added its sponsor-relay button. |
| 2026-09-17 | The three Storacha test harnesses stop being published ([#83](https://github.com/NiKrause/orbitdb-storage-bridge/pull/83)); their sources stay in `src/components`. |

So the copy in this repository is the only living version of a widget whose original was
thrown away, and the package it belongs to has since been renamed away from Storacha.

## Where each piece is now

| Piece | Where | State |
|---|---|---|
| `StorachaIntegration.svelte`, `StorachaAuth.svelte` | `src/components/`, published in 0.7.0 | **Cannot be imported** — see below |
| `StorachaTest*.svelte` (three harnesses) | `src/components/` | In the repository only, not published since #83 |
| `ucan-delegation` example (49 files) | branch [`feature/ucan-delegation-example`](https://github.com/NiKrause/orbitdb-storage-bridge/tree/feature/ucan-delegation-example/examples/svelte/ucan-delegation), tip `b1ceb00` | Complete, but its README is only the SvelteKit template |
| UCAN file uploads in a browser | separate repository [NiKrause/ucan-upload-wall](https://github.com/NiKrause/ucan-upload-wall) | Has its own documentation, demo and video |
| The widget's original and its documentation | simple-todo history, `ba62779~1` | Deleted from that app |

## What the UCAN example contained

Worth knowing before anyone reaches for the branch. Under
`examples/svelte/ucan-delegation/src/lib/`:

- **`P256StorachaDelegation.js`** — `createP256StorachaDelegation` and `createBridgeDelegation`:
  a UCAN delegation signed with Alice's P-256 OrbitDB identity, deliberately bypassing
  Storacha's own EdDSA agent.
- **`services/UCANService.js`** — creating, fetching, revoking and clearing delegations,
  lifted out of `StorachaTestWithWebAuthn.svelte`.
- **`BobUsesAliceDelegation.js`** — the other half: Bob, holding a P-256 WebAuthn identity,
  using Alice's EdDSA-signed delegation.
- **`UCANOrbitDBAccessController.js`** — an OrbitDB access controller built on that idea.
- **`AgentSanitizer.js`** — a workaround for `undefined is not supported by the IPLD Data Model`,
  which Storacha agents could provoke.
- **`services/IdentityService.js`, `services/OrbitDBService.js`**, plus `StorachaAuth.svelte`
  and `StorachaTestWithWebAuthn.svelte` for the interface.

It never worked fully against the live service. `SVELTE-COMPONENTS.md` has said since it
was written that P-256 UCANs were not supported by Storacha's upload service. Why the
example was moved off the mainline rather than fixed is not recorded: `40bc9ae` says only
that it moved.

## Why none of it runs today

- **No uploads.** Storacha has taken none since May 2026, so every path that ends in a
  backup is dead, delegated or not.
- **The delegation path was already blocked** by the P-256 limitation above.
- **The two published components cannot be imported.** A `vite build` of the published
  0.7.0, installed from npm, stops at `Could not resolve "./db-actions.js"` for
  `StorachaIntegration.svelte` and at `carbon-components-svelte` for `StorachaAuth.svelte`.
  In the same tarball, `components/theme.js` and `restore-cid` build, so it is these
  components, not the package.

  What is missing, read out of that tarball: `StorachaIntegration.svelte` imports
  `./db-actions.js`, `./p2p.js` and `./libp2p-config.js`, which belong to the app it came
  from and have never been in the package, plus `../lib/logger.js`, which from
  `dist/components/` means `dist/lib/logger.js` — there is no `dist/lib`.
  `StorachaAuth.svelte` needs that same logger path, and `carbon-components-svelte` and
  `carbon-icons-svelte`, which the package does not declare — its only peers are `svelte`
  and `lucide-svelte`. Both pull in `storacha-backup.js`, which imports `createHash` from
  Node's `crypto` and so fails a browser build without a polyfill.

Whether those two should be repaired or dropped is still open. This page only records the
state.

## What outlives Storacha

- **A UCAN instead of a DID for write access.** `UCANOrbitDBAccessController.js` is the
  one piece that is not about Storacha at all, and the [roadmap](../ROADMAP.md)
  still carries it as v0.7.0.
- **Restoring from a CID.** `lib/restore-cid.js` and `lib/gateway-fetch.js` verify every
  block against its CID, so they work from any source that serves the bytes.
- **The backend seam.** `lib/backends/` now holds Aleph, Pinata, Lighthouse, an in-memory
  driver and Storacha, so the storage half has somewhere to go.
