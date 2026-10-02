/**
 * Extracting a database's blocks — the half of a backup that reads.
 *
 * Its own module, and not part of the main entry, because the main entry
 * imports `@storacha/client` at the top: a browser that backs up to Aleph
 * would otherwise carry the whole Storacha SDK to call this one function.
 * The same reason `restore-cid.js` exists (issue #58).
 */

import { CID } from "multiformats/cid";
import * as Block from "multiformats/block";
import * as dagCbor from "@ipld/dag-cbor";
import { sha256 } from "multiformats/hashes/sha2";
import { logger } from "./logger.js";

/**
 * Extract blocks from an OrbitDB database
 *
 * @param {Object} database - OrbitDB database instance
 * @param {Object} options - Extraction options
 * @param {boolean} [options.logEntriesOnly] - If true, only extract log entries (for fallback reconstruction)
 * @returns {Promise<Object>} - { blocks, blockSources, manifestCID }
 */
export async function extractDatabaseBlocks(database, options = {}) {
  const logEntriesOnly = options.logEntriesOnly || false;
  const extractionMode = logEntriesOnly
    ? "log entries only (fallback mode)"
    : "all blocks";

  logger.info(
    `🔍 Extracting ${extractionMode} from database: ${database.name}`,
  );

  const blocks = new Map();
  const blockSources = new Map();

  // 1. Get all log entries
  const entries = await database.log.values();
  logger.info(`   Found ${entries.length} log entries`);

  for (const entry of entries) {
    try {
      const entryBytes = await database.log.storage.get(entry.hash);
      if (entryBytes) {
        const entryCid = CID.parse(entry.hash);
        blocks.set(entry.hash, { cid: entryCid, bytes: entryBytes });
        blockSources.set(entry.hash, "log_entry");
        logger.info(`   ✓ Entry block: ${entry.hash}`);
      }
    } catch (error) {
      logger.warn(`   ⚠️ Failed to get entry ${entry.hash}: ${error.message}`);
    }
  }

  // Get manifest CID for metadata (always extract this regardless of mode)
  const addressParts = database.address.split("/");
  const manifestCID = addressParts[addressParts.length - 1];

  // Only extract metadata blocks if NOT in log-entries-only mode
  if (!logEntriesOnly) {
    // 2. Get database manifest
    try {
      const manifestBytes = await database.log.storage.get(manifestCID);
      if (manifestBytes) {
        const manifestParsedCid = CID.parse(manifestCID);
        blocks.set(manifestCID, {
          cid: manifestParsedCid,
          bytes: manifestBytes,
        });
        blockSources.set(manifestCID, "manifest");
        logger.info(`   ✓ Manifest block: ${manifestCID}`);

        // Decode manifest to get access controller
        try {
          const manifestBlock = await Block.decode({
            cid: manifestParsedCid,
            bytes: manifestBytes,
            codec: dagCbor,
            hasher: sha256,
          });

          // Get access controller block
          if (manifestBlock.value.accessController) {
            const accessControllerCID =
              manifestBlock.value.accessController.replace("/ipfs/", "");
            try {
              const accessBytes =
                await database.log.storage.get(accessControllerCID);
              if (accessBytes) {
                const accessParsedCid = CID.parse(accessControllerCID);
                blocks.set(accessControllerCID, {
                  cid: accessParsedCid,
                  bytes: accessBytes,
                });
                blockSources.set(accessControllerCID, "access_controller");
                logger.info(`   ✓ Access controller: ${accessControllerCID}`);
              }
            } catch (error) {
              logger.warn(
                `   ⚠️ Could not get access controller: ${error.message}`,
              );
            }
          }
        } catch (error) {
          logger.warn(`   ⚠️ Could not decode manifest: ${error.message}`);
        }
      }
    } catch (error) {
      logger.warn(`   ⚠️ Could not get manifest: ${error.message}`);
    }

    // 3. Get identity blocks using identities system and from log entries
    logger.debug(
      `Getting identity blocks from identities system and log entries...`,
    );

    // Collect all identity references from log entries
    const referencedIdentities = new Set();
    for (const entry of entries) {
      if (entry.identity) {
        referencedIdentities.add(entry.identity);
      }
    }

    logger.info(
      `   📝 Found ${referencedIdentities.size} unique identity references in log entries`,
    );

    // Get identity blocks - try multiple approaches for robustness
    for (const identityHash of referencedIdentities) {
      try {
        // Method 1: the database's own identity, which carries its block. The
        // log's storage may not hold it — `Identities()` without `ipfs` keeps
        // identities in memory — and a Helia blockstore asked for it searches
        // the network until OrbitDB's 30-second timeout, then goes without.
        const ownIdentity = database.identity ?? database.log.identity;
        if (ownIdentity?.hash === identityHash && ownIdentity.bytes) {
          blocks.set(identityHash, {
            cid: CID.parse(identityHash),
            bytes: ownIdentity.bytes,
          });
          blockSources.set(identityHash, "identity_own");
          logger.info(`   ✓ Identity block (own): ${identityHash}`);
          continue;
        }

        // Method 2: Try to get identity from identities system (if available)
        if (
          database.log.identities &&
          typeof database.log.identities.getIdentity === "function"
        ) {
          try {
            const identity =
              await database.log.identities.getIdentity(identityHash);
            if (identity && identity.hash) {
              // Get the identity block from storage
              const identityBytes = await database.log.storage.get(
                identity.hash,
              );
              if (identityBytes) {
                const identityCid = CID.parse(identity.hash);
                blocks.set(identity.hash, {
                  cid: identityCid,
                  bytes: identityBytes,
                });
                blockSources.set(identity.hash, "identity_system");
                logger.info(`   ✓ Identity block (system): ${identity.hash}`);
                continue; // Skip other methods if this works
              }
            }
          } catch (systemError) {
            logger.warn(
              `   ⚠️ Identity system failed for ${identityHash}: ${systemError.message}`,
            );
          }
        } else {
          logger.info(
            `   ℹ️ Identity system not available, using direct storage access`,
          );
        }

        // Method 3: Try to get the identity hash directly from storage
        try {
          const identityBytes = await database.log.storage.get(identityHash);
          if (identityBytes && !blocks.has(identityHash)) {
            const identityCid = CID.parse(identityHash);
            blocks.set(identityHash, {
              cid: identityCid,
              bytes: identityBytes,
            });
            blockSources.set(identityHash, "identity_direct");
            logger.info(`   ✓ Identity block (direct): ${identityHash}`);
            continue; // Skip scanning if direct access works
          }
        } catch (directError) {
          logger.warn(
            `   ⚠️ Could not get identity ${identityHash} directly: ${directError.message}`,
          );
        }
      } catch (error) {
        logger.warn(
          `   ⚠️ Failed to get identity ${identityHash}: ${error.message}`,
        );
      }
    }

    // Additional scan through all storage blocks for any missed identity blocks
    logger.debug(`Scanning remaining storage blocks for missed identities...`);
    let discoveredIdentities = 0;

    for await (const [hash, bytes] of database.log.storage.iterator()) {
      try {
        // Skip if we already have this block
        if (blocks.has(hash)) {
          continue;
        }

        // Try to decode as CBOR to check if it's an identity block
        const cid = CID.parse(hash);
        if (cid.code === 0x71) {
          // dag-cbor codec
          const block = await Block.decode({
            cid,
            bytes,
            codec: dagCbor,
            hasher: sha256,
          });

          const content = block.value;

          // Check if this is an identity block (enhanced detection)
          if (content && content.id && (content.type || content.publicKey)) {
            blocks.set(hash, { cid, bytes });
            blockSources.set(hash, "identity_discovered");
            discoveredIdentities++;
            logger.info(
              `   ✓ Identity block discovered: ${hash}${referencedIdentities.has(hash) ? " (was referenced)" : " (unreferenced)"}`,
            );
          }
        }
      } catch {
        // Skip blocks that can't be decoded - they might be raw data or other formats
        continue;
      }
    }

    logger.info(
      `   📊 Identity blocks: ${referencedIdentities.size} referenced, ${discoveredIdentities} discovered`,
    );
  } else {
    logger.info(
      `   ⚡ Skipping manifest, access controller, and identity blocks (fallback mode)`,
    );
  }

  logger.info(`   📊 Extracted ${blocks.size} total blocks`);
  return { blocks, blockSources, manifestCID };
}

/**
 * Several databases in one backup: every block of each, in one Map, and the
 * metadata that names them all.
 *
 * The metadata is the shape `backupDatabaseCAR` writes and `isValidMetadata`
 * accepts — `databases` was always a list, and here it finally holds more than
 * one. Each entry also names the database's **heads**: `restoreFromBlocks` can
 * find them from the blocks alone, but a stated head says which entries the
 * writer considered current when the backup ran, and costs a few bytes.
 *
 * Blocks two databases share — a writer's identity — are kept once: the Map is
 * keyed by the CID string OrbitDB uses, and the same block has the same name.
 *
 * @param {Object[]|Object<string, Object>} databases opened OrbitDB databases,
 *   as a list or by name
 * @param {Object} [options]
 * @param {(progress: { stage: "database", index: number, total: number,
 *   name: string, address: string, entries: number, blocks: number }) => void}
 *   [options.onProgress] called after each database, with what it added
 * @param {number} [options.timestamp] ms since the epoch; injected for tests
 * @returns {Promise<{ blocks: Map<string, { cid: CID, bytes: Uint8Array }>,
 *   metadata: Object }>}
 */
export async function bundleDatabases(databases, options = {}) {
  const list = Array.isArray(databases) ? databases : Object.values(databases ?? {});
  if (list.length === 0) throw new Error("bundleDatabases needs at least one database");

  const blocks = new Map();
  const described = [];
  let totalEntries = 0;

  for (const [index, database] of list.entries()) {
    const before = blocks.size;
    const { blocks: own, manifestCID } = await extractDatabaseBlocks(database);
    for (const [name, block] of own) if (!blocks.has(name)) blocks.set(name, block);

    const entries = (await database.log.values()).length;
    const heads = (await database.log.heads()).map((head) => head.hash);
    totalEntries += entries;
    described.push({
      address: database.address,
      name: database.name,
      type: database.type,
      manifestCID,
      entryCount: entries,
      heads,
    });
    options.onProgress?.({
      stage: "database",
      index,
      total: list.length,
      name: database.name,
      address: database.address,
      entries,
      blocks: blocks.size - before,
    });
  }

  return {
    blocks,
    metadata: {
      version: "1.0",
      timestamp: options.timestamp ?? Date.now(),
      databaseCount: described.length,
      totalBlocks: blocks.size,
      totalEntries,
      // The first database's, so a reader of the one-database shape still finds one.
      manifestCID: described[0].manifestCID,
      databases: described,
    },
  };
}
