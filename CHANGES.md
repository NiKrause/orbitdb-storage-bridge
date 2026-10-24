# Changes

## Unreleased

### Added

- **A second source for a head the backup does not carry.** `restoreFromBlocks` takes `fetchBytes`:
  anything that returns bytes for a CID, such as `fetchFromGateways` bound to the gateways an
  application is willing to ask. It is off by default — a restore that reaches the network unasked
  is not something an offline-first application can allow — and whatever comes back is checked
  against the CID that asked for it before it is believed, so a gateway is a convenience here and
  never a party to trust.

### Fixed

- **A head the blocks lack is named instead of dropped.** `headFrom` returned `null` for a head the
  backup did not carry and `.filter(Boolean)` threw it away, so a backup missing one came back
  "restored" with nothing joined and no complaint. `restoreFromBlocks` now returns `missingHeads`.
  Not an exception: a caller may know the database is reachable another way. Never silence either.

### Changed

- `beforeJoin` now runs after the second source has been asked, not before. Asking can fail, and a
  caller's books should not already be shut when it does — the same reason the storing pass throws
  before `beforeJoin` rather than after.
- `TRUSTLESS_GATEWAYS` no longer names `trustless-gateway.link`. Measured 2026-10-24 it answers
  `525` to everything, path and trustless alike, so it has followed `ipfs.io` and `dweb.link`
  (`429`, `sunset: Mon, 21 Sep 2026`) out. Aleph's gateway takes its place: it honours
  `accept: application/vnd.ipld.raw`, sets the content type to match, and answered in 0.15 s with
  CORS `*`. The constant is only ever a default; the hash check is what makes an answer usable.

## 0.24.0 (2026-10-23)

### Fixed

- **A browser restore no longer writes the whole backup once per block.** `CarReader` hands out each
  block as a view into the single `ArrayBuffer` the CAR lives in, and IndexedDB's structured clone
  persists _the buffer behind a view_, not the view. So restoring a 3.7 MB backup of 2 016 blocks
  asked the browser for 3.7 MB per block — about 7.5 GB — and it refused everything past roughly
  block 500 with `QuotaExceededError`. Reproduced outside any application: 2 016 blocks written as
  standalone copies cost 4 MB and all went in; the same bytes written as views into one buffer cost
  1 862 MB and stopped at block 494. `readBlocksFromCAR` now hands out bytes that own their buffer,
  and the three places that write bytes to storage copy a view before doing so. This is why 500
  bookings restored and 2 000 never did: not a size cliff, a ceiling at about 500 blocks (#152).
- **A restore that cannot store its blocks now says so, instead of failing two minutes later about
  something else.** `restoreFromBlocks` put every block into the blockstore, warned about the ones
  that would not go in, and carried on. A browser whose storage quota is spent refuses most of them,
  the log then looks for heads that are not there, waits each one out on the network — about twenty
  seconds per head, with no peer to answer — and ends with `Entry's id (undefined) doesn't match the
log's id`, which names neither the cause nor the remedy. It now throws `BlocksNotStoredError`
  immediately, carrying `stored`, `total` and the first few refusals. Measured in Le-Space/belege's
  recovery bench: a 3.7 MB backup of 2 016 blocks, of which the browser took 516 before every
  further write failed with `QuotaExceededError` (#152).

### Added

- `restoreFromBlocks` takes `beforeJoin`: a callback run once every block is in the blockstore and
  before any database is opened. An application that must close its own handles for the restore —
  belege closes its books — had to do it before calling, and so closed them for restores that then
  refused to start. The refusal now happens first, with the application's databases untouched.

## 0.23.0 (2026-10-23)

### Fixed

- **A restore no longer writes every block into every database.** `restoreFromBlocks` put each block
  of the backup into the Helia blockstore — once, correctly — and then, for each database in the
  metadata, walked the whole block map again and put every block into that database's `log.storage`.
  That storage reads through to the same blockstore, so the copies were redundant: 2 000 entries in
  nine databases meant 18 099 writes where 2 011 blocks exist. In Node those writes are cheap; in a
  browser each is an IndexedDB transaction. An entry names its database in `id`, so each block now
  reaches one log storage instead of all of them, and a database that gets none is no longer closed
  and reopened for nothing. Measured in Le-Space/belege's recovery bench, same machine and data:
  500 bookings 41.4 s → 17.1 s, 50 bookings 1.9 s → 0.8 s, nothing lost (#152, #168).
- **`joinIncrements` did the same, one level up.** It wrote every dag-cbor block of the merged chain
  into the one database it was handed, so an application joining nine databases wrote all of their
  entries nine times — the path incremental backups take. It now skips an entry that names another
  database. Blocks that are not entries — the manifest, the access controller, an identity — still go
  in: unlike `restoreFromBlocks` this function has no pass that fills the blockstore first (#170).

### Changed

- `joinIncrements` reports `skippedForeign` when a chain carried entries for other databases.
- `entryDatabaseId` is exported from `restore-cid.js`: the decision "whose entry is this" now has one
  answer that both restore paths read.

### Testing

- The control test in `backup-bundle.test.js` guards again — it asserted a static Storacha import the
  0.22.0 work had removed, and failed on `main` unnoticed because no workflow ran that file. The
  suites that ran in no job now run in CI (#169).

## 0.22.1 (2026-10-20)

### Fixed

- **The Storacha driver no longer breaks a consumer's bundle.** 0.22.0 made `@storacha/client` an
  optional peer and loaded it lazily in the main entry, but `backends/storacha.js` still imported it
  statically — and `resolve.js` reaches that driver by `import()`, which Vite and Rollup follow into a
  chunk and type-check at build time. An application without the package failed to build with
  `"Signer" is not exported by "__vite-optional-peer-dep:@storacha/client/…"` (Le-Space/belege, on
  `app-backup`). The client is now imported in one place only, `lib/storacha-client.js`,
  dynamically; the driver and the main entry call it on first use, and
  `test/no-static-storacha-import.test.js` fails the suite if a static import comes back. Verified
  with a Vite build of `app-backup`, `live-backup`, `backup-car` and `aleph-pin` against the packed
  tarball with no Storacha package installed.

## 0.22.0 (2026-10-19)

### Changed, and worth reading before upgrading

- **`@storacha/client` is an optional peer dependency.** `npm install` no longer brings the 28
  `@storacha/*`, `@ucanto/*` and `@web3-storage/*` packages; the service shut down on 2026-05-15 and
  every other backend reached the network without them. The main entry no longer imports the client
  at load time: `initializeStorachaClient` loads it on first use and, when it is missing, fails with
  a message that names the package. `backends/storacha` still imports it statically and needs it
  installed. Everything else — Aleph, Pinata, Lighthouse, live backup, app backup, restore — is
  unchanged.
- `@storacha/capabilities`, `@ipld/dag-ucan` and `dotenv` were dependencies that only tests and
  examples used; they are devDependencies now. `lib/backup.js`, a Storacha-era placeholder that
  nothing imported, is gone.
- `exports["."].types` pointed at a `.d.ts` that was never built or published; the field is removed
  rather than promising TypeScript consumers a file they never got.
- Lockfile: `shell-quote` 1.12.0 (GHSA-pqg4-j6r4-53mv, the one critical advisory) and `devalue` 5.9.4,
  both within their declared ranges. `npm audit --omit=dev` goes from 20 to 18, the rest being the
  `helia → @libp2p/webrtc@6 → react-native-webrtc → react-native → metro` chain (7 advisories, code
  that never loads outside React Native; `@libp2p/webrtc` 7 made it an optional peer, and the
  chain ends when Helia moves to it), `node-forge` behind AutoTLS and `braces` behind `it-glob`.

### Added

- **A secret scan in CI.** The `secrets` job runs gitleaks 8.30.1 (binary pinned by checksum) over
  the whole history on every push, pull request and nightly run. `.gitleaks.toml` allows, by hash,
  the ten Storacha-era commits that carry a dead principal (`recipient-key.txt`, v0.1.15 .. v0.17.0,
  found in the 2026-10-16 audit) and says why the tags were not rewritten; any other secret fails the
  build.

## 0.21.0 (2026-10-17)

### Added

- **A `ref` on Aleph STOREs** (`buildStoreMessage({ ref })`, `createAlephPin({ ref })`, and
  `meta.ref` on one call): Aleph's free-text label on a STORE, which the messages API filters by.
  `listAlephStores({ ref })` asks with `refs=` and keeps only STOREs carrying it; `forgetAlephStores({
ref })` forgets one chain and no other. An application can now keep several chains on one account
  and channel — the increments of one database, one per device — and list one of them without
  downloading anything. What the label discloses is the caller's choice; a derived fingerprint rather
  than an address keeps the store from learning which database it is.
- `restoreFromIncrements` and `joinIncrements` return `gaps` and `duplicates` (sequence numbers), so
  a caller that joined with `allowGaps` can say what the chain looked like instead of guessing.

## 0.20.0 (2026-10-17)

### Changed, and worth reading before upgrading

- **A sealed restore refuses plaintext.** `withEncryption` and `decryptingFetch` default
  `allowPlaintextReads` to `false`: a caller that brings a key expects ciphertext, and whoever
  answers the fetch — gateway, service, network — could otherwise hand it a plaintext backup of
  _another_ database, which it would open and join (found in the 2026-10-16 audit). A backup
  written before encryption is read with `allowPlaintextReads: true`, for that one restore, and
  the acceptance is logged; `hydrate()` takes it as `restore.allowPlaintextReads`.
- **A gateway's answer to a raw sha-256 CID is hashed** (`fetchFromGateways`, `matchesRawCid`):
  bytes that do not match are not an answer, and the next gateway is asked. A UnixFS or dag-pb
  CID names a DAG the service assembled and cannot be checked this way; the seal is what
  protects those.
- **`mergeIncrements` joins every source's heads**, not only the newest's: a join is a merge, a
  stale head costs nothing, and a branch only an older increment saw — two devices shipping in
  parallel, or a store that renumbered — is kept instead of dropped. It also names `gaps` and
  `duplicates` in the sequence; `restoreFromIncrements` and `joinIncrements` refuse a chain
  with either unless `allowGaps: true`, instead of searching the network thirty seconds per
  missing block.
- **The watcher moves its state once, after the upload is kept.** `countedPending` is read
  before the walk (an update during it stays pending); a database unwatched during a flush no
  longer leaves the state half moved; `rebase()` and `stop({ flush: true })` wait for a flush in
  flight; a flush asked for after `stop()` does not run. A persisted state of another version
  is refused with a reason instead of silently restarting the numbering at 1.

### Added

- **`joinIncrements(database, { blockstore })`**: the application's own (non-dag-cbor) blocks
  go into the blockstore the caller names, e.g. `orbitdb.ipfs.blockstore`; without it they are
  counted in `skippedRaw` and left out. OrbitDB's log storage refused their base32 names, so
  an increment with a receipt file used to throw halfway.
- **`createLiveBackup({ confirm })`**: a hook `(kept, handle) => kept` to follow a backend's
  answer before the increment counts as shipped — Aleph answers `pending` first and may
  reject later (no credit, no grant). A settled `status: "rejected"` fails the flush and the
  state stays, so the next one ships it all again.
- **`close()`** on the watcher: stop, and detach from every database.
- `BackendHandle` declares `retained`, `status` and `itemHash`.
- **`forgetAlephStores` answers in four buckets**: `forgotten` only once Aleph said `processed`,
  `rejected` with the error code, `pending` for a FORGET still undecided when the time ran out
  (with the FORGET's own item hash, to follow), and `failed` for a batch that could not be
  sent — later batches still go. It pages by the API's total, not by a short page, since the
  listing filters after the page was cut. A FORGET names at most 1000 hashes and 1000
  characters of reason, checked before anything is signed.

## 0.19.0 (2026-10-17)

### Added

- **Forgetting on Aleph** (`backends/aleph-pin`): `buildForgetMessage`, `createAlephForget` and
  `forgetAlephStores`. A FORGET signed by the STOREs' owner (or a delegate authorized for it)
  names them by item hash; the files they kept are unpinned and stop costing credits. The
  driver's `deletion: false` stays true to the letter — a FORGET is the account's, not the
  blob's — so this lives beside `createAlephPin`, shaped like it: the library never sees a key,
  and `pending` is followed with `waitForMessage`. `forgetAlephStores` lists an account's STOREs
  on a channel, spares what `keep` says (the newest full backup, say) and forgets the rest in
  batches, reporting forgotten, kept and rejected by item hash. First consumer: simple-todo's
  `archived01` ("delete the archive"); Le-Space/belege next.

## 0.18.0 (2026-10-16)

### Added

- **Increments between two full backups** (new export `./live-backup`, #144). `createLiveBackup`
  watches open databases and ships what was written since the last increment as one small CAR —
  soon after the write, with nobody clicking and no other peer online. A full backup stays the
  baseline; this is what happens in between.
  - **Write-behind, never write-through.** A local write never waits for a service. The watcher
    keeps, per database, the heads it last shipped; a flush walks from the current heads back over
    `next` to them and ships what it passed. Entries that arrived by replication are reachable
    from the heads like any other, so they ship too. What survives a restart is a sequence number
    and a few hashes per database; the set of shipped hashes is rebuilt from them by walking the
    log once.
  - **One upload, one STORE.** The CAR's root is a dag-cbor manifest
    (`{ kind: "increment", v: 1, sequence, base, previous, createdAt, metadata }`). Every increment carries
    each database's manifest and access controller and the identity of every writer it has entries
    from, so a complete chain restores without a base. It goes through any backend's `putBlob`;
    a handle that says `retained: false` is followed by `pinCid`. Sealing is `withEncryption`
    around the backend, as for everything else.
  - **An unreachable backend loses nothing.** The flush fails, the state stays, and the next flush
    ships everything still pending. `status()` reports pending updates, the last increment and the
    last failure.
  - `readIncrement`, `mergeIncrements` and `restoreFromIncrements` put a base and its increments
    back through `restoreFromBlocks`, each database joined at the heads of the newest source that
    names it. `rebase({ base })` after a full backup starts the count again.
  - `joinIncrements(database, …)` does the same into a database that is open _now_, without
    closing it: for an application whose books are on screen.
  - Fourteen tests on real OrbitDB nodes, offline: first and second increment, restore from the
    chain alone and from base plus increments, an outage, a replicated entry from another writer,
    `after`/`every` triggers, a restart from persisted state, databases watched later, a backend
    that must be asked to keep, sealing, the application's own blocks, a join into an open database, and the backlog a start ships.
    [docs/LIVE-BACKUP.md](docs/LIVE-BACKUP.md) covers the whole path.

## 0.17.0 (2026-10-04)

### Changed

- **A STORE is paid in credits** (`backends/aleph-pin`). `buildStoreMessage` and `createAlephPin`
  put `payment: { type: "credit" }` into the STORE, as Aleph's own CLI does by default.
  - Without the field Aleph books a STORE as `hold`: ALEPH tokens locked on the account, a model
    it has deprecated. An account funded with credits covers nothing that way.
  - Measured on 2026-10-03: a `hold` STORE for an account holding nothing was processed at once,
    so "processed" says nothing about cover there.
  - A credit STORE is rejected unless the account has credit for at least a day
    (`min_runtime_days: 1`). 2 MiB needed 107.8 credits, about 54 per MiB and day.
  - `payment: "hold"`, or `payment: null` for no field at all as up to 0.16.1, keeps the old
    message. (#147)
- **`pinCid` says what Aleph answered** (`backends/aleph`).
  - The handle carries the STORE's `status` and `itemHash`.
  - `retained` is true only once the STORE is `processed`. A `pending` one is no longer reported
    as kept.
  - A `pin` function that reports nothing keeps the old answer.
- **An upload no longer claims to be retained** (`backends/aleph`). `putBlob`'s handle said
  `retained: Boolean(pin)`, but `putBlob` never sends a STORE; it says `false` now. Keeping is
  what `pinCid` does.

### Added

- **`waitForMessage(itemHash)`** (`backends/aleph-pin`) follows a message until Aleph has decided
  about it.
  - It ends with `processed`, or with `rejected` plus `errorCode` and `details`. For a credit
    STORE without enough credit, the details say how much the account had and how much is needed.
  - A message still pending when the time is up comes back as
    `{ status: "pending", timedOut: true }` instead of an error.
- **`listAlephStores({ owner, channel })`** (`backends/aleph-pin`) lists the STORE messages kept
  for an account, newest first, including those a delegate sent for it.
  - Aleph's `addresses` filter matches the sender and misses a delegate's STORE. `owners` matches
    the account the STORE is for (measured 2026-10-03).
  - So an empty device finds a backup with nothing but the paying account's public address.
- **An application's backup in one sealed file** (new export `./app-backup`, #147). Le-Space/belege
  had built this inside the application (`archive.js`); Le-Space/invoice needs the same, plus room
  for one sealed key slot per passkey. So it lives here now.
  - **The file:** `"OSBA" | version | header length | header | envelope`.
    - The header is the application's and is read without a key (`readAppBackupHeader`), e.g. for
      a keyring. The manifest names its SHA-256, so a swapped header is refused.
    - The envelope is the package's `OSBE`, around a CAR encrypted by the application's
      `encrypt`. The package still holds no keys.
  - **`buildAppBackup({ app, databases, encrypt, blocks?, header?, appVersion?, extra? })`** packs
    every database with `bundleDatabases`, together with blocks of the application's own (belege's
    receipt files). The CAR's root is a manifest naming the application.
  - **`openAppBackup(bytes, { decrypt, app? })`** checks every block against its CID. It refuses a
    backup of another application, and a header that is not the one the backup was made with.
  - **`restoreAppBackup({ orbitdb, opened, addresses, open })`** puts the books back through
    `restoreFromBlocks`.
    - It merges and never replaces.
    - It refuses a backup whose databases are not these books.
    - A head that cannot be joined fails the restore, where `restoreFromBlocks` alone only warns.
  - `docs/APP-BACKUP.md` covers the whole path: build, upload to Aleph, the browser's STORE as a
    delegate, finding the backup by the paying account, restore.

### Documented

- **Who pays for a delegate's STORE.** It is the owner, the account named in `content.address`.
  Aleph checks the owner's credit and books the cost to it, not to the delegate (measured
  2026-10-03, #147).

## 0.16.1 (2026-10-02)

### Fixed

- **An encrypted database restores** (`restoreFromBlocks`, and with it `restoreFromCID`). A head
  was joined from its raw dag-cbor fields. For a database opened with `encryption`, those are not
  the entry OrbitDB expects, so `joinEntry` threw (_"`undefined` is not supported by the IPLD
  Data Model"_). The restore went on and reported the database with `joined: 0`, and the
  database came back empty. Heads are now read through the log (`log.get`), which decodes its
  own entries, with the raw fields as the fallback. Found by Le-Space/belege, whose eight
  databases are all encrypted. Only unencrypted databases were tested before.

## 0.16.0 (2026-09-29)

### Added

- **Several databases in one backup, and back.** The metadata's `databases` was always a list,
  but every writer put one database in it and `restoreFromCID` read only `databases[0]`. An
  application whose state is eight OrbitDB databases had to bundle and restore them itself.
  - `bundleDatabases(databases, { onProgress })` (new export `./extract-blocks`, which also
    exports `extractDatabaseBlocks` at last) packs every block of several open databases into
    one Map and writes the metadata for all of them, each with its **heads**. A writer's
    identity shared by all of them is kept once. `onProgress` reports each database with its
    entries and blocks, for a page that wants to show what it packed.
  - `restoreFromBlocks(orbitdb, blocks, metadata)` (in `./restore-cid`, still without a logger
    or a Storacha client) puts every named database back, from blocks already in hand: a backup
    the application sealed itself and has just opened, or a file from somewhere else. Each
    database's manifest must be among the blocks. Heads come from the metadata, or are found per
    log in the blocks when the metadata states none. Only dag-cbor blocks go into a log's own
    storage; raw blocks that belong to something else (an application's files) go into the
    blockstore only.
  - `restoreFromCID` now restores every database its metadata names. Its answer is unchanged
    for one database, and `databases` lists them all.
  - Needed by Le-Space/belege's backup (Le-Space/belege#77): eight databases and the receipt files
    in one sealed file.
- **Other keys may keep things for an account** (`backends/aleph-pin`). One funded account can let
  other keys send STORE messages on its behalf, for example a key a browser derives from a
  passkey, one per person or device, so that no wallet and no server has to be online to keep a
  backup.
  - `createAlephPin({ sender, owner, sign })`: the STORE names `owner` as the account it is for,
    while `sender` signs. Without `owner` nothing changes.
  - `createAlephAuthorizer({ owner, sign })` reads, grants (`authorize`) and revokes (`revoke`)
    entries in the owner's `security` aggregate, which is Aleph's own permission list.
    `buildAuthorizationMessage` builds the AGGREGATE without signing it. A grant replaces one for
    the same address and keeps the others, because an aggregate key is replaced as a whole.
  - Measured against `api2.aleph.im` on 2026-10-02 with throwaway keys and random bytes:
    - the grant is `processed`, and reads back;
    - the delegate's STORE for the owner is `processed`;
    - a STORE from a key without a grant, and the delegate on a channel outside its grant, are
      first `pending`, then `rejected`.
  - Not yet known: which balance Aleph charges for a delegate's STORE. The docs do not say, and
    the probe's accounts held nothing.

- **Operations can wait for a button** (#141). `announceOnLocalUpdate: false` is how an application
  says _"typing must not spend airtime — a button decides"_. On the delta plane that rightly means
  do not watch local writes at all; on the operation plane it cannot, because the write still has to
  be **remembered** or the button has nothing to send. Until this, setting `liveUpdates:
"operations"` alongside that flag changed nothing whatsoever — measured in funkpost's browser, the
  wire still showed `→ blocks 860 B` and no `→ op` anywhere.

  The hook now registers on the operation plane either way, and only what it does with the entry
  differs: ship it, or queue it. `sync.announce()` — what a send button calls — sends the queue if
  there is one, and otherwise means what it always did, a request to reconcile.

  **Internal announces never flush.** The acknowledgement that ends a `blocks` delivery must not
  spend somebody's queued writes on its own; that decision belongs to the application.

  Past `MAX_PENDING_OPS` (16) the batch goes as a delta instead, and the reason is not memory: the
  outbox holds `maxOutbox` messages and sheds the oldest, and an operation is the one message here
  that **cannot be re-derived** — `announce`, `want` and `blocks` are all asked for again. A batch
  long enough to overflow the outbox would lose writes without saying so. One delta is one message
  and complete by construction.

  Measured end to end in funkpost, through its own send button, for one added todo:
  **`→ blocks 860 B` became `→ op 114 B`.**

## 0.15.0 (2026-09-29)

### Added

- **`liveUpdates: "operations"` — carry the change, not the entry that held it** (#135). A keyvalue
  entry holding `{text, done, ts}` costs **1774 B** on the air once the delta plane has put the
  entry and its identity block there. The operation inside it — `{op, key, value}`, which OrbitDB
  hands to every `update` listener already — costs **86 B**. Measured over funkpost's Meshtastic
  courier with framing, ARQ and duty-cycle pacing, for one further change to a list both sides
  hold. Twenty times, or three and a half minutes against ten seconds on a carrier moving half a
  kilobyte a minute.

  The default stays `"delta"`, so nothing changes for a consumer that does not ask.

  One new wire message and one optional field on `announce`:

  ```
  { v, tag, p, t: "op", id: bytes8, o: { op, key, value } }
  { v, tag, p, t: "announce", heads: [hash], r? }        r: please reconcile
  ```

  `id` is eight bytes from the origin entry's hash, so every retransmission of one change carries
  the same id and is performed once; a bounded seen-set remembers them, including our own on the
  way out, so a mesh repeating us cannot make us perform our own write again.

  **A cold join still goes through the delta plane** — an operation carries no manifest. `announce()`
  remains the repair, and now says so on the wire: divergent logs are this plane's ordinary state,
  so an announce without `r` is noted and left alone.

  What it costs, and none of it is hidden:
  - **The two logs diverge.** Each device holds its own entry for the same change. `o.key` is what
    keeps the _view_ single: a keyvalue store resolves to the latest value **per key**, so two
    entries under one key are one row. The receiver must therefore perform the change under the
    **sender's** key and never invent one — which is what `performOperation` does.
  - **Two devices editing one key while both are offline can disagree** until an IP path merges
    them, and then one edit is gone. A CRDT would not; an oplog with last-write-wins does.
  - **Nothing is signed end to end.** The receiver vouches for the change with its own identity, so
    trust rests on the carrier. The sender id in `p` is not authentication.
  - **The receiver must be allowed to write**, because it performs the change as its own write. A
    database whose access controller excludes it refuses outright, and the refusal now says that
    choosing this plane is what made it matter. This is also where a device pairing belongs: two
    devices that have met put each other's identity in the write set.
  - **A lost operation is lost.** `send`'s own comment — that a dropped message is re-derivable
    because a peer still wanting it asks again — holds for `announce`/`want`/`blocks` and _not_ for
    `op`.

### Fixed

- **The presence timeout test raced itself** (#136). It set `peerTimeoutMs: 1` and then asserted the
  peer was still present; convergence does real OrbitDB work and a loaded runner stretches it well
  past a millisecond, so a scheduled run of `main` went red and a re-run went green. One window,
  wide enough that being present is not a race.

## 0.14.1 (2026-09-25)

### Fixed

- **The delta walk asked block storage about entries the log does not have, and paid a network
  timeout for each one** (funkpost#170). 0.14.0's `reachableFrom` walks the peer's announced heads
  to work out what they can already reach. It read those hashes straight out of
  `db.log.storage` — and `IPFSBlockStorage.get` on a miss waits out a network timeout rather than
  answering "no".

  The peer's heads are exactly where the misses live: their newest entry is by definition the one
  we have not got. So this was the ordinary path, not an edge case. Measured against a Helia node
  with no peers — every phone in the field — **20 seconds for a single hash.** The delta it
  eventually produced was correct; it simply arrived after everything around it had given up, and
  two peers stopped converging.

  It now asks `log.has` first, which reads the index and answers at once, and goes to block
  storage only for what the index confirms. The same rule was already written down in
  `applyDeltaToStores`'s closure check; this walk broke it.

  Not caught here because the suite's own nodes are built `useBootstrap: false, useDHT: false,
autoDial: false`, where a miss fails instantly. The regression test pins the rule instead of the
  timing: block storage is never asked about a head the log does not hold.

**0.14.0 should not be used.** Any consumer whose Helia node can reach a network — which is the
default — will see replication stall.

## 0.14.0 (2026-09-25)

Both entries come from one field day: two phones, two Meshtastic nodes, no IP path, a todo list
over LoRa. The carrier moves about half a kilobyte a minute, which turns every protocol question
into minutes and made both of these visible at once.

### Fixed

- **A delta carried the whole log, every time** (#127, in #129). `createDelta` walked back from
  our heads and stopped only at the hashes the peer had announced — but an OrbitDB entry's `refs`
  are skip-list back-references that point _past_ its parent, so the walk followed one around the
  stop and carried on to the root. A peer missing a single entry was sent everything: **12 blocks
  and 8742 B where 2 blocks and 1533 B were owed.** Ten minutes of airtime to deliver one todo.

  The stop set is now everything reachable from the heads the peer named, walked through `next`
  _and_ `refs`, so a ref can no longer route around it. A peer standing exactly where we do is
  answered without reading the ancestry at all.

  The other half of #127 stays open, and is now pinned by a test rather than described: when the
  peer's head is an entry we have never seen, none of its ancestry can be walked, the stop set is
  that hash alone, and the delta is again everything we hold. That is the case two people editing
  one list reach on their first concurrent change. Closing it wants the frontier exchange — a peer
  naming a few ancestors alongside its heads, so the other side has something to stop at.

### Added

- **`applied` — what a delivery came to, including when it came to nothing** (#130). `synced`
  fires only when something joined, so a delivery that joined nothing produced no event at all,
  and four different outcomes shared that silence. Two of them are opposite findings:

  > `held` — the entry was already in the log. Another route brought it first, so the courier
  > delivered something nobody needed: wasteful, and correct.
  >
  > `absent` — the sender named a head and did not send it. A defect in the delta it built, and
  > the database does not move.

  Five complete `blocks` deliveries reached a phone that day and not one of them joined anything,
  on either device. Nothing in the logs could say which of these it was, and they call for
  opposite repairs — so the run has to be done again to ask a question the phones were already
  holding the answer to.

  `createCourierSync` now emits `applied` for every `blocks` delivery, complete or not, carrying
  `{ complete, heads, missing, joined, held, absent, malformed, refused }`. `applyDelta` returns
  `heads` and `outcome` alongside what it returned before. `malformed` and `refused` should not
  happen at all; they are counted rather than folded into `absent` so that "should not happen"
  stays falsifiable in a field log.

  `synced` is unchanged — same payload, same condition — so a consumer that only wants joins keeps
  the event it has.

## 0.13.0 (2026-09-24)

### Changed — **breaking**

- **Backups are encrypted by default** (#121). `dehydrate` refuses to upload unless it is given
  `encrypt`/`decrypt`, or told `dontEncrypt: true`:

  > Backups are encrypted by default. Pass `encrypt` and `decrypt` — a browser derives them from
  > the security key — or `dontEncrypt: true` if this backup is meant to be readable by anyone
  > holding the CID.

  Every existing caller passes neither, so every existing caller stops at the next upload —
  deliberately, with that message, rather than quietly continuing to publish a readable backup.
  Plaintext is still available and is now a decision that shows up in a review. `dontEncrypt`
  rather than `encrypt: false` because the double negative is awkward to read, which is what you
  want from a line that turns off protection.

### Added

- **`@le-space/orbitdb-storage-bridge/backends/encryption`** — `withEncryption(backend, { encrypt,
decrypt })` encrypts on the way out, `decryptingFetch(fetchBytes, { decrypt })` decrypts on the
  way back. Both halves are needed: a restore does not read through a backend, it fetches from a
  gateway or from peers, so `getBlob` never runs during one.

  This package holds no keys and knows nothing about passkeys — it takes two functions, as
  `createBackendFromChoice` takes `normaliseAddress` rather than importing viem. A browser derives
  them from the security key's PRF output, and should use a key derived separately from the
  signing key.

  The ciphertext carries an envelope — magic, version, IV — so a restore tells an encrypted backup
  from a plaintext one written before this change without being told which it is.
  `explainIfEncrypted` covers the third case with a sentence instead of a failure inside the CAR
  reader: an encrypted backup and no key.

### Fixed

- **`createPeerFetch` needs `identify`, and the documentation did not say so.** A node built with
  `withLibp2pLight` dials the provider successfully and then fetches nothing: without `identify`,
  bitswap never learns that the peer speaks bitswap, no want is sent, and the call fails with
  "Failed to load block" after the full timeout. Measured against Aleph over one dialled
  connection: 60 s of nothing without it, **1.6 s for 400 kB with it**. The module docstring now
  carries the whole libp2p configuration a caller needs.

- **One connection per peer, not per address.** A provider usually advertises the same node
  several times — Aleph offers webrtc-direct and webtransport — and `createPeerFetch` dialled
  every address in the list, so one provider became two connections and a peer count that read
  double. It now dials each peer id once.

- **`DEFAULT_ROUTERS` asks both routers.** An earlier note here said `delegated-ipfs.dev` sends no
  CORS for provider lookups; that came from a single request that came back without the header,
  and repeated from a deployed page it answers with `access-control-allow-origin: *`. The reason
  to ask both is better than CORS anyway: `cid.contact` is an IPNI index, and a CID Aleph holds
  appears only at `delegated-ipfs.dev`, because Aleph announces over the DHT. `ALL_ROUTERS` is now
  the same list and deprecated.

## 0.12.0 (2026-09-23)

### Added

- **The storage probe is an example in this repository** (#110). It is a static page — one HTML
  file and one small module, no build step — that measures whether this package's backends work
  from a browser with no server: Aleph, Pinata and Lighthouse endpoints, their CORS on success
  _and_ on refusal, a provider lookup over `/routing/v1/providers`, and a real upload with the
  reader's own key, read back.

  It was in a GPL-3.0 application, where someone evaluating this MIT package had no reason to look
  and where a change to a backend here had no instrument to catch it. Relicensed under MIT by its
  author for this repository; the brand module it used to import is GPL and did **not** come with
  it — the language switch and the theme toggle are `probe-ui.js`, written here.

  Keys stay with the reader: typed into the page, kept in `localStorage`, sent to the service they
  belong to and nowhere else, cleared by a button that says so.

- **A `Pages` workflow**, since there was nowhere to publish a browser instrument. It builds
  nothing, and fails if a page acquires an import map or a bare specifier — what is deployed has
  to be what a reader gets by opening the file.

- `test/storage-probe.test.js` — the endpoints the page names have to be the ones the drivers use,
  since a static page cannot import them and a repetition nobody checks drifts. It also asserts
  what the move left behind: MIT, no GPL import, no retired gateway, and the CSS rule that hides
  one of the two languages.

- **`@le-space/orbitdb-storage-bridge/peer-fetch`: fetch a CID from the peers that hold it**,
  for when a gateway will not do. `createPeerFetch({ helia, providers })` returns exactly the
  `fetchBytes` that `restoreFromCID` already takes, so a restore over libp2p needs no other
  change; `createGatewayFirstFetch` tries HTTP with a short timeout and hands over to peers when
  it does not answer, telling the caller which path delivered and how long it took.

  Measured from a real page (Chrome, no build step) on 2026-09-23 — all three services, two
  transports: Pinata 0.73 s to dial over `wss` and 0.26 s for the block, Lighthouse 0.58 s over
  `webrtc-direct` and 0.32 s, Aleph 0.45 s and 0.35 s. **No credential anywhere in it**, while
  both paid providers' HTTP gateways want that account's key and Lighthouse's shared one
  answers 402.

  `ALEPH_BITSWAP` exists because Aleph took finding: it publishes no `_dnsaddr` and answers 404
  to `/api/v0/id`, so the way Pinata is found says it has no peer. Asking a router for the
  providers of a CID it holds gives `46.255.204.211` — the address `ipfs.aleph.cloud` resolves
  to — with `webrtc-direct` and `webtransport`. Only `delegated-ipfs.dev` knows it, because Aleph
  announces over the DHT rather than IPNI, and that router sends no CORS for provider lookups:
  hence a constant for pages and `ALL_ROUTERS` for Node.

  There is no default provider list. Whoever stores with a service already shares their CIDs with
  it, so reading from it adds no new party — but a page dialling a service it never uploaded to
  would be telling that service what its reader is looking for, for nothing. `PINATA_BITSWAP` is
  a constant because Pinata publishes it in DNS; `providersFor(cid)` asks a router for the rest,
  and only `cid.contact` answers a browser.

- `test/gateway-fetch.test.js` — the module had no tests, which is how four dead gateways sat in
  its default list. 13 of them, all offline: `fetch` and the wait are injected.

- `test/gateway-live.test.js` and a `gateways` job in `live-backends.yml` — the part a unit test
  cannot know. It uploads one blob through Aleph, keyless, asks every default gateway for it by
  CID, and fails on an RFC 8594 `Sunset` header, which a gateway publishes weeks before it goes
  quiet. Checked against the failure it exists for: putting `dweb.link` back in the list turns it
  red on both counts.

- **`createBackendFromChoice({ gateway })`** (#108). A retrieval gateway was reachable only
  through the untyped `options` pass-through, which was a gap worth closing before the public
  path gateways were retired and a bad one afterwards: the gateway a reader can actually use is
  normally their own account's, and it is now part of the choice they make. A bare domain is read
  as https, as each driver already accepts.

  The two services' gateways refuse each other's content — Pinata answers `401`, Lighthouse
  `402` — so with several services chosen this takes an object keyed by service, and a single
  string is **refused** with a message showing the shape rather than handed to all of them.
  Aleph's driver tries a list, so one gateway becomes a list of one with `/ipfs` appended; an
  explicit `gateways` still wins.

### Changed

- **`@helia/block-brokers` is no longer a dependency** (#119). It was declared here and imported
  nowhere, and it was not free: it depends on `@helia/bitswap` ^3.2.3, so every tree that
  installed this package got a second bitswap beside the 4.x that Helia brings itself.

- **helia ^7.1.15**, which brings `@helia/bitswap` 4.0.19. The release that matters is 4.0.17:
  bitswap did not work over **circuit-relay connections** at all — the topology was registered
  without `notifyOnLimitedConnection`, so bitswap never learned the peer existed, and the dial
  that requests blocks dropped `runOnLimitedConnections` (ipfs/helia#1124). `createPeerFetch`
  dials providers, and a browser behind carrier NAT reaches some of them through a relay.

- **Retrieval defaults have one entry where they had three** — see _Fixed_. Nothing was removed
  from the API; the other two hosts were retired by the people who ran them.

### Fixed

- **The retrieval gateways were all retired on the same day** (#111). `ipfs.io` and `dweb.link`
  stopped serving content on 2026-09-21, answering `429` with an RFC 8594 `Sunset` header;
  `w3s.link` and `storacha.link` redirect to the first of those. Between them they were every
  fallback this package had — in `gateway-fetch.js`, `backends/aleph.js`, `backends/storacha.js`,
  `backup-car.js`, `ucan-bridge.js` and the bridge's own default — so each chain had one live
  entry and a dead tail that only showed up when the live one had a bad minute.

  Defaults are now `ipfs.aleph.cloud`, measured on 2026-09-23 as the one free path gateway still
  serving arbitrary CIDs, and `TRUSTLESS_GATEWAYS` names `trustless-gateway.link` for verifiable
  single-block requests (`accept: RAW_BLOCK`).

- **A retired gateway no longer costs an afternoon.** `Retry-After: 900` was honoured literally,
  three times per gateway, so a restore against the old list could wait out hours of retirement
  notices before failing. A `Sunset` header now retires a gateway for that call, and any wait
  beyond `MAX_BACKOFF_MS` (30 s) is treated as closed rather than busy. A gateway that announces
  a sunset and still serves bytes is still used.

## 0.11.0 (2026-09-23)

Released from the workflow without a changelog entry at the time; written here from #109 so the
history does not skip a version.

### Added

- **`createMirrorBackend([...])`: one backup on several services.** `putBlob` writes to all of
  them and resolves when at least one accepted, with every service's outcome carried in the
  handle — a silent partial success is the one answer that is not acceptable. `getBlob` asks them
  in order and stops at the first that answers. Capabilities are the honest intersection:
  `browserSafeAuth`, `carImport` and `preservesInnerCids` only when _every_ member has them,
  `minBlobSize` the largest, `pinByCid` when any member can pin. `list()` and `remove()` are not
  offered — a union listing has duplicates, and a half-succeeded deletion leaves a copy behind
  while reporting success.

- **`createBackendFromChoice({ kind, … })`: a backend from a name and a key**, which is what a
  page has once a reader ticks a service and pastes a credential. Every vendor module is imported
  lazily, so a page that chose Aleph ships neither of the other two drivers, and a missing
  credential is refused there and then, with the service named, rather than at the first upload.
  Several kinds become a mirror. `resolveBackend` accepts the same choice.

## 0.10.0 (2026-09-19)

### Added

- **The restored device writes, and the original takes the entry** — P11 step 5, shown rather than
  argued (`test/restored-can-write.test.js`). A signing key derived from the same secret produces
  the _same identity document_, hash for hash, on a machine that never saw the first, so the
  access controller that named the original writer accepts entries from the device that came back.
  A device holding another key restores the same database, reads it, and is refused on write —
  which is what makes the acceptance mean anything.

  Two traps found on the way are now in
  [docs/RECOVERY-ON-A-SECOND-DEVICE.md](docs/RECOVERY-ON-A-SECOND-DEVICE.md), because neither
  announces itself: `Identities({ keystore })` without `ipfs` verifies only identities it created
  itself, so a restored log comes back **empty with no error**; and seeding a keystore under your
  own label is not enough with OrbitDB's default provider, which looks the identity's key up under
  the derived hex id.

### Added

- **`@le-space/orbitdb-storage-bridge/dehydrate`: put a database where a second device can find it, and get
  it back.** `dehydrate()` backs the database up as a CAR, uploads it, and publishes an IPNS
  pointer to it under a name derived from a seed; `hydrate()` finds that pointer with the same
  seed and nothing else, checks the record against the name it asked for, fetches the backup and
  opens the database. Between the two devices there is no CID, no address and no file — only a
  secret both can produce, which is a passkey's PRF output in the case this was written for
  (funkpost#93, P11 steps 3 and 4).

  **There is no encrypted identity archive, and that is not an oversight**: with a signing key
  derived from the same secret (`@le-space/orbitdb-identity-provider-webauthn-did` 0.6.0) the new
  device recomputes the identity instead of carrying it, so the restored copy can _write_ and
  there is nothing secret to store in the open.

  The whole procedure, including what it does not promise, is written up in
  [docs/RECOVERY-ON-A-SECOND-DEVICE.md](docs/RECOVERY-ON-A-SECOND-DEVICE.md).

### Added

- **`@le-space/orbitdb-storage-bridge/pointer-ipns`: a pointer a second device can find with nothing but a
  key.** A backup's CID is enough to fetch it from anywhere — but a device that has lost
  everything cannot be _told_ a CID, because there is nobody left to tell it. So the name is
  computed instead: `derivePointerKey(seed)` stretches a secret (a passkey's PRF output is the
  case this was written for, funkpost#93) into an Ed25519 key, and the IPNS name follows from it,
  so two devices holding the same seed reach the same name without exchanging anything.
  `publishPointer()` writes the record over **delegated routing** (`PUT /routing/v1/ipns/{name}`),
  since a browser cannot join the DHT and `w3name` was Storacha's; `resolvePointer()` reads it
  back and **validates every record against the name it asked for**, so an endpoint cannot hand
  back somebody else's pointer or an altered one without being caught. Several endpoints are
  allowed, and one that answers is enough.

  Verified against `delegated-ipfs.dev` from Node and from a browser page on a foreign origin:
  preflight 204 with `PUT` allowed from anywhere, PUT 200, GET 200 byte for byte. Two things that
  could not be established, and which the module therefore does not promise: that a record travels
  beyond the endpoint that took it, and how long it is kept.

### Fixed

- **One stuck send no longer stalls the whole sync.** `handlePayload` put every incoming message
  on one promise chain, and the handlers awaited `courier.send`, which resolves on _delivery_ —
  an end-to-end ARQ over a carrier that is slow by law. On two radios that meant a joiner asked
  fourteen times and got one answer: the first reply was still in flight and every later message
  sat behind it, never even looked at ([funkpost#83](https://github.com/NiKrause/funkpost/issues/83)).
  Outgoing messages now wait in an **outbox** of their own, in order, while the receive path keeps
  running; a test reproduces the field case and fails against the old shape with exactly the
  symptom from the log — one message heard instead of four.

### Added

- **A reply that has not gone out yet is superseded by a newer one of the same kind to the same
  peer.** The peer asked again, so the older answer would spend airtime on what it already has.
  Peers without a sender id (an older version) are never superseded, because they cannot be told
  apart.
- **`sendTimeoutMs`** (default 300 000) — a way out of a courier that neither delivers nor fails,
  deliberately far outside any honest delivery; `0` waits for ever. **`maxOutbox`** (default 32)
  bounds what a carrier that cannot keep up may make us hold; the oldest waiting message goes, and
  everything here is re-derivable.

## 0.9.0 (2026-09-19)

### Added

- **Presence in `courier-sync`: who is out there, not which radios are.** A carrier can tell you
  a radio is in range; it cannot tell you whether a program on the other end keeps the same
  database, and that is the question an app has to answer before spending airtime. Every message
  now carries a four-byte sender id (**7 bytes of dag-cbor**, counted in the tests), so ordinary
  traffic already answers it for free, and `hello()` asks outright for the silence in between —
  two messages that each fit in a single 200-byte LoRa frame. `presence()` reports the peers heard
  lately and how long ago the air last carried anything for this database at all; `forgetPeers()`
  drops it when the carrier itself changes underneath, as a radio switching channel does.
  A peer on an older version sends no id and answers no `hello`, so its traffic counts as
  "somebody is out there" but not as a peer — and a mesh repeating our own message counts as
  nothing, which is what an app alone in a valley needs it to be.

## 0.8.1 (2026-09-18)

### Fixed

- **`restoreFromCID` opens the database the way the caller asks.** It hard-coded the type and
  nothing else, so on a node built without a pubsub service — funkpost's mesh-only demo, which
  opens everything with `sync: false` — OrbitDB's `Sync` subscribed on open and threw
  `Cannot read properties of undefined (reading 'addEventListener')` before the restore could
  hand anything back. Pass `open: { sync: false }`, or anything else `orbitdb.open` takes.

### Changed

- **Backing up no longer carries the Storacha client.** `backup-car.js` imported the main entry,
  which imports `@storacha/client` at the top, so a page that backs up to Aleph paid for a client
  it never calls — **88 kB gzipped**, measured in a real bundle (`mesh-todo`: 420.4 → 508.6 kB).
  The two pieces a backup needs moved out (`lib/extract-blocks.js`, `lib/backends/resolve.js`),
  the Storacha backend is built through a dynamic import, and the Storacha-space paths inside
  `backup-car.js` fetch the main entry only when a space is actually consulted. Importing
  `@le-space/orbitdb-storage-bridge/backup-car` now costs **4.2 kB gzipped**. No import path changed:
  everything the main entry exported, it still exports. A test walks the static import graph, so
  the client cannot creep back in.

## 0.8.0 (2026-09-18)

### Added

- **Lighthouse storage driver**, `@le-space/orbitdb-storage-bridge/backends/lighthouse`: upload, listing
  and deletion over the endpoints `@lighthouse-web3/sdk` 0.4.7 uses, without the SDK. A backup's
  CAR goes up as a plain file and comes back byte for byte; `carImport: true` sends CARs to
  `dag/import` instead. File names go up without their path, and errors carry Lighthouse's reason;
  an expired plan is `UNSUPPORTED`. **Uploads are not yet verified against a live account**: the
  key and the listing are, but the test account's trial had expired (2026-09-17, issue #60).

### Fixed

- **Backups work in browsers.** `backupDatabase` built its CAR through Node's `Readable.from`,
  which the stream polyfill a bundler gives the browser does not have, so every browser backup
  failed before anything was uploaded. The CAR is now read with a plain async loop.
- **A backup holds the identity of the database's writer, without searching the network for
  it.** `extractDatabaseBlocks` asked the log's storage for the identity, which does not hold
  identities made by `Identities()` without `ipfs`: Helia then searched the network until
  OrbitDB's 30-second timeout, and the backup went up without the identity. The block now comes
  from the database's own identity.
- **A courier delta carries the writer's identity, for the same reason.** `createDelta` asked
  the log's storage too, so an app with its own identity provider — a passkey, a DID — would
  have sent its entries over a mesh without the block a receiver needs to verify them, after
  waiting out a network search that a courier has no network for. Databases whose identities
  OrbitDB makes itself were never affected.
- The library logged "Uploading to Storacha" whatever the backend was; it names the backend now.

## 0.7.0 (2026-09-17)

### Added

- **Pinata storage driver**, `@le-space/orbitdb-storage-bridge/backends/pinata` (#80, #84). Verified against a
  live free-plan account on 2026-09-17: upload, listing, deletion, CAR backups and a database
  restored on a second node. Pin by CID and CAR import are paid-plan features, so both are opt-in
  (`pinByCid`, `carImport`). Use the dedicated gateway of the key's own account; it may be given as
  the bare domain Pinata's dashboard shows. Errors carry Pinata's reason.

### Changed

- `key-did-provider-ed25519`, `@orbitdb/identity-provider-did` and `key-did-resolver` are
  devDependencies now: nothing the package ships imports them. Installing the package brings no
  known vulnerability (`npm audit --omit=dev`) (#85).
- Errors the library rethrows from a `catch` carry the original error as `cause` (#86).
- **Renamed to `@le-space/orbitdb-storage-bridge`** — published as `orbitdb-storacha-bridge` up to 0.6.0.
  Storacha is no longer the only backend, so the name stopped describing the package. The
  rename changes no API: replace the dependency and the import specifiers
  (`orbitdb-storacha-bridge/courier-sync` → `@le-space/orbitdb-storage-bridge/courier-sync`, and so on).
  Names that refer to Storacha itself stay — `OrbitDBStorachaBridge`, `StorachaIntegration.svelte`,
  `backends/storacha`, the `storacha_*` localStorage keys — and so does the debug namespace
  `libp2p:orbitdb-storacha:*`.

### Removed

- `StorachaTest.svelte`, `StorachaTestWithReplication.svelte` and `StorachaTestWithWebAuthn.svelte`
  are no longer in the package (#83). Each imported a file no release ever contained, so none of
  them could be imported.

Releases 0.5.0 to 0.6.0 are described in their
[GitHub release notes](https://github.com/NiKrause/orbitdb-storage-bridge/releases).

## 0.4.3 (2026-01-23)

### Added

- IPFS network restore with gateway fallback and new network download tests.
- In-memory Storacha test mode with local gateway support and improved integration test harness.
- Timestamped backup example and dedicated test suite.
- CAR backup documentation plus expanded test and example docs.
- New E2E coverage for Svelte examples.

### Changed

- Logging migrated to `@libp2p/logger` for structured output.
- Svelte example apps updated (UI polish, configs, and test setup).
- CI now runs Svelte E2E jobs sequentially and pins Playwright to IPv4 loopback.

### Fixed

- Integration test stability (sequencing, retries, and cleanup improvements).
- Linting and dependency fixes across the repo.

### Removed

- `examples/svelte/ucan-delegation` moved out of mainline (now on a separate branch).
