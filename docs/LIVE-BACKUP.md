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
    save: async (state) => localStorage.setItem("live-backup", JSON.stringify(state)),
  },
  onShipped: ({ sequence, handle, kept, entries, bytes, at }) => {},
  onError: (error) => {},
});
await live.start();
```

- `start()` ships, after `settle`, whatever was written before the watcher came — after a restart,
  or before the archive was switched on — and nothing if there is nothing.
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
- `stop({ flush: true })` ships once more before stopping.

## When the backend is unreachable

The flush fails, `onError` hears it, and the state stays as it was: the next flush ships everything
that is still pending, so the increment grows rather than anything being lost. `status()` says how
many updates are waiting and what the last failure was, so an application can show "last backed up
…" and mean it.

## Restoring

```js
import { readIncrement, restoreFromIncrements } from "@le-space/orbitdb-storage-bridge/live-backup";

const increments = [];
for (const handle of handles) increments.push(await readIncrement(await backend.getBlob(handle)));
await restoreFromIncrements(orbitdb, { base, increments, open: { encryption } });
```

- `readIncrement(bytes)` checks every block against its CID and finds the manifest; it refuses a
  CAR that is not an increment, and one written in a format this build does not read.
- `base` is optional: what `bundleDatabases` or `openAppBackup` returned (`{ metadata | manifest,
  blocks }`). Increments are ordered by `sequence`; for each database the heads of the newest
  source that names it are joined. `mergeIncrements` does the folding alone, for a caller that
  restores by other means.
- Joining merges: what is in the node stays, what the increments hold is added. A head whose entries
  are missing — an increment skipped in the middle — is reported by `restoreFromBlocks` as a head
  that could not be joined.

### Into a database that stays open

`restoreFromIncrements` reopens the database, as `restoreFromBlocks` does, and an application holding
the old instance is left with a closed one. `joinIncrements(database, { base, increments })` is for
books that are open on screen: the blocks go into the log's storage and each head is joined on the
instance the application already holds. Joining merges; the application reloads its view afterwards.

```js
const { joined, heads } = await joinIncrements(todos, { increments });
```

## What it costs on Aleph

One upload and one STORE per increment, paid in credits for the file's size (about 54 credits per
MiB and day, [STORAGE-BACKENDS.md](STORAGE-BACKENDS.md) §6). An OrbitDB entry is a few hundred
bytes, so an increment of a working day is a few kilobytes — but a STORE exists per increment, and
each one needs its own FORGET when a later full backup makes it redundant. `after` and `settle`
decide how many increments a day becomes; a full backup now and then, followed by `rebase`, is what
keeps the chain short.

## What it does not do

- It does not write through: no local write waits for a service. That is the point.
- It does not fetch: a block this node does not have is not in the increment, and the walk stops at
  what `log.get` cannot read.
- It does not forget: compaction after a full backup — the FORGET messages for the increments before
  it — is the application's, since it knows which account holds them.
