# CAR backups

Every backup this package makes is a CAR — a Content Addressed Archive — and this page is about that
unit, not about a backend. [DESIGN.md](DESIGN.md) says why: the backend sees one opaque blob, so
nothing it does with chunking or codecs can change the CIDs inside, and a restored database is the
same database. A per-block backup is refused on a backend whose capabilities cannot take blocks as
they are (`assertCanTakeBlocks`); the CAR is the default.

## The pair everything builds on

```js
import { createCARFromBlocks, readBlocksFromCAR } from "@le-space/orbitdb-storage-bridge/backup-car";

const car = await createCARFromBlocks(blocks, rootCID); // a Map of CID → bytes, and the root
const back = await readBlocksFromCAR(car);
```

`readBlocksFromCAR` reads the blocks back; `restoreFromBlocks` (`./restore-cid`) is what verifies
each one against its CID before it goes anywhere, because `CarReader` does not.

## One database, one CAR

```js
import { backupDatabaseCAR } from "@le-space/orbitdb-storage-bridge/backup-car";
import { restoreFromCID } from "@le-space/orbitdb-storage-bridge/restore-cid";

const { backupFiles } = await backupDatabaseCAR(orbitdb, address, { backend });
// backupFiles.carCID, backupFiles.metadataCID

await restoreFromCID(orbitdb, { metadataCID: backupFiles.metadataCID, gateways });
```

`backupDatabaseCAR` extracts the database's blocks — log entries, manifest, access controller, the
writers' identities — packs them into one CAR, and uploads it and a small metadata file
(`backup-<timestamp>-blocks.car`, `backup-<timestamp>-metadata.json`) through the backend that
`resolveBackend` picks from the options. `spaceName` is a label kept in the metadata; `eventEmitter`
hears the progress. Restore is by the metadata CID: `restoreFromCID` fetches it and the CAR it
names over HTTP gateways, or through a `fetchBytes` of the caller's (`peer-fetch`), and verifies
every block; `restoreFromBlocks` takes blocks fetched by other means.

## The Storacha-era listing

`listAvailableBackups` and `restoreFromSpaceCAR` need a backend with `listing`, and find a backup by
downloading every file in the listing to see which is metadata, because Storacha returned CIDs and
no names. They are kept for the in-memory service the tests use; no live backend lists this way.
To find a backup again today: by CID; by the IPNS pointer `dehydrate` publishes from a secret
([RECOVERY-ON-A-SECOND-DEVICE.md](RECOVERY-ON-A-SECOND-DEVICE.md)); or, on Aleph, by the paying
account with `listAlephStores` ([APP-BACKUP.md](APP-BACKUP.md)).

## The newer shapes

- [APP-BACKUP.md](APP-BACKUP.md): several databases and the application's own blocks in one CAR,
  sealed, with a keyring header read without a key.
- [LIVE-BACKUP.md](LIVE-BACKUP.md): what was written since the last backup, as one small CAR per
  increment.

## Tests

```sh
npm run test:car-backup
```
