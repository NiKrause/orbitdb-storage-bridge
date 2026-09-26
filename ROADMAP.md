# Roadmap

Moved here from the README, unchanged apart from one dead link.

Two warnings about reading it. **The version numbers no longer mean anything**: they run from
v0.4.4 (Feb 2026) to v0.10.0 (Aug 2027), while the published package is already past them — see
[CHANGES.md](CHANGES.md) for what actually shipped. And **nothing here has been ticked off**, so an
unchecked box means "not verified as done", not "not done". Both want a pass from someone who knows
which of these landed.

> Being re-based on a backend interface instead of a single vendor — the plan is
> [issue 54](https://github.com/NiKrause/orbitdb-storage-bridge/issues/54), not here. The WebAuthn/varsig items below survive
> unchanged; the Storacha-named ones become backend-agnostic.

- [ ] Live parallel persistence: hand an open database a backend-backed OrbitDB `ComposedStorage`, so every block is written to a backend **as it is created** — during sync and after each update — rather than only when a backup runs.
  - [ ] Today a block becomes durable somewhere else only if bitswap reaches a peer that keeps it, gossipsub reaches a subscriber, or somebody runs a backup. All three depend on another party being reachable at that moment; a write-through storage does not.
  - [ ] The seam already exists: [`lib/car-storage.js`](lib/car-storage.js) implements OrbitDB's storage shape (`put`/`get`/`del`/`iterator`/`merge`) against a CAR file, and `ComposedStorage` is designed to fan a write out to more than one place. This points the same seam at a network backend instead.
  - [ ] Aleph Cloud is the first candidate, because it is the only evaluated backend a browser can write to with no key at all — `POST /api/v0/add` answers unauthenticated with an open CORS header. See [docs/STORAGE-BACKENDS.md](docs/STORAGE-BACKENDS.md); persistence there needs the wallet-signed STORE message, not the ingest alone.
  - [ ] Open question worth settling first: what a write-through storage does when the backend is unreachable. Blocking a local write on a network round trip would make the database only as available as the backend, which is the opposite of the point — so it queues, and the queue is the design.

- [ ] v0.4.4 (Feb 2026): Latest-backup pointer (single CID) to avoid listing via the Storacha SDK and restore from the IPFS network for initial OrbitDB syncs.
  - [ ] After each backup, write a small pointer record (JSON) that stores the latest metadata CID, CAR CID, and last heads (block CID).
  - [ ] Store that pointer in a user-controlled place (local storage, QR/share link, WebAuthN largetBlog extension or file download).
- [ ] v0.5.0 (Feb 2026): OrbitDB CustomStorage (StorachaStorage) ([issue 23](https://github.com/NiKrause/orbitdb-storage-bridge/issues/23)).
- [ ] v0.6.0 (Mar 2026): WebAuthN + varsig signing/verification (Ed25519 and P-256) for OrbitDB oplog. https://github.com/ChainAgnostic/varsig/blob/main/README.md
- [ ] v0.6.1 (Mar 2026): WebAuthN + SimpleEncryption example that uses WebAuthN+PRF key material for encrypted backups and restore.
- [ ] v0.7.0 (Apr 2026): WebAuthN + OrbitDB AccessController (store a UCAN instead of only a DID for admin/write access).
  - [ ] Alice (authenticated via UCAN or Storacha credentials) can delegate/revoke access for Bob with custom/default capabilities ([issue 16](https://github.com/NiKrause/orbitdb-storage-bridge/issues/16)). See [WebAuthN Upload Wall](https://github.com/NiKrause/ucan-upload-wall/tree/browser-only/web).
- [ ] v0.7.1 (May 2026): Storacha Backup & Restore Svelte widget with WebAuthN-varsig UCAN signing/verification (Ed25519/P-256).
- [ ] v0.7.2 (May 2026): Storacha Backup & Restore React widget with WebAuthN-varsig UCAN signing/verification (Ed25519/P-256).
- [ ] v0.7.3 (May 2026): Storacha Backup & Restore React widget with WebAuthN-varsig UCAN delegation (Ed25519/P-256).
- [ ] v0.7.4 (May 2026): UI enhancement for the Storacha Backup & Restore widget (timestamped backup restore and management).
- [ ] v0.8.0 (Jun 2026): Upgrade to UCAN 1.0 support.
- [ ] v0.9.0 (Jul 2026): Social backup between devices with DKG (decentralized key generation).
- [ ] v0.10.0 (Aug 2027): WebAuthN + Roaming Credentials: Have a browser and a mobile with one Yubikey creating one and the same DID and replicating the same OrbitDB

Read more on Medium: [Bridging OrbitDB with Storacha: Decentralized Database Backups](https://medium.com/@akashjana663/bridging-orbitdb-with-storacha-decentralized-database-backups-44c7bee5c395)
