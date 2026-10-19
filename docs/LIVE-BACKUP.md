# Live backup: increments between two full backups

A full backup (`bundleDatabases`, `buildAppBackup`) is the baseline and stays one. This is what
happens between two of them: what was written since the last increment goes out as one small CAR,
soon after it was written, with nobody clicking "back up" and no other peer online. Design and the
questions it had to settle: [#144](https://github.com/NiKrause/orbitdb-storage-bridge/issues/144).

```js
import { createLiveBackup } from "@le-space/orbitdb-storage-bridge/live-backup";
```

## Write-behind, never write-through

A local write never waits for the network. The watcher remembers, per database, the heads it last
shipped. A flush walks from the current heads back over `next` until it meets an entry it has already
shipped; everything it passed is the increment. Entries that arrived by replication from another
device are reachable from the heads like any other, so they ship too.

What has to survive a restart is tiny: a sequence number and a few hashes per database. The set of
shipped hashes is kept in memory and, after a restart, rebuilt once by walking the log from the
persisted heads. A crash between "written" and "shipped" loses nothing: the next flush finds the entry
where it left it.

## One upload, one STORE

An increment is one CAR. Its root is a dag-cbor manifest:

```
{ kind: "increment", v: 1, sequence, base, previous, createdAt, metadata }
```

- `sequence` counts from 1 after the base; `base` is whatever the caller called the full backup
  (`rebase({ base })`), or `null`; `previous` is the backend's id of the increment before.
- `metadata` is the shape `restoreFromBlocks` reads: every database with `address`, `name`, `type`,
  `manifestCID`, its `heads` now, the `since` heads it continues from, and `entries`, how many it
  holds. Databases given by name carry their `collection`.

Every increment also carries each database's manifest and access controller (a few hundred bytes)
and the identity of every writer it has entries from. So a chain of increments restores on its own
when it is complete from the beginning, and `restoreFromBlocks` can verify each one the way it
verifies a backup.

The CAR goes through any `StorageBackend`'s `putBlob`. A backend whose handle says
`retained: false` — Aleph, where an upload is ingest and keeping is a STORE — is then asked to keep
it with `pinCid`. Sealing is the caller's, through `withEncryption` around the backend; nothing here
changes for it.

### What a flush does

```mermaid
sequenceDiagram
    autonumber
    participant App as Application
    participant DB as OrbitDB database<br/>(events, log)
    participant LB as live-backup<br/>createLiveBackup
    participant St as state store<br/>{ load, save }
    participant CI as collectIncrement
    participant Enc as withEncryption(backend)
    participant AL as backends/aleph
    participant Ingest as ipfs.aleph.cloud<br/>/api/v0/add
    participant Pin as aleph-pin pin()
    participant API as api2.aleph.im

    App->>LB: createLiveBackup({ databases, backend, after, settle, every, state, blocks?, keep: true })
    LB->>DB: events.on("update")
    App->>LB: start()
    LB->>St: load() → { v, sequence, base, previous, databases[address].heads }
    LB->>DB: walk the log once from the persisted heads → the set of shipped hashes
    Note over LB: with `after` or `every` set, one flush is scheduled after `settle`, so a backlog ships

    App->>DB: put / add — never waits
    DB-->>LB: "update" → pending++
    alt pending >= after
        LB->>LB: one timer, fires `settle` ms after the last update
    else every > 0
        LB->>LB: a timer every `every` ms flushes while something is pending
    end

    LB->>LB: flush() — one in flight; a second request runs after it
    LB->>App: blocks() — the application's own blocks, optional
    LB->>CI: collectIncrement(watched, { sequence: s+1, base, previous, blocks })
    loop each watched database
        CI->>DB: log.heads(), then log.get(hash) back over `next` until a shipped hash
        CI->>DB: the manifest, the access controller, each new entry, each writer's identity
    end
    CI-->>LB: { blocks, manifest { kind: "increment", v: 1, sequence, base, previous, createdAt, metadata }, root } | null
    LB->>LB: createCARFromBlocks(blocks, root)
    LB->>Enc: putBlob(car, { name: "increment-000001-<time>.car" })
    Enc->>AL: putBlob(OSBE envelope)
    AL->>Ingest: POST /api/v0/add
    Ingest-->>AL: { Hash }
    AL-->>LB: handle { id, retained: false }
    opt keep && handle.retained === false && backend.pinCid
        LB->>AL: pinCid(handle.id, { name })
        AL->>Pin: pin(cid) → STORE signed, with `ref` if the pin was given one
        Pin->>API: POST /api/v0/messages { message, sync: true }
        API-->>Pin: { message_status: processed | pending }
        Pin-->>LB: kept { itemHash, status }
        LB->>App: confirm(kept, handle) — optional; a settled "rejected" fails the flush
    end
    LB->>LB: sequence = s+1, previous = handle.id, heads per database, shipped ∪= hashes
    LB->>St: save(state) — plain JSON
    LB-->>App: onShipped({ sequence, handle, kept?, entries, blocks, bytes, at })
    Note over LB,API: on any throw: failures++, lastError, onError(error); the state is untouched, so the next flush ships everything still pending
```

## Watching

```js
import { createLiveBackup } from "@le-space/orbitdb-storage-bridge/live-backup";
import { createAlephBackend } from "@le-space/orbitdb-storage-bridge/backends/aleph";
import { withEncryption } from "@le-space/orbitdb-storage-bridge/backends/encryption";

const live = createLiveBackup({
  databases: { todos, settings }, // open OrbitDB databases, by name or as a list
  backend: withEncryption(createAlephBackend({ pin }), { encrypt, decrypt }),
  after: 1, // flush once this many updates are pending …
  settle: 2000, // … and this long after the last of them, so a burst is one increment
  every: 60_000, // and at least this often while something is pending
  state: {
    // what survives a restart: a sequence number and a few hashes per database
    load: async () => JSON.parse(localStorage.getItem("live-backup") ?? "null"),
    save: async (state) =>
      localStorage.setItem("live-backup", JSON.stringify(state)),
  },
  onShipped: ({ sequence, handle, kept, entries, bytes, at }) => {},
  onError: (error) => {},
});
await live.start();
```

- `start()` schedules one flush after `settle` when `after` or `every` is set, so whatever was
  written before the watcher came — after a restart, or before the archive was switched on — goes
  out; with neither trigger, call `flush()` yourself.
- `confirm`: `(kept, handle) => kept`, to follow a backend's answer
  before the increment counts as shipped. Aleph says `pending` first and may reject later; a
  settled `status: "rejected"` fails the flush and the state stays.
- `close()` stops and detaches from every database; `status()` also reports `watched`.
- `watch(database, collection?)` and `unwatch(database)` add and remove databases while running.
- `flush()` ships what is pending now and resolves with what went out, or `null` when nothing was
  new. One flush at a time; a flush asked for during one runs after it.
- `rebase({ base })` after a full backup: everything now in the databases counts as shipped, and the
  increments start again at 1 from that base. `rebase()` without a base, after a restore joined into
  the open databases: what came back is not sent out again, and the numbering carries on.
- `status()`: `sequence`, `base`, `previous`, `pending` updates, `lastShipped`, `lastError`,
  `failures`, `running`.
- `blocks` is a function (or a Map) of blocks of the application's own to carry in the next
  increment — receipt files, for an application that keeps them beside its databases.
- `name`: `(sequence, at) => string` names the blob; the default is
  `increment-000001-<time>.car`, the sequence padded to six digits.
- The persisted state is `{ v, sequence, base, previous, databases: { [address]: { heads } } }`,
  with `v` = `LIVE_BACKUP_STATE_VERSION` (1). A state written by another version is refused, with
  a message that says to upgrade, or to clear it and `rebase`.
- `collectIncrement(watched, { sequence, base, previous, blocks })` is exported for a caller that
  ships by other means: it returns the blocks, the manifest and the root, or `null`.
- `stop({ flush: true })` ships once more before stopping.

## When the backend is unreachable

The flush fails, `onError` hears it, and the state stays as it was: the next flush ships everything
that is still pending, so the increment grows rather than anything being lost. `status()` says how
many updates are waiting and what the last failure was, so an application can show "last backed up
…" and mean it.

## Several chains on one account

Each watcher numbers its own increments from 1. Two databases on one account, or two devices
writing the same database, therefore produce chains whose sequence numbers collide, and a listing
of the whole account mixes them. On Aleph give every chain its own `ref` (`createAlephPin({ ref })`;
a per-database fingerprint, not the address) and list, restore and forget by it
(`listAlephStores({ ref })`, `forgetAlephStores({ ref })`). Where devices still collide,
`joinIncrements`/`restoreFromIncrements` with `allowGaps: true` join everything — OrbitDB's join is a
merge, and a duplicate sequence costs nothing — and return `gaps` and `duplicates` so the
application can say so. A gap is still worth a word to the user: an increment the store does not
hold is entries nobody has.

## Restoring

```js
import {
  readIncrement,
  restoreFromIncrements,
} from "@le-space/orbitdb-storage-bridge/live-backup";

const increments = [];
for (const handle of handles)
  increments.push(await readIncrement(await backend.getBlob(handle)));
await restoreFromIncrements(orbitdb, {
  base,
  increments,
  open: { encryption },
});
```

- `readIncrement(bytes)` checks every block against its CID and finds the manifest; it refuses a
  CAR that is not an increment, and one written in a format this build does not read.
- `mergeIncrements` joins **every** source's heads (a stale head costs nothing; a branch only an
  older increment saw is kept) and names `gaps` and `duplicates` in the sequence. A chain with
  either is refused by `restoreFromIncrements` and `joinIncrements` unless `allowGaps: true`.
- The sealed path refuses plaintext: `withEncryption` hands back only envelopes it can open
  (`allowPlaintextReads` is off since 0.19.0), so a store or gateway cannot hand a sealed archive
  a plaintext list of another database.
- `base` is optional: what `bundleDatabases` or `openAppBackup` returned (`{ metadata | manifest,
blocks }`). Increments are ordered by `sequence`; for each database the heads of the newest
  source that names it are joined. `mergeIncrements` does the folding alone, for a caller that
  restores by other means.
- Joining merges: what is in the node stays, what the increments hold is added. A head whose entries
  are missing — an increment skipped in the middle — is reported by `restoreFromBlocks` as a head
  that could not be joined.

The whole path from an empty device, the listing on Aleph included, is the second diagram in
[APP-BACKUP.md](APP-BACKUP.md#the-restore-both-shapes); its lower branch is this section.

### Into a database that stays open

`restoreFromIncrements` reopens the database, as `restoreFromBlocks` does, and an application holding
the old instance is left with a closed one. `joinIncrements(database, { base, increments })` is for
books that are open on screen: the blocks go into the log's storage and each head is joined on the
instance the application already holds. Joining merges; the application reloads its view afterwards.

```js
const { joined, heads } = await joinIncrements(todos, {
  increments,
  blockstore: orbitdb.ipfs.blockstore,
});
await live.rebase(); // what came back is not shipped again
```

`blockstore` is where the application's own (non-dag-cbor) blocks go; without it they are counted
in `skippedRaw` and left out, since OrbitDB's log storage does not take them.

## What it costs on Aleph

One upload and one STORE per increment, paid in credits for the file's size (about 54 credits per
MiB and day, [STORAGE-BACKENDS.md](STORAGE-BACKENDS.md) §6). An OrbitDB entry is a few hundred
bytes, so an increment of a working day is a few kilobytes — but a STORE exists per increment, and
each one needs its own FORGET when a later full backup makes it redundant. `after` and `settle`
decide how many increments a day becomes; a full backup now and then, followed by `rebase`, is what
keeps the chain short.

## Deleting an archive on Aleph

Increments never go away by themselves: each is a STORE the account pays for by the hour. After a
full backup, or when an archive is given up, the account forgets them:

```js
import {
  createAlephForget,
  forgetAlephStores,
} from "@le-space/orbitdb-storage-bridge/backends/aleph-pin";

const forget = createAlephForget({
  sender: address,
  sign,
  channel: "SIMPLE-TODO-ARCHIVED01",
});
const { forgotten, kept, rejected, pending, failed } = await forgetAlephStores({
  owner: address,
  channel: "SIMPLE-TODO-ARCHIVED01",
  forget,
  keep: (store) => store.cid === newestFullBackup, // optional
  reason: "archive deleted by its owner",
});
```

`forgotten` holds only what Aleph confirmed; `pending` what it had not decided in time (follow the
FORGET's item hash with `waitForMessage`); `failed` a batch that could not be sent. A FORGET is the
account's, not the blob's: the driver's `remove` stays unsupported, and a forgotten STORE cannot be
brought back — the file has to be stored again. Pinata, Lighthouse and the in-process
driver delete through their `remove`. The message flow, pagination and the four outcomes:
[STORAGE-BACKENDS.md](STORAGE-BACKENDS.md#forgetting).

## What it does not do

- It does not write through: no local write waits for a service. That is the point.
- It does not fetch: a block this node does not have is not in the increment, and the walk stops at
  what `log.get` cannot read.
- It does not forget by itself: compaction after a full backup is the application's call —
  `forgetAlephStores` with `keep` sparing the new base, in the section above.
