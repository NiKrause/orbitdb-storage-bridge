# OrbitDB Storage Bridge

> **OrbitDB database backup, restoration and replication through pluggable storage backends, with hash and identity preservation**


[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org/)
[![CI/CD Pipeline](https://github.com/NiKrause/orbitdb-storage-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/NiKrause/orbitdb-storage-bridge/actions/workflows/ci.yml)
[![ESLint](https://img.shields.io/badge/ESLint-passing-brightgreen.svg)](https://github.com/NiKrause/orbitdb-storage-bridge/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@le-space/orbitdb-storage-bridge.svg)](https://www.npmjs.com/package/@le-space/orbitdb-storage-bridge)

> [!NOTE]
> **Renamed from `orbitdb-storacha-bridge`.** Up to 0.6.0 this package was published as
> `orbitdb-storacha-bridge`. From 0.7.0 it is `@le-space/orbitdb-storage-bridge`, because Storacha is no
> longer the only backend it bridges to. The rename changes no API — swap the dependency and the
> import specifiers:
>
> ```bash
> npm uninstall orbitdb-storacha-bridge
> npm install @le-space/orbitdb-storage-bridge
> ```
>
> `orbitdb-storacha-bridge/courier-sync` becomes `@le-space/orbitdb-storage-bridge/courier-sync`, and so on
> for every entry point. Names that refer to Storacha itself stay as they are:
> `OrbitDBStorachaBridge`, `StorachaIntegration.svelte`, `backends/storacha`, the `storacha_*`
> localStorage keys that hold saved logins — and so does the debug namespace
> `libp2p:orbitdb-storacha:*`.


> [!IMPORTANT]
> **The Storacha upload service is gone.** Writes were switched off in May 2026 and the
> service has since been decommissioned. Backup no longer works, and restore only reaches
> blocks that something other than Storacha still holds. See
> [Status: Storacha sunset](#status-storacha-sunset-may-2026) and
> [docs/STORAGE-BACKENDS.md](docs/STORAGE-BACKENDS.md) for where to go instead.


## Table of Contents

- [OrbitDB Storage Bridge](#@le-space/orbitdb-storage-bridge)
  - [Table of Contents](#table-of-contents)
  - [Status: Storacha sunset (May 2026)](#status-storacha-sunset-may-2026)
  - [What we want to accomplish](#what-we-want-to-accomplish)
    - [The Challenge of Distributed Data Persistence](#the-challenge-of-distributed-data-persistence)
    - [Architectural Considerations for Local-First Applications](#architectural-considerations-for-local-first-applications)
    - [Use Cases](#use-cases)
    - [Architecture Notes](#architecture-notes)
  - [What This Does](#what-this-does)
  - [Roadmap](#roadmap)
  - [Installation](#installation)
  - [Environment Setup](#environment-setup)
  - [Demo](#demo)
    - [NodeJS Demo Scripts (full backup with Manifest, Identity and AccessController and entries blocks)](#nodejs-demo-scripts-full-backup-with-manifest-identity-and-accesscontroller-and-entries-blocks)
    - [Svelte Components](#svelte-components)
  - [How It Works](#how-it-works)
  - [Restore Mechanism](#restore-mechanism)
  - [Logging](#logging)
  - [Testing](#testing)
  - [Contributing](#contributing)
  - [License](#license)


## Status: Storacha sunset (May 2026)

Storacha switched off user writes in **May 2026** and has since decommissioned the service.
Verified on 2026-09-05:

| Check | Result |
| --- | --- |
| `up.storacha.network`, `console.storacha.network`, `indexer.storacha.network`, `forge.storacha.network` | no DNS record — upload, console and indexing endpoints are gone |
| `storacha.network`, `docs.storacha.network` | `301` → `fil.one`, the team's new S3-compatible product |
| `storacha.link`, `w3s.link` | `301` → `dweb.link`; the gateways only forward to the public IPFS gateway now |
| the widget demo CID linked in the roadmap below | `504` on `w3s.link`, `dweb.link`, `ipfs.io` and `trustless-gateway.link` |
| `@storacha/client` on npm | last release `2.1.4`, 2026-05-15, not marked deprecated |

The shutdown is traceable in the open:
[`upload-service#708`](https://github.com/storacha/upload-service/pull/708) added a `writesDisabled`
kill switch that makes the eight user-initiated write capabilities
(`space/blob/{add,remove,replicate}`, `space/index/add`, `upload/{add,remove}`, `store/{add,remove}`)
return `ServiceUnavailable`, and [`w3infra#636`](https://github.com/storacha/w3infra/pull/636) wired
`WRITES_DISABLED=true` into the production stack — both merged 2026-05-15. Five days later Storacha
shipped `storacha space migrate`
([`@storacha/filecoin-pin-migration`](https://www.npmjs.com/package/@storacha/filecoin-pin-migration)),
a migration path from Storacha spaces to Filecoin Onchain Cloud. That tool reads spaces through
endpoints that no longer resolve, so the official migration window has closed.

We found no announcement page: the Storacha blog now redirects to `fil.one/blog`, which carries a
single post ("Introducing Fil One", 2026-08-12). The dates above come from the code and the DNS,
not from a press release.

**What this means for this library**

- **Backup does not work.** Every write path ends in `client.uploadFile()` against `up.storacha.network`.
- **Restore only reaches what someone else still holds.** The p2p-first path still finds blocks that a
  peer or another pinning service pins; the gateway fallback and the `capability.upload.list`
  discovery step cannot reach Storacha any more.
- **The OrbitDB half is unaffected.** Block extraction, CID bridging, CAR packing, identity
  preservation, UCAN signing and courier-sync are backend-agnostic — only the handful of Storacha
  client methods mapped in [docs/STORAGE-BACKENDS.md](docs/STORAGE-BACKENDS.md) need a new home.

If you still have an OrbitDB instance with the blocks in it, re-pin them somewhere else now: the data
is only as alive as the peers that hold it.


## What we want to accomplish

### The Challenge of Distributed Data Persistence

In local-first, peer-to-peer applications built on OrbitDB, data naturally replicates across participating peers through libp2p network connections. Under ideal conditions, this distributed architecture provides inherent redundancy—if one peer loses data, they can resynchronize from other active peers in the network. This peer-to-peer replication model represents the current state of OrbitDB technology.

While relay nodes and pinning services (running Helia and OrbitDB instances) can provide additional decentralized persistence for database entries and IPFS-referenced content, the ecosystem still lacks comprehensive infrastructure for long-term archival of large-scale OrbitDB deployments.

### Architectural Considerations for Local-First Applications

OrbitDB's data model differs fundamentally from traditional centralized databases. In local-first architectures, users typically host their own data locally and selectively replicate with specific peers based on collaboration requirements—not with the entire network. This selective replication is essential for scalability and user experience.

However, as OrbitDB instances grow (consider a blog database accumulating years of posts), replication times increase proportionally. At scale, databases require archival strategies and potential sharding to maintain performant synchronization and optimal user experience.

### Use Cases

This bridge addresses several critical scenarios:

**1. Long-term Archival**
Archive large OrbitDB instances to Storacha/Filecoin storage, enabling efficient cold storage for historical data while maintaining fast replication of active datasets.

**2. Disaster Recovery**
Provides recovery options when all active peers lose data simultaneously. Users can restore databases from Storacha using either their original identity or a new identity, ensuring business continuity beyond the peer-to-peer network's availability.

**3. Network Resilience**
Historically, various network environments (corporate networks, ISPs, regional restrictions) have blocked critical protocols including WebRTC and WebSocket/WebTransport. While libp2p's multi-transport architecture provides numerous fallback options, having an additional restoration pathway through IPFS/Storacha offers defense-in-depth for network-hostile environments. Users can restore databases directly from IPFS and maintain incremental backups after each database mutation.

**4. Access Control & Delegation**
The bridge supports UCAN (User Controlled Authorization Networks) authentication with planned delegation capabilities between OrbitDB instances. This enables fine-grained, time-bound access control for Storacha backup spaces, allowing users to securely share access with collaborators or recovery agents.

### Architecture Notes

Currently, Storacha backup and restore operations utilize Storacha's gateway infrastructure to interface with Filecoin's decentralized storage network. This hybrid approach balances accessibility with decentralization during the current phase of the Filecoin ecosystem's evolution.

That description is now historical: the gateway infrastructure it relies on was decommissioned in 2026 (see [Status: Storacha sunset](#status-storacha-sunset-may-2026)). The hybrid shape of the design still holds — a backend that stores bytes, an IPFS network that serves them — but the backend slot is open. [docs/STORAGE-BACKENDS.md](docs/STORAGE-BACKENDS.md) compares the candidates.

## What This Does

Backup and restore between **OrbitDB databases** and **Storacha/Filecoin** with full hash and identity preservation. Works in both Node.js and browser environments.

The project includes **Svelte components** for browser-based demos and integration (see [SVELTE-COMPONENTS.md](SVELTE-COMPONENTS.md) for detailed documentation).

**Features:**

- backup/restore between OrbitDB and Storacha in browsers and NodeJS via Storacha key and proof credential
  - full backup per space
  - timestamped backups (multiple backups per space - restore last backup by default)
- Storacha Svelte components for integration into Svelte projects
- UCAN authentication 
- Backup/restore functionality with hash and identity preservation
- OrbitDB CAR file storage [OrbitDB CustomStorage](https://github.com/orbitdb/orbitdb/blob/main/docs/STORAGE.md)

## Roadmap

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
  - [ ] Alice (authenticated via UCAN or Storacha credentials) can delegate/revoke access for Bob with custom/default capabilities ([issue 16](https://github.com/NiKrause/orbitdb-storage-bridge/issues/16)). See [WebAuthN Upload Wall](https://github.com/NiKrause/ucan-upload-wall/tree/browser-only/web) and the [live demo](https://bafybeibdcnp7pr26okzr6kbygcounsz3klyg3vydxwwovmz2ljyzfmprre.ipfs.w3s.link/).
- [ ] v0.7.1 (May 2026): Storacha Backup & Restore Svelte widget with WebAuthN-varsig UCAN signing/verification (Ed25519/P-256).
- [ ] v0.7.2 (May 2026): Storacha Backup & Restore React widget with WebAuthN-varsig UCAN signing/verification (Ed25519/P-256).
- [ ] v0.7.3 (May 2026): Storacha Backup & Restore React widget with WebAuthN-varsig UCAN delegation (Ed25519/P-256).
- [ ] v0.7.4 (May 2026): UI enhancement for the Storacha Backup & Restore widget (timestamped backup restore and management).
- [ ] v0.8.0 (Jun 2026): Upgrade to UCAN 1.0 support.
- [ ] v0.9.0 (Jul 2026): Social backup between devices with DKG (decentralized key generation).
- [ ] v0.10.0 (Aug 2027): WebAuthN + Roaming Credentials: Have a browser and a mobile with one Yubikey creating one and the same DID and replicating the same OrbitDB

Read more on Medium: [Bridging OrbitDB with Storacha: Decentralized Database Backups](https://medium.com/@akashjana663/bridging-orbitdb-with-storacha-decentralized-database-backups-44c7bee5c395)

## Installation

Install the package via npm:

```bash
npm install @le-space/orbitdb-storage-bridge
```

## Environment Setup

`STORACHA_KEY` and `STORACHA_PROOF` in `.env` are still what the code reads, and existing credentials still parse — but there is no longer a service to present them to, and no way to mint new ones: the console and the quickstart docs are gone (see [Status: Storacha sunset](#status-storacha-sunset-may-2026)). The test suite's in-memory modes run without credentials; see `test/README.md`.

## Demo

### NodeJS Demo Scripts (full backup with Manifest, Identity and AccessController and entries blocks)

They back up to Aleph by default, which takes an upload without an account, so
they run straight after cloning. `STORAGE=pinata` and `STORAGE=lighthouse`
switch to the paid services and read their keys from the environment — see
[`examples/storage.js`](examples/storage.js).

```sh
node examples/backup-demo.js                          # prints the backup's CID
BACKUP_CID=<cid> node examples/restore-demo.js        # restores it on a fresh node
```

- `node` [`examples/demo.js`](examples/demo.js) - Complete backup/restore cycle, including what stops the second node from writing
- `node` [`examples/backup-demo.js`](examples/backup-demo.js) - Backup only; prints the CID the restore needs
- `node` [`examples/restore-demo.js`](examples/restore-demo.js) - Restore from that CID onto a node that has never seen the database
- `node` [`examples/demo-different-identity.js`](examples/demo-different-identity.js) - Different identities with access control enforcement
- `node` [`examples/demo-shared-identities.js`](examples/demo-shared-identities.js) - Shared identity backup/restore scenarios

An Aleph upload is not kept: staying stored takes a wallet-signed STORE message
this library does not send, so restore what you back up while the demo is still
running.

The scripts written against Storacha's space and UCAN model are in
[`examples/storacha/`](examples/storacha/README.md). None of them runs end to
end since the uploads stopped, and the README there says what replaced each.

### In a browser: a database back on a device that has nothing

[**funkpost's recovery page**](https://nikrause.github.io/funkpost/recovery/) runs the whole
[recovery procedure](docs/RECOVERY-ON-A-SECOND-DEVICE.md) in a phone's browser, with a
security key and nothing else ([source](https://github.com/NiKrause/funkpost/tree/main/examples/recovery)):

1. **the key gives the identity** — the DID, and a signing key derived from its PRF output,
   the same on every device;
2. **a list** is made and written to;
3. **`dehydrate`** backs it up to Aleph as a CAR, and publishes an IPNS pointer under a name
   the key derives;
4. **on another device** — or the same one, wiped — the same key finds the pointer, **`hydrate`**
   brings the list back, and the list takes new entries, because the writer is the same.

On 21 September 2026 it ran that way on two phones: a Galaxy Fold 5 backed up and was reset,
and a Galaxy A57 with the same key brought the list back and wrote to it. The page says at
every step which service it contacts; the technical details sit behind one button.

### Svelte Components

For browser-based integration, this project includes Svelte components for authentication, backup/restore, P2P replication, and WebAuthn biometric authentication. See [**SVELTE-COMPONENTS.md**](SVELTE-COMPONENTS.md) for complete documentation of all available components and demonstrations.

That browser side is older than this repository's copy of it, and the UCAN delegation work now sits on a branch. [docs/STORACHA-UI-HISTORY.md](docs/STORACHA-UI-HISTORY.md) records what existed, what it could do, and where each piece is today.

## How It Works

1. **Extract Blocks** - Separates OrbitDB database into individual components (log entries, manifest, identities, access controls)
2. **Upload to Storacha** - Each block is uploaded separately to IPFS/Filecoin via Storacha
3. **Block Discovery** - Lists all files in Storacha space using Storacha SDK APIs
4. **CID Bridging** - Converts between Storacha CIDs (`bafkre*`) and OrbitDB CIDs (`zdpu*`)
5. **Reconstruct Database** - Reassembles blocks and opens database with original identity

## Restore Mechanism

The restore process uses a **ipfs-p2p-first approach with ipfs-http-gateway fallback** for downloading backups for restore. File listing and metadata discovery are currently performed via the Storacha SDK (using Storacha gateway API). We are working on an **IPNS-based mechanism** to find the latest heads blocks and OrbitDB address directly from the IPFS network via IPNS, eliminating the need to list all files via the centralized Storacha gateway API.

## Logging

The library uses **@libp2p/logger** for consistent logging across the libp2p ecosystem. Control logging with the `DEBUG` environment variable:

**Node.js:**
```bash
# Enable all logs from this library (the namespace kept its old name)
DEBUG=libp2p:orbitdb-storacha:* node your-script.js

# Enable specific components
DEBUG=libp2p:orbitdb-storacha:bridge node your-script.js

# Enable all libp2p logs (includes this library + libp2p internals)
DEBUG=libp2p:* node your-script.js
```

**Browser:**
```javascript
// In browser console or before loading the application
localStorage.setItem('debug', 'libp2p:orbitdb-storacha:*')
// Then refresh the page
```

The logger supports printf-style formatting:
- `%s` - string
- `%d` - number
- `%o` - object
- `%p` - peer ID
- `%b` - base58btc encoded data
- `%t` - base32 encoded data

## Testing

See `test/README.md` for detailed test documentation, modes (in-memory vs production),
and how to run each suite.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Submit a pull request

## License

MIT License
