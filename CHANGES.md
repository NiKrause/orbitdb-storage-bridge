# Changes

## 0.14.0 (2026-09-25)

Both entries come from one field day: two phones, two Meshtastic nodes, no IP path, a todo list
over LoRa. The carrier moves about half a kilobyte a minute, which turns every protocol question
into minutes and made both of these visible at once.

### Fixed
- **A delta carried the whole log, every time** (#127, in #129). `createDelta` walked back from
  our heads and stopped only at the hashes the peer had announced — but an OrbitDB entry's `refs`
  are skip-list back-references that point *past* its parent, so the walk followed one around the
  stop and carried on to the root. A peer missing a single entry was sent everything: **12 blocks
  and 8742 B where 2 blocks and 1533 B were owed.** Ten minutes of airtime to deliver one todo.

  The stop set is now everything reachable from the heads the peer named, walked through `next`
  *and* `refs`, so a ref can no longer route around it. A peer standing exactly where we do is
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
  *and* on refusal, a provider lookup over `/routing/v1/providers`, and a real upload with the
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

- **Retrieval defaults have one entry where they had three** — see *Fixed*. Nothing was removed
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
  `browserSafeAuth`, `carImport` and `preservesInnerCids` only when *every* member has them,
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
