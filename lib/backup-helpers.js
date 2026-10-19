/**
 * Helper functions for timestamped backup feature
 */
import { logger } from "./logger.js";

/**
 * Generate backup prefix with timestamp
 *
 * @param {string} spaceName - a label kept in the metadata (a Storacha space, once)
 * @returns {string} - Backup prefix including timestamp
 */
export function generateBackupPrefix(spaceName) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${spaceName}/backup-${timestamp}`;
}

// `getBackupFilenames` and `isValidMetadata` live in `backup-metadata.js`,
// which imports nothing — so a browser consumer can read a backup without
// pulling a logging framework in behind a predicate (issue #58). Re-exported
// here so every existing importer keeps working.
export { getBackupFilenames, isValidMetadata } from "./backup-metadata.js";

/**
 * Find the latest valid backup in a space
 *
 * @param {Array} spaceFiles - List of files in the space
 * @param {Object} options - Options
 * @param {Function} options.onWarning - Warning callback
 * @returns {Object|null} - Latest valid backup or null
 */
export function findLatestBackup(spaceFiles, options = {}) {
  const { onWarning, verbose = false } = options;
  const warn =
    onWarning ||
    (verbose
      ? (message) => {
          logger.debug(message);
        }
      : () => {});
  const filenames = spaceFiles.map((f) => f.root.toString());

  // Group files by full backup path (preserving directory structure)
  const backupGroups = new Map();
  for (const file of filenames) {
    // Match pattern: (optional-prefix/)backup-(timestamp)-(metadata.json|blocks.car)
    const match = file.match(/^(.*)backup-(.*?)-(metadata\.json|blocks\.car)$/);
    if (match) {
      const [, prefix, timestamp, type] = match;
      const backupKey = `${prefix}backup-${timestamp}`;

      if (!backupGroups.has(backupKey)) {
        backupGroups.set(backupKey, { files: new Set(), timestamp, prefix });
      }
      backupGroups.get(backupKey).files.add(type);
    }
  }

  // Find complete and valid backups
  const completeBackups = Array.from(backupGroups.entries())
    .filter(([backupKey, { files }]) => {
      const isComplete = files.has("metadata.json") && files.has("blocks.car");
      if (!isComplete) {
        warn(`⚠️ Incomplete backup found: ${backupKey}-*`);
        files.forEach((file) => {
          warn(`   Orphaned file: ${backupKey}-${file}`);
        });
      }
      return isComplete;
    })
    .sort((a, b) => b[1].timestamp.localeCompare(a[1].timestamp)); // Sort descending by timestamp

  if (completeBackups.length === 0) {
    if (backupGroups.size > 0) {
      warn(
        "⚠️ No complete backup sets found (missing metadata or blocks files)",
      );
    }
    return null;
  }

  const [backupKey, { timestamp }] = completeBackups[0];
  return {
    metadata: `${backupKey}-metadata.json`,
    blocks: `${backupKey}-blocks.car`,
    timestamp: timestamp,
  };
}
