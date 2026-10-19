# Roadmap

Status checked against `main` on 2026-10-19 (0.22.0), item by item, from the code and the closed issues
rather than from memory. The version numbers this list used to carry — v0.4.4 (Feb 2026) through
v0.10.0 (Aug 2027) — are gone: the published package passed them long ago, and a number that
predicts the past helps nobody. [CHANGES.md](CHANGES.md) is the record of what shipped when.

## Done

- [x] **A pointer a second device can find.** Planned as a JSON record holding the latest metadata
      CID, CAR CID and heads, stored somewhere the user controls. Built as something better:
      [`lib/pointer-ipns.js`](lib/pointer-ipns.js) *computes* the name from a seed, so nothing has
      to be carried at all. A device that has lost everything can find its backup, because there is
      nobody left to tell it a CID.
- [x] **An OrbitDB CustomStorage** ([issue 23](https://github.com/NiKrause/orbitdb-storage-bridge/issues/23),
      closed 2026-09-17).
- [x] **WebAuthn + varsig signing and verification (Ed25519 and P-256) for the OrbitDB oplog** —
      implemented in
      [`Le-Space/orbitdb-identity-provider-webauthn-did`](https://github.com/Le-Space/orbitdb-identity-provider-webauthn-did),
      which is where identity belongs. This package does not depend on it, and does not need to:
      the seam between them is a DID and a signing key.
- [x] **WebAuthn + encrypted backups from PRF key material.** Planned as an example; shipped as the
      default. [`lib/backends/encryption.js`](lib/backends/encryption.js) wraps any backend, and
      `dehydrate` encrypts unless told otherwise — the test says it plainly: writing plaintext is a
      decision.
- [x] **WebAuthn + OrbitDB AccessController**, storing a UCAN rather than only a DID, so Alice can
      delegate and revoke for Bob ([issue 16](https://github.com/NiKrause/orbitdb-storage-bridge/issues/16),
      closed 2026-09-17).
- [x] **Roaming credentials: one security key, two devices, one identity.** Measured on 2026-09-19
      with one YubiKey, a Galaxy Fold 5 and a Galaxy A57: the same PRF value, the passkey found
      without being named, and the same DID and derived signing key on both phones. The full
      recovery then ran end to end on 2026-09-21. See
      [docs/RECOVERY-ON-A-SECOND-DEVICE.md](docs/RECOVERY-ON-A-SECOND-DEVICE.md).

- [x] **Live parallel persistence** — delivered as *increments*, not as a write-through storage
      (`@le-space/orbitdb-storage-bridge/live-backup`, [#144](https://github.com/NiKrause/orbitdb-storage-bridge/issues/144),
      [docs/LIVE-BACKUP.md](docs/LIVE-BACKUP.md)). A watcher keeps, per database, the heads it last
      shipped; a flush walks from the current heads back to them and ships what it passed as one
      small CAR, through any backend, kept with one STORE. The queue the item asked for is the
      log itself: a local write never waits, an unreachable backend only makes the next increment
      larger, and a restart rebuilds what was shipped from a few persisted hashes. A
      `ComposedStorage` that writes every block through was rejected on the way (one STORE per
      block, hundreds of messages a day, and a service that sees when someone works).
- [x] **Forgetting on Aleph.** `createAlephForget` and `forgetAlephStores` (0.19.0,
      [docs/LIVE-BACKUP.md](docs/LIVE-BACKUP.md), "Deleting an archive"): the increments a full
      backup made redundant, and an archive given up, are released by the account that pays for
      them, with `keep` sparing the new base. Since 0.21.0 a `ref` on the STORE lets one account
      keep several chains and forget one.

## Built, not merged

- **Svelte and React widgets for backup and restore, with WebAuthn-varsig UCAN signing,
  verification and delegation.** The UCAN delegation example is complete — 49 files on the branch
  [`feature/ucan-delegation-example`](https://github.com/NiKrause/orbitdb-storage-bridge/tree/feature/ucan-delegation-example/examples/svelte/ucan-delegation),
  tip `b1ceb00` — and has never reached the mainline. The widget's original was deleted from
  simple-todo in May 2026. Neither ticked nor dropped on purpose: the work exists and is not
  reachable from a release. [docs/STORACHA-UI-HISTORY.md](docs/STORACHA-UI-HISTORY.md) records what
  each piece could do and where it is now.

## Open

- [ ] **UCAN 1.0.** Nothing in `CHANGES.md` mentions it; the ucanto 9/10 and `@ipld/dag-ucan` 3
      code is Storacha-era and a devDependency since 0.22.0, so this is untouched.
- [ ] **Social backup between devices with DKG** (decentralized key generation). Untouched; the
      phrase appears only in this file.

## Tracked in issues instead

Plans with enough shape to have their own thread live there rather than here:

- [#54](https://github.com/NiKrause/orbitdb-storage-bridge/issues/54) — the vendor-neutral backend
  interface. Largely delivered.
- [#60](https://github.com/NiKrause/orbitdb-storage-bridge/issues/60) — three drivers have never
  been run against a live account. Help wanted.
- [#70](https://github.com/NiKrause/orbitdb-storage-bridge/issues/70) — boot an OrbitDB from a CID
  over IPFS with no HTTP gateway in the path.
