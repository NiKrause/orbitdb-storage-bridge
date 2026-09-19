# Changes

## 0.10.0 (2026-09-19)

### Added
- **The restored device writes, and the original takes the entry** — P11 step 5, shown rather than
  argued (`test/restored-can-write.test.js`). A signing key derived from the same secret produces
  the *same identity document*, hash for hash, on a machine that never saw the first, so the
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
  device recomputes the identity instead of carrying it, so the restored copy can *write* and
  there is nothing secret to store in the open.

  The whole procedure, including what it does not promise, is written up in
  [docs/RECOVERY-ON-A-SECOND-DEVICE.md](docs/RECOVERY-ON-A-SECOND-DEVICE.md).


### Added
- **`@le-space/orbitdb-storage-bridge/pointer-ipns`: a pointer a second device can find with nothing but a
  key.** A backup's CID is enough to fetch it from anywhere — but a device that has lost
  everything cannot be *told* a CID, because there is nobody left to tell it. So the name is
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
  on one promise chain, and the handlers awaited `courier.send`, which resolves on *delivery* —
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
[GitHub release notes](https://github.com/NiKrause/@le-space/orbitdb-storage-bridge/releases).

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
