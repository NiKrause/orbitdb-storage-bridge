# Roadmap

Status checked against `main` on 2026-09-26, item by item, from the code and the closed issues
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

## Built, not merged

- **Svelte and React widgets for backup and restore, with WebAuthn-varsig UCAN signing,
  verification and delegation.** The UCAN delegation example is complete — 49 files on the branch
  [`feature/ucan-delegation-example`](https://github.com/NiKrause/orbitdb-storage-bridge/tree/feature/ucan-delegation-example/examples/svelte/ucan-delegation),
  tip `b1ceb00` — and has never reached the mainline. The widget's original was deleted from
  simple-todo in May 2026. Neither ticked nor dropped on purpose: the work exists and is not
  reachable from a release. [docs/STORACHA-UI-HISTORY.md](docs/STORACHA-UI-HISTORY.md) records what
  each piece could do and where it is now.

## Open

- [ ] **Live parallel persistence:** hand an open database a backend-backed OrbitDB
      `ComposedStorage`, so every block is written to a backend **as it is created** — during sync
      and after each update — rather than only when a backup runs.
  - Today a block becomes durable elsewhere only if bitswap reaches a peer that keeps it, gossipsub
    reaches a subscriber, or somebody runs a backup. All three need another party to be reachable at
    that moment; a write-through storage does not.
  - The seam exists: [`lib/car-storage.js`](lib/car-storage.js) implements OrbitDB's storage shape
    (`put`/`get`/`del`/`iterator`/`merge`) against a CAR file, and `ComposedStorage` is built to fan
    one write out to several places. This points that seam at a network backend. As of 2026-09-26
    `ComposedStorage` appears nowhere else in the package, so nothing of this is started.
  - Aleph is the first candidate, because it is the only backend a browser can write to with no key
    at all. See [docs/STORAGE-BACKENDS.md](docs/STORAGE-BACKENDS.md); retention there needs the
    wallet-signed STORE message, not the ingest alone.
  - Settle first what a write-through does when the backend is unreachable. Blocking a local write
    on a network round trip would make the database exactly as available as the backend, which is
    the opposite of the point — so it queues, and the queue is the design.
- [ ] **UCAN 1.0.** Nothing in `CHANGES.md` mentions it and the dependencies are ucanto 9/10 with
      `@ipld/dag-ucan` 3, so this is untouched.
- [ ] **Social backup between devices with DKG** (decentralized key generation). Untouched; the
      phrase appears only in this file.

## Tracked in issues instead

Plans with enough shape to have their own thread live there rather than here:

- [#54](https://github.com/NiKrause/orbitdb-storage-bridge/issues/54) — the vendor-neutral backend
  interface. Largely delivered; its own numbering is stale in the same way this file's was.
- [#60](https://github.com/NiKrause/orbitdb-storage-bridge/issues/60) — three drivers have never
  been run against a live account. Help wanted.
- [#70](https://github.com/NiKrause/orbitdb-storage-bridge/issues/70) — boot an OrbitDB from a CID
  over IPFS with no HTTP gateway in the path.
