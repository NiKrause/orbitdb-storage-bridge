# Storage backends after Storacha

Storacha switched off writes on 2026-05-15 and the service is now gone (the evidence is in the
[README status section](../README.md#status-storacha-sunset-may-2026)). This document evaluates what
can take the backend slot. Everything below was checked on **2026-09-05**; prices and API shapes move,
so re-check before committing to one.

## 1. What the backend slot actually has to do

The Storacha surface this library uses is small. Every call site, from `lib/` and `src/`:

| What                      | Call                                                                   | Sites |
| ------------------------- | ---------------------------------------------------------------------- | ----- |
| Write                     | `client.uploadFile()`                                                  | 4     |
| Discovery                 | `client.capability.upload.list()`, `client.capability.blob.list()`     | 4     |
| Delete                    | `client.capability.upload.remove()`, `client.capability.blob.remove()` | 2     |
| Identity & delegated auth | `addSpace`, `setCurrentSpace`, `currentSpace`, `addProof`, `agent.did` | 25    |

Around that sits ~7.4k lines of OrbitDB work — block extraction, `zdpu*`↔`bafkre*` CID bridging, CAR
packing, identity and access-controller preservation, courier-sync — none of which cares who stores
the bytes. So the requirements for a replacement are:

1. **Byte-exact round trip.** The whole point of the library is that a restored database has the same
   block CIDs and the same identity. A backend that re-chunks content and hands back _its_ CID breaks
   that; a backend that stores an opaque blob (our CAR) and returns it unchanged does not.
2. **Node.js and browser.** The Svelte components run in the browser.
3. **Listing.** Restore currently discovers what exists by listing the space.
4. **Retrieval without the writer.** Disaster recovery means the machine that wrote the backup is gone.
5. **Delegated, time-bounded auth**, if the UCAN roadmap (v0.7.x) is to survive in some form.

Note (1) and the existing CAR path in `lib/backup-car.js` / [CAR-BACKUP.md](CAR-BACKUP.md) together:
**the CAR-based backup is the migration-ready one**, because a CAR is an opaque blob to the backend and
a full block store to us. The per-block upload path is the one that constrains backend choice.

## 2. Filecoin Onchain Cloud — Synapse SDK

[`@filoz/synapse-sdk`](https://www.npmjs.com/package/@filoz/synapse-sdk) v2.0.0, released 2026-09-03;
89 releases; docs at [docs.filecoin.cloud](https://docs.filecoin.cloud/). This is where Storacha itself
pointed: `@storacha/filecoin-pin-migration` ("Migration library from Storacha to Filecoin on Chain")
is built on `@filoz/synapse-core`.

The stack: **FWSS** (Filecoin Warm Storage Service) rents warm storage, **PDP** makes providers prove
daily that they still hold the data, **Filecoin Pay** streams payment per proven epoch, **FilBeam** is
the optional CDN.

```js
const synapse = Synapse.create({
  account,
  source: "@le-space/orbitdb-storage-bridge",
  chain: mainnet,
});
await synapse.storage.prepare({ pieceSizes: [BigInt(car.byteLength)] }); // deposit + approval, 1 tx
const { pieceCid, copies } = await synapse.storage.upload(car); // 2 providers by default
const bytes = await synapse.storage.download({ pieceCid });
```

| Our need  | Synapse                                                                     |
| --------- | --------------------------------------------------------------------------- |
| Write     | `synapse.storage.upload(bytes)` → `pieceCid`                                |
| Discovery | `synapse.storage.findDataSets()`, then pieces per data set                  |
| Delete    | `terminateService({ dataSetId })` — ends the rail, provider may then delete |
| Auth      | EIP-712 signatures from a wallet; **session keys** for delegation           |

**Costs.** $2.50/TiB/month/copy with a 2-copy minimum, $0.12/data set/month for proving, a refundable
~$0.50 lifecycle reserve per data set, up to $14/TiB egress if FilBeam is enabled, plus a one-time
per-operation fee to the provider for each on-chain action. Payment is in USDFC; gas is in FIL. FWSS
keeps a fixed **30-day prepaid lockup** — fall below it and the provider may start removing data.

**Limitations**

- **Minimum 127 bytes per upload.** Individual OrbitDB blocks fall under that, and one on-chain piece
  per block would be absurd anyway. CAR-only, in practice.
- **On-chain write path.** Every backup is a transaction: a wallet, FIL for gas, and a confirmation
  wait. "Incremental backup after each database mutation" (README use case 3) becomes a per-mutation
  gas cost. Batching, or a pointer-record scheme like the v0.4.4 roadmap item, stops being an
  optimisation and becomes a requirement.
- **Fixed cost floor.** ~$1.44/year per data set before a single byte is stored. Irrelevant at 1 TB,
  dominant for a 5 MB database.
- **Rental, not permanence.** Stop funding the rail and the data goes. That is honest, but it means a
  backup needs a funded wallet behind it for as long as you want the backup.
- **Not IPFS-addressed.** You get back the CAR by `pieceCid`, not the blocks by their CIDs — fine for
  our restore path (we import the CAR into Helia), but the "restore straight from any IPFS gateway"
  property is lost unless you also use Filecoin Pin (below).
- **Browser UX.** `window.ethereum` and a wallet popup per operation, unless session keys are used.

**Worth having**

- **PDP turns "is my backup still there?" into an on-chain question.** Storacha never offered that, and
  for a disaster-recovery library it is the single most valuable property on this page.
- **Session keys** are a real analogue of the UCAN delegation roadmap: ephemeral keys registered in a
  `SessionKeyRegistry` contract, scoped to specific permissions (EIP-712 type hashes, custom hashes
  allowed), with an expiry (SDK default 1 hour). Capability + expiry + delegation, on-chain instead of
  in a UCAN chain.
- Two independent providers by default; provider choice and termination are yours, not a company's.

## 3. Filecoin Pin — the same stack, IPFS-shaped

[`filecoin-project/filecoin-pin`](https://github.com/filecoin-project/filecoin-pin) sits on top of FOC
and keeps the IPFS semantics: it packs content into a CAR, uploads it to a storage provider, and the
provider **announces it to IPNI so it resolves through standard IPFS gateways** — Kubo, Helia, HTTP
gateways. Live on mainnet. The docs name Storacha refugees as the target audience.

This is the closest thing to a drop-in for what Storacha did: content stays CID-addressed, retrieval
stays gateway-shaped, and the p2p-first restore path in this library keeps working unchanged. It
inherits the FOC economics and the wallet requirement from §2. Its IPFS Pinning Service API daemon is
explicitly **beta, not for production** (no quotas, no rate limits, in-memory state), so treat the
library/CLI as the integration surface, not the pinning API.

## 4. Lighthouse

[`@lighthouse-web3/sdk`](https://www.npmjs.com/package/@lighthouse-web3/sdk) v0.4.7, released
2026-07-10. A pay-once-store-forever model: a one-time payment funds an endowment pool that renews
Filecoin deals in perpetuity. Roughly **$2–5/GB, once**.

**Fits us surprisingly well**

- **CAR upload exists**: `uploadCAR()` posts to `/api/v0/dag/import`, a Kubo-shaped DAG import, so the
  blocks inside keep their CIDs. Content stays IPFS-addressed and gateway-retrievable.
- `getUploads()` replaces `upload.list()`; `deleteFile()` replaces `upload.remove()`.
- **IPNS is built in** (`ipns --generate-key`, `--publish`) — the v0.4.4 "latest-backup pointer" and
  the IPNS-based head discovery in the restore roadmap would come for free instead of being built.
- Access control by wallet address (`share-file`, `revoke-access`) on top of Kavach threshold
  encryption, plus token-gated conditions. Not UCAN, but a working delegation story for _reads_.
- PODSI proofs, `dealStatus`, an alternative Walrus/Sui backend, an S3-compatible API.

**Limitations**

- **API-key bearer auth.** No delegation of write capability, no DID-based identity, nothing that maps
  onto the UCAN roadmap. The browser is not excluded, though: `getApiKey(publicKey, signedMessage)`
  posts to `/api/auth/create_api_key`, so each user mints **their own** key by signing with their own
  wallet — no shared secret has to be shipped. What is lost is scope and expiry: the key is an
  unscoped, long-lived bearer credential for the whole account (upload, delete, list, IPNS), so an XSS
  is a full account takeover, and there is no way to hand someone "may add to this space until Friday".
- **The perpetuity promise is custodial.** It is a company-run endowment pool, not a protocol
  guarantee. Storacha is the reason to weigh that: the pay-once model concentrates all the risk at the
  moment of payment, and there is no rail to stop funding if the operator stops delivering.
- **Cost model mismatched with rolling backups.** Every timestamped backup is paid for _forever_, even
  the ones you would happily expire after a week. Deleting does not refund.
- **Node CAR upload needs a `.car` file on disk** (the SDK reads a path via `fs-extra` and rejects any
  other extension); the browser path takes a `File`. We build CAR bytes in memory, so Node needs a
  temp file.
- `gateway.lighthouse.storage` answered **402 Payment Required** for a CID not stored with them, so
  treat their gateway as serving their own customers' content, not as a general IPFS gateway.

**Measured 2026-09-17**, with the driver in `lib/backends/lighthouse.js` and the "Live backends"
workflow, on an account whose trial had run out:

|                                                  | Result                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| The API key, listing (`api/user/files_uploaded`) | accepted, `200`                                                                      |
| Any upload (`api/v0/add`)                        | `403` "Trial expired — Your trial period has expired. Please upgrade to a paid plan" |
| The gateway, for a CID it does not hold          | answers promptly; reported as not found                                              |

So uploads, the CAR round trip and a database restore are **not yet verified against a live
account** — that waits for a paid plan and is tracked in
[issue 60](https://github.com/NiKrause/@le-space/orbitdb-storage-bridge/issues/60). What the offline tests pin
down instead are the request and answer shapes of `@lighthouse-web3/sdk` 0.4.7. The driver reports
an expired plan as `UNSUPPORTED`, not as a bad key.

## 5. Pinata

The only candidate with a **pin-by-CID** endpoint, which for this library is the interesting one:
`pinata.upload.public.cid(cid)` returns `{ id, cid, status: "prechecking" | "retrieving" }` — the
service goes and fetches the content from the IPFS network. We already run Helia, so no bytes move
through a vendor API and hash preservation stops being something a service could get wrong.

**The delegation story is the best on this page.** Not UCAN, but real:

- **Presigned upload URLs** — `createSignedURL({ expires, maxFileSize, mimeTypes })`, minted server
  side and handed to a browser. Time-bounded, size-bounded, single-use. That is a capability.
- **Scoped keys over the API** — `keys.create` / `keys.revoke` with scopes such as `org:files:write`,
  so a per-user key can be minted and torn down instead of shared.
- **MPP server** — account-free uploads with no API key at all: `POST /v1/pin/public?fileSize={bytes}`
  answers `402 Payment Required`, you pay USDC on Tempo, and it returns a signed upload URL. For a
  browser with a wallet and no account, this is the shortest path on this page.

  **Measured 2026-09-09**, since the price was previously taken from the published formula. The 402
  carries a `www-authenticate: Payment …` header whose `request` is base64 JSON — amount, currency
  contract, `chainId 4217`, recipient:

  | file size | `amount` | at 6 decimals | `GB × $0.10 × 12` |
  | --------- | -------- | ------------- | ----------------- |
  | 1 KB      | 1000     | $0.0010       | $0.0000           |
  | 100 KB    | 1000     | $0.0010       | $0.0001           |
  | 1 MB      | 1200     | $0.0012       | $0.0012           |
  | 100 MB    | 117200   | $0.1172       | $0.1172           |
  | 1 GB      | 1200000  | $1.2000       | $1.2000           |

  The formula holds exactly from 1 MB up, and a gigabyte is $1.20 as stated. **The floor is $0.001,
  not $0.01** — an earlier reading of this page was out by a factor of ten, and with it the
  conclusion that "$0.01 covers anything up to ~80 MB": 80 MB quotes about $0.094. The floor bites
  below roughly 1 MB, which is the size range an OrbitDB backup actually lives in, so the difference
  matters here more than at the top of the table.

  Two things the probe does not settle: the currency contract's decimals are inferred from the
  formula matching at 1e6 rather than read from the chain, and each quote carries a `challengeId`
  with a short `expires`, so a driver has to pay against the quote it was given rather than cache
  a price.

**Limits.** 60 requests/minute on the free tier (250 Picnic, 500 Fiesta), 30/minute on `data/`
endpoints; 25 GB per upload, resumable required above 100 MB; 10 MB for `pinJSONToIPFS`.

**Limitations**

- **"Binary files are only allowed on a case by case basis, please contact team@pinata.cloud."**
  A CAR is `application/octet-stream`. This one line could invalidate the whole class-2 path here and
  has to be tested before Pinata is trusted with CAR backups — the pin-by-CID path sidesteps it.

  **Measured 2026-09-17 on the free plan**, with the driver in `lib/backends/pinata.js` and the
  "Live backends" workflow:

  |                                                                               | Result                                                                                                                                      |
  | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
  | Upload, listing, deletion (v3 API)                                            | work                                                                                                                                        |
  | A CAR uploaded as a plain file                                                | accepted, and comes back byte for byte — the line above did not bite                                                                        |
  | Pin by CID                                                                    | `403` "This feature is not supported by the current plan type" — paid plans only                                                            |
  | Reads through the shared `gateway.pinata.cloud`                               | `429` during the restore suite, after the conformance suite's reads                                                                         |
  | Reads through the account's dedicated gateway                                 | a fresh upload is served within 2–3 s; all 51 conformance and restore tests pass                                                            |
  | A dedicated gateway from a _different_ account than the key                   | `403` "The owner of this gateway does not have this content pinned to their Pinata account" (ERR_ID:00006) for every read, still after 96 s |
  | A file name with a path (`<space>/backup-…`, as `backupDatabase` names files) | stored as a folder: the upload answers with the folder's CID, and a gateway serves its HTML listing                                         |

  So the driver makes pin by CID opt-in (`pinByCid: true`) like CAR import, waits out gateway 429s,
  uploads only the last segment of a file name (the full name stays the upload's `name`), accepts a
  gateway as the bare domain the dashboard shows, and wants the dedicated gateway **of the key's own
  account** as `gateway` for anything beyond a test. The live workflow checks that pairing before
  its suites run.

- A company with an account, a plan and a rate limit. No proofs, no on-chain anything, no way to
  verify a backup exists other than asking them.
- HTML retrieval needs a dedicated gateway with a custom domain.

## 6. Aleph Cloud

Probed directly on 2026-09-05, because your own `relay-button` and `shared-aleph-tooling` already
post to these endpoints:

| Endpoint on `ipfs.aleph.cloud` / `ipfs-2.aleph.im`              | Result                                                                                                                                                                |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v0/add`                                              | `400` on an empty body — exists, **no API key**, response carries `access-control-allow-origin: *`, `access-control-allow-credentials: true`, `server: Aleph.im IPFS` |
| `POST /api/v0/dag/import`                                       | `404`                                                                                                                                                                 |
| `POST /api/v0/block/put`, `/dag/put`, `/pin/add`, `/cat`, `/id` | `404`                                                                                                                                                                 |

So: **yes, a browser can post to Aleph IPFS directly, with no API key and no proxy.** That answers
the question this section exists for. Two qualifications, both from the same probe:

- **Only `add` exists.** No CAR import, no `block/put`, so dag-cbor OrbitDB blocks cannot be written
  with their own CIDs. The CAR goes up as one opaque file and the inner CIDs come back when we import
  it into Helia ourselves — the same trick as FOC, for the same reason.
- **`add` is ingest, not persistence.** Retention comes from a wallet-signed STORE message with the
  `ipfs` storage engine — `aleph.storage.pinIpfs()` in the JS SDK, `aleph file pin <CID>` on the CLI,
  posted to `api2.aleph.im/api/v0/messages`. So Aleph is class-2 for the bytes and class-1 for the
  pin, and the browser needs a wallet but never a bearer token. Retrieval is
  `https://ipfs.aleph.cloud/ipfs/<cid>`.

**Cost** is the open question. The figure in circulation — 3 MB of storage per ALEPH token held by
the signing wallet — is from the November 2022 tokenomics, and `relay-button` already pays for VMs
in credits, so the model has moved. Check it against a current account before planning around it.

## 7. Your own relay

The most interesting backend here is not a vendor. [`relay-button`](https://github.com/NiKrause/relay-button)
already deploys an internet-reachable libp2p and OrbitDB relay on Aleph from a button inside the app,
paid from the user's own credits and stopped when the collaboration ends — and of the relays in that
family, `orbitdb-relay` is the one that stores something rather than only brokering connections.

A relay the user owns holds no third-party bearer token, can mint Pinata presigned URLs for its own
browsers, and is already the peer the p2p-first restore path talks to. It reframes "server relay vs
browser app" from a limitation into the missing tier: the browser keeps the data, the relay keeps it
reachable, and a paid backend is the third copy rather than the only one.

## 8. Cost sketch

A 5 MB database, one timestamped backup a day, one year kept. Assumptions visible so you can redo them.

|             | Filecoin Onchain Cloud                                                    | Lighthouse                  |
| ----------- | ------------------------------------------------------------------------- | --------------------------- |
| Year-1 data | ~1.8 GB                                                                   | ~1.8 GB                     |
| Storage     | ~$0.10/year (2 copies)                                                    | $3.60–9.00 **once**         |
| Fixed fees  | $1.44/year proving + ~$0.50 refundable reserve                            | none                        |
| Per-backup  | one on-chain fee × 365 — **unmeasured, and the number that decides this** | included                    |
| Year 2+     | same again                                                                | pay again only for new data |
| Stop paying | data goes                                                                 | data stays                  |

The crossover: below a few GB kept for many years, Lighthouse's one-time payment beats FOC's fixed
floor. Above that, or when backups expire and get deleted, FOC's rental model wins. For a single small
database backed up rarely, Lighthouse is cheaper by an order of magnitude; for a churning
backup-per-mutation workload, the FOC per-operation fee is the whole cost and has to be measured before
choosing.

## 8b. Choosing one, or several, from a page

Two pieces sit between the drivers above and an application that lets somebody pick.

**`createBackendFromChoice({ kind, ... })`** turns a name and, where a service needs one, a
credential into a driver — which is what a page has, since a reader ticks a service and pastes
their own key. Every vendor module is imported lazily, so a page that chose Aleph ships neither
the Pinata nor the Lighthouse driver. A missing key is refused there and then, with the service
named, rather than at the first upload, so a button can be disabled with a reason. `resolveBackend`
accepts the same `kind`, so there is one decision rather than two.

```js
const backend = await createBackendFromChoice({
  kind: "lighthouse",
  apiKey,
  keyOwnership: "user",
});
```

`keyOwnership: "user"` is not decoration: it is what makes `browserSafeAuth` true, and it is only
honest when the reader minted that key themselves.

**A gateway is part of the choice**, and since the public path gateways were retired on 2026-09-21
it is usually the reader's own account's — `<name>.mypinata.cloud`, `<name>.lighthouseweb3.xyz` —
because the shared ones either want that account's key or answer `402`:

```js
const backend = await createBackendFromChoice({
  kind: "pinata",
  jwt,
  gateway: "silver-fox.mypinata.cloud", // a bare domain is read as https
});
```

The two services' gateways are not interchangeable — Pinata's answers `401` for content it does
not hold, Lighthouse's answers `402` — so with several services chosen, `gateway` is an object and
a single string is refused rather than handed to all of them:

```js
const backend = await createBackendFromChoice({
  kind: ["pinata", "lighthouse"],
  jwt,
  apiKey,
  gateway: {
    pinata: "https://silver-fox.mypinata.cloud",
    lighthouse: "https://preferred-cat.lighthouseweb3.xyz",
  },
});
```

Aleph's driver tries a list rather than one host, so a single `gateway` becomes a list of one,
with `/ipfs` appended where it is missing. Pass `gateways` instead to give it the whole list; it
wins over `gateway` where both are set.

**`createMirrorBackend([...])`** writes one backup to several services and reads it back from
whichever answers first, behind the same contract, so `dehydrate` and `restoreFromCID` need to know
nothing about it.

```js
const backend = await createBackendFromChoice({
  kind: ["aleph", "lighthouse"],
  apiKey,
});
```

What it promises, and what it refuses to:

|                                                      |                                                                                                                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a partial write                                      | reported, never swallowed: by default one service is enough, and the handle names who holds it and who refused. `require: "all"` when a copy everywhere is the point           |
| a read                                               | asks in order, stops at the first answer. Not a race — a race spends every service's bandwidth on every read, and on a gateway that bills per request that is somebody's money |
| `browserSafeAuth`, `carImport`, `preservesInnerCids` | true only when **every** member is, because the weakest one decides what a page leaks                                                                                          |
| `minBlobSize`                                        | the **largest** of them: a blob has to clear the strictest door                                                                                                                |
| `pinByCid`                                           | true when **any** member can pin, and only those are asked                                                                                                                     |
| `list()`, `remove()`                                 | not offered. A listing would be a union with duplicates, and a half-succeeded deletion leaves a copy behind while reporting success. Ask the service you mean                  |

## 9. Recommendation

1. **Extract the backend interface before picking a backend.** `putBlob` / `getBlob` / `list` /
   `remove`, plus an optional `pinCid` for the class-1 backends and a `capabilities` object so the
   bridge picks a strategy instead of hardcoding one. The May 2026 lesson is that the backend is the
   volatile part of this library; right now it is spread across 35 call sites in
   `lib/orbitdb-storacha-bridge.js`, `lib/backup-car.js` and `lib/ucan-bridge.js`.
2. **Make the CAR path the default.** It is the only path that survives a minimum piece size, and the
   only one where "the backend never sees our CIDs" makes hash preservation structural rather than a
   property we hope a service preserves.
3. **Prefer pin-by-CID wherever it exists.** Pinata's `upload.public.cid` and Aleph's STORE-with-ipfs
   engine let us publish through Helia and ask the service to hold what is already ours. It is the
   only class of backend that cannot silently change our hashes, and the cheapest one to authorise
   from a browser. On Pinata it needs a paid plan (measured 2026-09-17).
4. **Three drivers, three failure domains.** Pinata for reach and the best delegation primitives
   available, Aleph for keyless browser ingest and because your own tooling already speaks it, FOC
   for the one property none of the others have — an on-chain answer to "is my backup still there?".
   Lighthouse when a small archive should be paid for once and forgotten.
5. **Keep the peers primary, and the user's own relay above any vendor.**
   [`relay-button`](https://github.com/NiKrause/relay-button) and
   [`orbitdb-relay-pinner`](https://github.com/NiKrause/orbitdb-relay-pinner) are what made the 504s
   at the top of this page survivable at all. A paid backend is the third copy, not the copy.

The phased plan built on this is [issue 54](https://github.com/NiKrause/@le-space/orbitdb-storage-bridge/issues/54), kept out of
this page so a stale plan cannot be mistaken for a fact.

**Open questions to measure before committing**

- ~~Whether Pinata accepts a CAR at all.~~ Answered 2026-09-17: as a plain file, yes, on the free
  plan — see the table in section 5.
- The FOC per-operation provider fee, at the backup frequency we actually want.
- Whether a CAR round-trips byte-identically through Lighthouse's `dag/import` — verify by CID, not
  by trusting the API.
- What Aleph storage costs on a current account; the 3 MB-per-ALEPH figure is from 2022 and the
  credits model has moved since.
- Session keys in the browser: can one authorise a whole backup session without a popup per piece?
- Whether anything of the UCAN work (`lib/ucan-bridge.js`, 921 lines) is portable, or whether it was a
  Storacha-shaped feature that dies with Storacha. The nearest survivors are FOC session keys and
  Pinata presigned URLs — both capability-plus-expiry, neither a UCAN.
