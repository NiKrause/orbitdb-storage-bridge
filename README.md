# OrbitDB Storage Bridge

> Back up, restore and replicate OrbitDB databases through pluggable storage backends, with hash and identity preservation.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org/)
[![CI/CD Pipeline](https://github.com/NiKrause/orbitdb-storage-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/NiKrause/orbitdb-storage-bridge/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@le-space/orbitdb-storage-bridge.svg)](https://www.npmjs.com/package/@le-space/orbitdb-storage-bridge)

> [!NOTE]
> Published as `orbitdb-storacha-bridge` up to 0.6.0 and as `@le-space/orbitdb-storage-bridge`
> from 0.7.0, because Storacha is no longer the only backend it bridges to. The rename changed no
> API — only the dependency and the import specifiers. Names that refer to Storacha itself stay as
> they are: `OrbitDBStorachaBridge`, `backends/storacha`, and the `libp2p:orbitdb-storacha:*` debug
> namespace.

## What it does

An OrbitDB database is a set of content-addressed blocks and a log whose heads tie them together.
This package moves those blocks somewhere else and brings them back with their CIDs and the
writer's identity intact — so a restored database is the same database, and its original author can
still write to it.

Where "somewhere else" is, is a choice:

| Backend | Needs | |
| --- | --- | --- |
| `aleph` | nothing; or `aleph-pin`'s pin, to keep in the same call | the only backend a browser can write to with no key; ingest only — nothing is kept, listed or deleted here, see `aleph-pin`. Since Aleph's IPFS hosts stopped taking uploads (2026-10-26) it uploads through an API node: up to 25 MiB with no key, up to 1 GiB with a pin that signs |
| `aleph-pin` | a signing key: the paying account's, or one it authorised | the signed STORE message that makes Aleph keep it, paid in credits — and the FORGET that releases it |
| `pinata` | a scoped JWT | pin-by-CID as well as CAR upload |
| `lighthouse` | an API key | pay once, stored in perpetuity |
| `memory` | nothing | in-process, for tests and demos |
| `mirror` | — | wraps others: one backup, several services |
| `encryption` | — | wraps one: the service holds ciphertext |

Reading back needs no account, because a CID is a name anyone can resolve: `peer-fetch` asks the
peers that hold the blocks over libp2p, `gateway-fetch` asks an HTTP gateway. Two more entry
points do not involve a storage service at all — `courier-sync` replicates over any byte courier
(a LoRa mesh, a QR relay, a file), and `dehydrate`/`hydrate` put a database where a second device
can find it from a passkey alone.

How the pieces fit, as sequence diagrams: a full backup with a delegate's STORE and the restore on
an empty device in [docs/APP-BACKUP.md](docs/APP-BACKUP.md), the increments between two backups in
[docs/LIVE-BACKUP.md](docs/LIVE-BACKUP.md), the FORGET in
[docs/STORAGE-BACKENDS.md](docs/STORAGE-BACKENDS.md#forgetting).

## Entry points

Every import path the package exports, and what it is for. New code uses the sub-paths; the main
entry is the Storacha-era class and the helpers it grew.

| Import (`@le-space/orbitdb-storage-bridge` + …) | What it is |
| --- | --- |
| `.` | `OrbitDBStorachaBridge` and the older helpers (`backupDatabase`, `restoreDatabase`, `analyzeBlocks`, `extractManifestCID`); Storacha itself loads only when a Storacha path is called |
| `/backup-car` | `createCARFromBlocks`, `readBlocksFromCAR`, `backupDatabaseCAR` — the CAR every backup is ([docs/CAR-BACKUP.md](docs/CAR-BACKUP.md)) |
| `/restore-cid` | `restoreFromCID`, `restoreFromBlocks`: a database back from a CID, or from blocks verified one by one |
| `/extract-blocks` | `extractDatabaseBlocks`, `bundleDatabases`: one database's blocks, or several databases' in one bundle |
| `/app-backup` | one sealed file for an application: `buildAppBackup`, `openAppBackup`, `restoreAppBackup`, `readAppBackupHeader`, `isAppBackup` |
| `/live-backup` | increments: `createLiveBackup`, `collectIncrement`, `readIncrement`, `mergeIncrements`, `restoreFromIncrements`, `joinIncrements` |
| `/dehydrate` | `dehydrate`, `hydrate`: a database where a second device finds it from a secret alone |
| `/pointer-ipns` | `publishPointer`, `resolvePointer`: the IPNS pointer `dehydrate` publishes, under a name derived from a seed |
| `/gateway-fetch` | `fetchFromGateways`: bytes by CID over HTTP, verified against the CID |
| `/peer-fetch` | `createPeerFetch`, `createGatewayFirstFetch`: bytes by CID from the peers that hold them, over libp2p |
| `/courier-sync` | `createCourierSync`: replication over any byte courier — a LoRa mesh, a QR relay, a file |
| `/memory-courier` | `createMemoryCourierPair`: the in-process courier for tests and demos |
| `/backends/types` | the contract: `defineBackend`, `BackendError`, the capability flags |
| `/backends/memory` | the in-process driver |
| `/backends/aleph` | `createAlephBackend`: ingest to Aleph – its IPFS host, else an API node – with no key, or with `aleph-pin`'s pin to keep in the same call; `onProgress` for the upload |
| `/backends/aleph-pin` | `createAlephPin`, `createAlephAuthorizer`, `listAlephStores`, `waitForMessage`, `createAlephForget`, `forgetAlephStores`: what makes Aleph keep a file, and lets it go |
| `/backends/aleph-upload` | `unixfsCid`: the CID Aleph gives a file, before the upload; `postFile`, the limits and the upload errors |
| `/backends/pinata` | Pinata: pin by CID or upload, with a scoped JWT; `remove()` by file id |
| `/backends/lighthouse` | Lighthouse: upload with an API key; `list()` and `remove()` |
| `/backends/storacha` | the Storacha driver; needs the optional peer `@storacha/client`, and a service that no longer answers |
| `/backends/mirror` | one backup to several backends |
| `/backends/encryption` | `withEncryption`: the service holds ciphertext |
| `/backends/choose` | `createBackendFromChoice`: a backend from a name and a key, for a page's form |
| `/backends/resolve` | `resolveBackend`: the options-to-backend step the older functions share |
| `/storacha-backup`, `/components/*` | the JavaScript of the old browser widget: `storacha-backup.js`, `WebAuthnDIDProvider.js`, `theme.js`. The two `.svelte` components were dropped — they imported four files no release ever contained ([docs/STORACHA-UI-HISTORY.md](docs/STORACHA-UI-HISTORY.md)) |

## Install

```bash
npm install @le-space/orbitdb-storage-bridge
```

That brings Aleph, Pinata, Lighthouse and the in-memory driver. The Storacha driver
(`backends/storacha`, the `OrbitDBStorachaBridge` class) needs `@storacha/client`, an optional
peer dependency since 0.22.0 — the service shut down on 2026-05-15, and 28 packages for a backend
nobody can reach were not worth every install. `npm install @storacha/client` puts them back.

## Quick start

The demos back up to Aleph, which accepts an upload without an account, so they run straight after
cloning:

```sh
node examples/backup-demo.js                     # prints the backup's CID
BACKUP_CID=<cid> node examples/restore-demo.js   # restores it on a node that has never seen it
```

`STORAGE=pinata` and `STORAGE=lighthouse` switch backends and read their keys from the environment
— see [`examples/storage.js`](examples/storage.js). An Aleph upload is not retained without the
signed STORE message, so restore what you back up while the demo is still running.

Further scripts: identity and access-control scenarios in [`examples/`](examples/), and the
Storacha-era scripts in [`examples/storacha/`](examples/storacha/README.md), none of which runs end
to end any more.

## Recovery on a second device

[The recovery page](https://nikrause.github.io/orbitdb-storage-bridge/recovery/) runs the whole
procedure in a phone's browser with a security key and nothing else: the passkey gives the
identity, `dehydrate` backs the database up and publishes an IPNS pointer under a name derived from
the key, and on another device the same key finds that pointer — so `hydrate` needs no CID, no
address and no file. The restored database takes new entries, because the writer is the same.

On 21 September 2026 it ran that way on two phones: a Galaxy Fold 5 backed up and was reset, and a
Galaxy A57 with the same key brought the database back and wrote to it. Source:
[`examples/svelte/recovery/`](examples/svelte/recovery).

## Documentation

| | |
| --- | --- |
| [docs/DESIGN.md](docs/DESIGN.md) | the problem this solves, and how a backup and a restore actually work |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | the package from the inside: what the modules under `lib/` are allowed to import, what is loaded late and why, and how to re-derive the graph |
| [docs/STORAGE-BACKENDS.md](docs/STORAGE-BACKENDS.md) | every backend evaluated — prices, limits, and what has been verified against a live account |
| [docs/RECOVERY-ON-A-SECOND-DEVICE.md](docs/RECOVERY-ON-A-SECOND-DEVICE.md) | the passkey recovery procedure, step by step |
| [docs/CAR-BACKUP.md](docs/CAR-BACKUP.md) | the CAR as the unit of every backup, and the Storacha-era timestamped listing |
| [docs/APP-BACKUP.md](docs/APP-BACKUP.md) | an application's backup in one sealed file: several databases, a keyring header, kept on Aleph from the browser, restored by merging |
| [docs/LIVE-BACKUP.md](docs/LIVE-BACKUP.md) | increments between two full backups: what was written since the last one, shipped as one small CAR, with nobody clicking and no peer online |
| [SVELTE-COMPONENTS.md](SVELTE-COMPONENTS.md) | the browser components — older than this repository's copy of them; [docs/STORACHA-UI-HISTORY.md](docs/STORACHA-UI-HISTORY.md) records what each piece could do and where it went |
| [docs/LOGGING.md](docs/LOGGING.md) | debug namespaces, in Node and in a browser |
| [ROADMAP.md](ROADMAP.md) | what is planned |
| [docs/STORACHA-SUNSET.md](docs/STORACHA-SUNSET.md) | why Storacha stopped being the default, with dates and evidence |
| [test/README.md](test/README.md) | the suites, and which of them need credentials |

`examples/browser/storage-probe/` is a static page that asks these services from a real browser
with no build step: whether they answer a page at all, whether their CORS survives a refusal as
well as a success, and whether anyone on IPFS holds a given CID at an address a browser can dial.

## Contributing

Fork, branch, add tests for new behaviour, open a pull request.

## License

MIT.

LoRa® is a trademark of Semtech Corporation and Meshtastic® a registered trademark of Meshtastic
LLC; OrbitDB, IPFS, Filecoin, Storacha, Pinata, Lighthouse and Aleph belong to their respective
owners and appear here only to say what this package interoperates with. This project is
affiliated with none of them and contains no code from the Meshtastic libraries, which are
GPL-3.0-only — see [docs/TRADEMARKS.md](docs/TRADEMARKS.md) for why that line matters and which
side of it this package is on.
