# Tests

Every suite is Jest (`npm test` runs them all, with `--experimental-vm-modules`). None needs a
credential or the network unless its row says so; the live ones skip themselves without their switch.

## OrbitDB, offline

| Suite | What it proves | Runs as |
| --- | --- | --- |
| `integration.test.js` | backup and restore end to end: CID mappings, key-value and documents with deletes, identity and access controller intact | `npm run test:integration` |
| `backup-car.test.js`, `car-storage.test.js`, `backup-car-browser.test.js` | the CAR path: packing, storage, and a browser's stand-ins for Node's streams | `npm run test:car-backup` |
| `timestamped-backup.test.js` | two files per backup, found by content in a listing | `npm run test:timestamped-backup` |
| `network-download.test.js` | a block from the IPFS network, and the gateway fallback | `npm run test:network-download` |
| `restore-cid.test.js` | a database from a CID, with no Storacha client anywhere | `npm test -- test/restore-cid.test.js` |
| `restore-from-blocks.test.js` | several databases in one backup, and back | |
| `restored-can-write.test.js` | the restored device writes, and the original takes it | |
| `extract-identity-blocks.test.js` | where a backup finds the identity that signed the entries | |
| `backup-bundle.test.js` | what a browser pays to back up | |
| `dehydrate.test.js`, `pointer-ipns.test.js` | a database where a second device finds it, with nothing but a key | |
| `courier-sync.test.js` | replication over a byte courier | |
| `live-backup.test.js` | increments: what was written since the last one, and the restore from a chain | |
| `app-backup.test.js` | an application's backup in one sealed file, and back | |
| `gateway-fetch.test.js`, `peer-fetch.test.js` | fetching by CID: a gateway that is wrong rather than down; peers instead of a gateway | |
| `access-control-integration.test.js`, `p256-ucan-security.test.js` | UCAN access control and P-256 UCANs, Storacha-era | `npm run test:p256-ucan` |
| `ipns-restore.test.js` | restore by IPNS, Storacha-era | |
| `storage-probe.test.js` | the probe page names the endpoints it talks to, and so does its code | |

## Backends

`npm run test:backends` runs `test/backends/`:

| Suite | What it proves |
| --- | --- |
| `conformance.test.js` | one contract for every driver, listed in `drivers.js`; the load-bearing test is the CAR round trip, and a capability a driver lacks skips rather than fails |
| `restore.test.js` | the other half of the contract: a database, not just its bytes |
| `car-first.test.js` | a CAR by default, and the refusals that make it worth it |
| `choose.test.js` | a backend from a name and a key — what a page has |
| `encryption.test.js` | a backup the service holding it cannot read |
| `mirror.test.js` | what a mirror promises across several services, and what it does not |
| `aleph-pin.test.js` | the STORE: what gets signed and what is never seen; the owner's authorizations; listing by owner and `ref`; waiting for a decision; FORGET |
| `pinata.test.js`, `lighthouse.test.js` | what each driver refuses to be, what it sends, how it reads |

The Storacha driver in the table runs against the in-memory upload-api in `helpers/`; the service
it imitates shut down on 2026-05-15, so `USE_PRODUCTION_STORACHA` has nothing left to reach.

## Live, opt-in

| Switch | What runs |
| --- | --- |
| `ALEPH_LIVE=true` | `backends/aleph-live.test.js`: the Aleph driver against the real host |
| `PINATA_LIVE=true` with `PINATA_JWT` (and `PINATA_GATEWAY`) | the live Pinata driver joins the conformance table; `backends/pinata-live.test.js` checks pin-by-CID, the full check only with `PINATA_PAID_PLAN=true` |
| `LIGHTHOUSE_LIVE=true` with `LIGHTHOUSE_API_KEY` | the live Lighthouse driver joins the conformance table |
| `GATEWAYS_LIVE=true` | `gateway-live.test.js`: are the gateways we default to still serving |

[`.github/workflows/live-backends.yml`](../.github/workflows/live-backends.yml) runs these four on
demand, and on a pull request labelled `live-backends`. Use keys you can revoke.
