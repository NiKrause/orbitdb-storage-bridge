# Why Storacha stopped being the default

Moved out of the README, because it is history rather than reference. The current backends are in
[STORAGE-BACKENDS.md](STORAGE-BACKENDS.md).

Storacha switched off user writes in **May 2026** and has since decommissioned the service.
Verified on 2026-09-05:

| Check | Result |
| --- | --- |
| `up.storacha.network`, `console.storacha.network`, `indexer.storacha.network`, `forge.storacha.network` | no DNS record — upload, console and indexing endpoints are gone |
| `storacha.network`, `docs.storacha.network` | `301` → `fil.one`, the team's new S3-compatible product |
| `storacha.link`, `w3s.link` | `301` → `dweb.link`; the gateways only forward to the public IPFS gateway now |
| the widget demo CID linked in the roadmap below | `504` on `w3s.link`, `dweb.link`, `ipfs.io` and `trustless-gateway.link` |
| `@storacha/client` on npm | last release `2.1.4`, 2026-05-15, not marked deprecated |

The gateway those redirects pointed at is gone too. On **2026-09-21** Protocol Labs retired
`ipfs.io` and `dweb.link`: both answer `429` with an RFC 8594 `Sunset` header and a link to
[gatewaychanges.ipfs.io](https://gatewaychanges.ipfs.io/), so `storacha.link` and `w3s.link`
now redirect to a closed door. Retrieval defaults here are `ipfs.aleph.cloud` — the one free
path gateway measured still serving arbitrary CIDs on 2026-09-23 — with
`trustless-gateway.link` available for verifiable single-block requests
(`Accept: application/vnd.ipld.raw`). One host is not a fallback chain, which is why `peer-fetch.js` fetches from the providers that
hold the blocks instead — bitswap over libp2p, measured from a real page at 0.73 s to dial and
0.26 s for the block, with no credential in the path. See
[RECOVERY-ON-A-SECOND-DEVICE.md](RECOVERY-ON-A-SECOND-DEVICE.md).

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

- **The Storacha driver is dead, the library is not.** Backup goes to Aleph, Pinata or Lighthouse
  instead, and `lib/backends/storacha.js` is kept because the in-memory upload-api in `test/helpers/`
  still speaks the protocol and because it is the reference for what a UCAN-delegated backend looked
  like when one existed.
- **Restore reaches whatever still holds the blocks.** A CID is a name anyone can resolve, so
  `peer-fetch` asks the peers that hold them; what it cannot do is ask Storacha, whose listing and
  gateway are gone.
- **The OrbitDB half never depended on any of it.** Block extraction, CID bridging, CAR packing,
  identity preservation and `courier-sync` are backend-agnostic.

If you still have an OrbitDB instance with the blocks in it, re-pin them somewhere else: the data is
only as alive as whatever holds it.
