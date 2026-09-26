# CAR-Based Timestamped Backup

Alternative implementation for OrbitDB backups using Content Addressable Archive (CAR) format with timestamps.

## 📋 Overview

This implementation provides an alternative to the existing individual block upload approach, offering:

- **✅ Timestamped Backups** - Multiple backup versions without overwriting
- **✅ Efficient Storage** - Single CAR file instead of many individual blocks
- **✅ Browser Compatible** - Works in both Node.js and browsers (no filesystem required)
- **✅ Backward Compatible** - Coexists with existing backup approach
- **✅ Progress Events** - Real-time progress for UI integration

## 🆚 Comparison: CAR vs Legacy Backup

| Feature | Legacy (Individual Blocks) | CAR (Timestamped) |
|---------|---------------------------|-------------------|
| **Files Created** | Many (1 per block) | 2 (metadata + CAR) |
| **Timestamps** | ❌ No | ✅ Yes |
| **Multiple Versions** | ❌ Overwrites | ✅ Keeps all |
| **Upload Efficiency** | Many small uploads | 2 larger uploads |
| **Browser Support** | ✅ Yes | ✅ Yes |
| **Organization** | Flat list | Grouped by timestamp |

**Example:**
```
Legacy approach (42 blocks):
  zdpuB2rhHeykxLvtwpM...
  zdpuAkRhvQrPnCw8Mx...
  zdpuFxKwNmPqZt2Vn7...
  ... (39 more files)

CAR approach (same 42 blocks):
  my-space/backup-2025-10-27T14-30-00-123Z-metadata.json
  my-space/backup-2025-10-27T14-30-00-123Z-blocks.car
```

## 🚀 Quick Start

### Installation

Already included! Import from `lib/backup-car.js`:

```javascript
import { backupDatabaseCAR, restoreFromSpaceCAR } from './lib/backup-car.js'
```

### Basic Usage

```javascript
import { backupDatabaseCAR, restoreFromSpaceCAR } from './lib/backup-car.js'
import { createHeliaOrbitDB } from './lib/utils.js'

// Create and populate database
const node = await createHeliaOrbitDB()
const db = await node.orbitdb.open('my-database', { type: 'events' })
await db.add('Important data')

// Backup with timestamp
const backupResult = await backupDatabaseCAR(node.orbitdb, db.address, {
  spaceName: 'my-project',
  storachaKey: process.env.STORACHA_KEY,
  storachaProof: process.env.STORACHA_PROOF
})

console.log(`Backup created: ${backupResult.backupFiles.metadata}`)
// Output: my-project/backup-2025-10-27T14-30-00-123Z-metadata.json

// Restore from latest backup
const restoreResult = await restoreFromSpaceCAR(node.orbitdb, {
  spaceName: 'my-project',
  storachaKey: process.env.STORACHA_KEY,
  storachaProof: process.env.STORACHA_PROOF
})

console.log(`Restored ${restoreResult.entriesRecovered} entries`)
```

### Advanced: List and Restore Specific Backups

```javascript
import { listAvailableBackups, restoreFromSpaceCAR } from './lib/backup-car.js'

// Step 1: List all available backups
const backups = await listAvailableBackups({
  spaceName: 'my-project',
  storachaKey: process.env.STORACHA_KEY,
  storachaProof: process.env.STORACHA_PROOF
})

console.log(`Found ${backups.length} backups:`)
backups.forEach((backup, i) => {
  console.log(`${i + 1}. ${backup.date} (${backup.timestamp})`)
})

// Step 2: Restore from a specific backup (e.g., yesterday's backup)
const yesterdayBackup = backups[1]  // Assuming backups[0] is today

const result = await restoreFromSpaceCAR(node.orbitdb, {
  spaceName: 'my-project',
  timestamp: yesterdayBackup.timestamp,  // Restore specific version!
  storachaKey: process.env.STORACHA_KEY,
  storachaProof: process.env.STORACHA_PROOF
})

console.log(`Restored from ${new Date(result.backupTimestamp).toISOString()}`)

// Or restore from latest (default behavior)
const latest = await restoreFromSpaceCAR(node.orbitdb, {
  spaceName: 'my-project',
  // No timestamp = restores latest automatically
  storachaKey: process.env.STORACHA_KEY,
  storachaProof: process.env.STORACHA_PROOF
})
```

## 📚 API Reference

### `listAvailableBackups(options)`

Lists all available CAR-based backups in a space, sorted by timestamp (newest first).

**Parameters:**
- `options` (Object):
  - `spaceName` (String) - Space name where backups are stored (default: 'default')
  - `storachaKey` (String) - Storacha private key
  - `storachaProof` (String) - Storacha proof
  - `ucanClient` (Object) - Alternative: Pre-configured UCAN client
  - `spaceDID` (String) - Space DID for UCAN auth

**Returns:** `Promise<Array>`
```javascript
[
  {
    timestamp: '2025-10-27T14-30-00-123Z',
    metadata: 'backup-2025-10-27T14-30-00-123Z-metadata.json',
    blocks: 'backup-2025-10-27T14-30-00-123Z-blocks.car',
    date: '2025-10-27T14:30:00.123Z'
  },
  {
    timestamp: '2025-10-27T10-15-30-456Z',
    metadata: 'backup-2025-10-27T10-15-30-456Z-metadata.json',
    blocks: 'backup-2025-10-27T10-15-30-456Z-blocks.car',
    date: '2025-10-27T10:15:30.456Z'
  }
]
```

**Example:**
```javascript
import { listAvailableBackups } from './lib/backup-car.js'

const backups = await listAvailableBackups({
  spaceName: 'my-project',
  storachaKey: process.env.STORACHA_KEY,
  storachaProof: process.env.STORACHA_PROOF
})

console.log(`Found ${backups.length} backups`)
backups.forEach(backup => {
  console.log(`  - ${backup.date}`)
})
```

### `backupDatabaseCAR(orbitdb, databaseAddress, options)`

Creates a timestamped CAR-based backup.

**Parameters:**
- `orbitdb` (Object) - OrbitDB instance
- `databaseAddress` (String) - Database address to backup
- `options` (Object):
  - `spaceName` (String) - Space name for organizing backups (default: 'default')
  - `storachaKey` (String) - Storacha private key
  - `storachaProof` (String) - Storacha proof
  - `ucanClient` (Object) - Alternative: Pre-configured UCAN client
  - `spaceDID` (String) - Space DID for UCAN auth
  - `eventEmitter` (EventEmitter) - For progress updates

**Returns:** `Promise<Object>`
```javascript
{
  success: true,
  method: 'car-timestamped',
  manifestCID: 'zdpu...',
  databaseAddress: '/orbitdb/zdpu...',
  databaseName: 'my-database',
  blocksTotal: 42,
  carFileSize: 123456,
  blockSummary: { log_entry: 40, manifest: 1, identity: 1 },
  backupFiles: {
    metadata: 'my-space/backup-2025-10-27T14-30-00-123Z-metadata.json',
    blocks: 'my-space/backup-2025-10-27T14-30-00-123Z-blocks.car',
    metadataCID: 'bafk...',
    carCID: 'bafk...'
  },
  timestamp: 1698412200123
}
```

### `restoreFromSpaceCAR(orbitdb, options)`

Restores from a CAR-based backup in a space. By default, restores from the latest backup.

**Parameters:**
- `orbitdb` (Object) - OrbitDB instance
- `options` (Object):
  - `spaceName` (String) - Space name where backups are stored (default: 'default')
  - `timestamp` (String) - **Optional:** Specific backup timestamp to restore (e.g., '2025-10-27T14-30-00-123Z')
                           If omitted, restores from the latest backup
  - `storachaKey` (String) - Storacha private key
  - `storachaProof` (String) - Storacha proof
  - `ucanClient` (Object) - Alternative: Pre-configured UCAN client
  - `spaceDID` (String) - Space DID for UCAN auth
  - `eventEmitter` (EventEmitter) - For progress updates

**Returns:** `Promise<Object>`
```javascript
{
  success: true,
  method: 'car-timestamped',
  database: OrbitDB instance,
  databaseAddress: '/orbitdb/zdpu...',
  name: 'my-database',
  type: 'events',
  entriesRecovered: 100,
  blocksRestored: 42,
  backupTimestamp: 1698412200123,
  backupUsed: {
    metadata: 'backup-2025-10-27T14-30-00-123Z-metadata.json',
    blocks: 'backup-2025-10-27T14-30-00-123Z-blocks.car',
    timestamp: '2025-10-27T14-30-00-123Z'
  }
}
```

## 🌐 Browser Usage

Works seamlessly in browsers without any filesystem access:

```html
<!DOCTYPE html>
<html>
<head>
  <title>OrbitDB CAR Backup</title>
</head>
<body>
  <button id="backup">Create Backup</button>
  <button id="restore">Restore</button>
  <div id="status"></div>

  <script type="module">
    import { backupDatabaseCAR, restoreFromSpaceCAR } from './lib/backup-car.js'
    import { createHeliaOrbitDB } from './lib/utils.js'

    const status = document.getElementById('status')
    let orbitdb, database

    // Initialize
    async function init() {
      orbitdb = await createHeliaOrbitDB()
      database = await orbitdb.orbitdb.open('browser-db', { type: 'events' })
      await database.add('Browser data!')
    }

    // Backup handler
    document.getElementById('backup').addEventListener('click', async () => {
      status.textContent = 'Creating backup...'
      
      const result = await backupDatabaseCAR(orbitdb.orbitdb, database.address, {
        spaceName: 'browser-backups',
        storachaKey: 'your-key',
        storachaProof: 'your-proof'
      })
      
      if (result.success) {
        status.textContent = `✅ Backup created: ${result.backupFiles.metadata}`
      } else {
        status.textContent = `❌ Backup failed: ${result.error}`
      }
    })

    // Restore handler
    document.getElementById('restore').addEventListener('click', async () => {
      status.textContent = 'Restoring...'
      
      const result = await restoreFromSpaceCAR(orbitdb.orbitdb, {
        spaceName: 'browser-backups',
        storachaKey: 'your-key',
        storachaProof: 'your-proof'
      })
      
      if (result.success) {
        status.textContent = `✅ Restored ${result.entriesRecovered} entries`
      } else {
        status.textContent = `❌ Restore failed: ${result.error}`
      }
    })

    init()
  </script>
</body>
</html>
```

## 📊 Progress Events

Track backup/restore progress for UI updates:

```javascript
import { EventEmitter } from 'events'

const emitter = new EventEmitter()

// Listen to backup progress
emitter.on('backupProgress', (data) => {
  switch (data.status) {
    case 'creating':
      console.log(`Creating CAR with ${data.totalBlocks} blocks...`)
      break
    case 'uploading-metadata':
      console.log('Uploading metadata...')
      break
    case 'uploading-blocks':
      console.log(`Uploading CAR (${data.size} bytes)...`)
      break
    case 'completed':
      console.log(`✅ Complete! CIDs: ${data.metadataCID}, ${data.carCID}`)
      break
    case 'error':
      console.error(`❌ Error: ${data.error}`)
      break
  }
})

// Create backup with progress tracking
await backupDatabaseCAR(orbitdb, dbAddress, {
  spaceName: 'my-space',
  storachaKey: '...',
  storachaProof: '...',
  eventEmitter: emitter
})
```

## 🔄 Migration Guide

### From Legacy to CAR

Both approaches coexist! You can use them side-by-side:

```javascript
// Old code still works
import { backupDatabase, restoreDatabaseFromSpace } from './lib/orbitdb-storacha-bridge.js'

await backupDatabase(orbitdb, dbAddress, { /* options */ })

// New CAR approach
import { backupDatabaseCAR, restoreFromSpaceCAR } from './lib/backup-car.js'

await backupDatabaseCAR(orbitdb, dbAddress, { 
  spaceName: 'my-backups',  // Add this for organization
  /* same options */ 
})
```

### When to Use Each

**Use Legacy (Individual Blocks) when:**
- ✅ You need compatibility with existing backups
- ✅ You want to minimize single-file size
- ✅ Your backup process already works

**Use CAR (Timestamped) when:**
- ✅ You need multiple backup versions
- ✅ You want more efficient uploads
- ✅ You want better organization
- ✅ You're starting a new project

## 🧪 Testing

Run the test suite:

```bash
npm test test/backup-car.test.js
```

Tests cover:
- ✅ CAR file creation and reading
- ✅ Browser compatibility (no filesystem)
- ✅ Backward compatibility with legacy
- ✅ Progress events
- ✅ Error handling
- ✅ Timestamped filename generation

## 🛠️ Troubleshooting

### "No valid CAR backup found"

Make sure you're using the same `spaceName` for backup and restore:

```javascript
// Backup
await backupDatabaseCAR(orbitdb, db, { spaceName: 'my-space' })

// Restore - use same spaceName!
await restoreFromSpaceCAR(orbitdb, { spaceName: 'my-space' })
```

### CAR file too large

The CAR file size equals the sum of all blocks. For large databases, this is normal:

```javascript
// Check size in result
const result = await backupDatabaseCAR(orbitdb, db, options)
console.log(`CAR size: ${result.carFileSize} bytes`)
console.log(`Contains: ${result.blocksTotal} blocks`)
```

### Browser memory issues

For very large databases in browsers, consider:
1. Using pagination during extraction
2. Implementing chunked uploads
3. Using Web Workers for CAR creation

## 📖 Examples

Every backup is a CAR now, so the ordinary demos are the CAR demos:

```bash
node examples/backup-demo.js                      # one CAR, and the CID that names it
BACKUP_CID=<cid> node examples/restore-demo.js    # read it back on a fresh node
```

`examples/storacha/car-backup-demo.js` is the older one. It found its backups by
listing a Storacha space, which is why it is archived: the backends this library
speaks to now hand back a CID instead.

## 🔗 Related Documentation

- [Main README](../README.md) — project overview
- [DESIGN.md](DESIGN.md) — how a backup and a restore work
- [STORAGE-BACKENDS.md](STORAGE-BACKENDS.md) — where a CAR can be stored, and what each service costs

The UCAN authentication and P-256 security documents this section used to link were deleted in
`de42fd2`; what survives of them is [STORACHA-UI-HISTORY.md](STORACHA-UI-HISTORY.md) and the tests
in `test/p256-ucan-security.test.js`.
