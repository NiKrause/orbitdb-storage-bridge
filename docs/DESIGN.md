# Design: the problem, and how a backup and a restore work

Moved out of the README, and corrected where it had gone stale: the numbered walkthrough it
replaced described uploading each block to Storacha and listing a Storacha space, which is neither
how this works now nor possible.

## The problem

In a local-first application built on OrbitDB, data replicates across the peers that participate,
over libp2p. Under good conditions that is its own redundancy — a peer that loses data resynchronises
from a peer that has it. The gap is what happens when no such peer is reachable: at the same moment,
or at all.

Two shapes of that gap matter here.

**Nobody is there right now.** Peer-to-peer replication needs both ends online. A device that has
been off for a month, or a collaborator in another timezone, has no peer to ask. A copy that does not
have to be online is the answer, and that is what a storage backend is.

**Nobody is there any more.** Selective replication is what makes local-first scale: users keep their
own data and replicate with the specific peers they collaborate with, not with a whole network. The
cost is that a database's survival depends on a small number of devices. When a blog database has
accumulated years of posts, replication time grows with it, and archival stops being optional.

## Use cases

1. **Long-term archival** — move a large database's history to a storage backend, keeping fast
   replication for the part still in use.
2. **Disaster recovery** — bring a database back when no peer has it, under the original identity or
   a new one. [RECOVERY-ON-A-SECOND-DEVICE.md](RECOVERY-ON-A-SECOND-DEVICE.md) does this from a
   passkey alone, with no CID to carry.
3. **Network resilience** — corporate networks, ISPs and regional filtering have all blocked WebRTC
   and WebSocket transports. libp2p has fallbacks, and a restore path that is only an HTTP fetch or a
   CID on IPFS is another one. `courier-sync` goes further: replication over any byte courier, down to
   a LoRa mesh with no IP path at all.
4. **Access control and delegation** — the Storacha era used UCAN for time-bound, delegable access.
   What the current backends offer instead is compared in
   [STORAGE-BACKENDS.md](STORAGE-BACKENDS.md); Pinata's presigned upload URLs are the closest thing
   still shipping.

## How a backup works

1. **Extract the blocks.** A database is separated into its parts: log entries, the manifest, the
   identity blocks of every writer, and the access controller. Without the manifest and the access
   controller a peer cannot open the address at all, so first contact carries them.
2. **Pack a CAR.** The blocks go into one Content Addressed Archive, which is the default. This is
   the load-bearing decision: the backend sees a single opaque blob, so nothing it does with
   chunking or codecs can change the CIDs inside it. The alternative — one upload per block — only
   works on a backend that stores the bytes it is given under the CID we computed, and requires it
   to accept objects as small as an OrbitDB entry. `chooseBackupStrategy` asks the backend rather
   than guessing.
3. **Hand it to the backend.** `putBlob` for the CAR and its metadata; `pinCid` where the backend
   can fetch from IPFS itself, which moves no bytes through a vendor API at all.

## How a restore works

1. **Find the backup.** A CID, an IPNS pointer derived from a secret ([`dehydrate`](../lib/dehydrate.js)),
   or a listing from the backend where it offers one.
2. **Fetch the bytes, peers first.** [`peer-fetch.js`](../lib/peer-fetch.js) dials the providers that
   hold the blocks over libp2p — measured from a real page on 2026-09-23 at 0.73 s to dial and 0.26 s
   for the block, with no credential in the path. [`gateway-fetch.js`](../lib/gateway-fetch.js) is the
   HTTP half, defaulting to `ipfs.aleph.cloud` with `trustless-gateway.link` for verifiable
   single-block requests.

   This order is not a preference. On **2026-09-21** Protocol Labs retired `ipfs.io` and `dweb.link`,
   and every fallback list in this package turned out to be one live entry and a dead tail — so
   asking the peers that actually hold the data replaced hoping a host answers. See
   [STORACHA-SUNSET.md](STORACHA-SUNSET.md).
3. **Verify, then join.** Every block is checked against its own hash — `CarReader` does not do this,
   which is why we do — put into the blockstore, and only then are the heads joined. The check that
   the delta is closed consults the delta and the log's index, never raw block storage, whose `get`
   waits out a network timeout per miss against a network that may not be there.
4. **Open under the original identity.** The identity blocks travelled with the entries that
   reference them, so the restored database recognises its original author and accepts new writes
   from them.

## Why hash preservation is the whole point

A backup that comes back under different CIDs is a copy, not the same database: the log's links do
not resolve, the access controller does not recognise the writer, and peers treat it as a stranger.
Everything above — the CAR, the per-block verification, the identity blocks — exists so that a
restored database *is* the one that was backed up. The conformance suite in `test/backends/` asks
every backend that one question before any other.
