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
| `aleph` | nothing | the only backend a browser can write to with no key; ingest only |
| `aleph-pin` | a wallet | the signed STORE message that makes Aleph keep it |
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

## Install

```bash
npm install @le-space/orbitdb-storage-bridge
```

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
| [docs/STORAGE-BACKENDS.md](docs/STORAGE-BACKENDS.md) | every backend evaluated — prices, limits, and what has been verified against a live account |
| [docs/RECOVERY-ON-A-SECOND-DEVICE.md](docs/RECOVERY-ON-A-SECOND-DEVICE.md) | the passkey recovery procedure, step by step |
| [docs/CAR-BACKUP.md](docs/CAR-BACKUP.md) | CAR-based timestamped backups |
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
