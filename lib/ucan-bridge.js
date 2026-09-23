/**
 * OrbitDB Storage Bridge - UCAN Edition
 *
 * Enhanced version that supports UCAN-based authentication for Storacha,
 * eliminating the need for traditional storachaKey/storachaProof credentials.
 */

import * as Client from "@storacha/client";
import { StoreMemory } from "@storacha/client/stores/memory";
import { Signer } from "@storacha/client/principal/ed25519";
import * as Delegation from "@ucanto/core/delegation";
import * as Proof from "@storacha/client/proof";
import { CID } from "multiformats/cid";
import { promises as fs } from "fs";
import { EventEmitter } from "events";
import { logger } from "./logger.js";

// Import existing functions from the main bridge
import {
  extractDatabaseBlocks,
  convertStorachaCIDToOrbitDB,
  downloadBlock,
  analyzeBlocks,
  clearStorachaSpace as originalClearStorachaSpace,
  reconstructWithoutManifest,
} from "./orbitdb-storacha-bridge.js";

/**
 * Find the correct manifest block by matching log entries to database IDs
 * (Shared implementation with main bridge)
 *
 * @param {Object} analysis - Block analysis results
 * @returns {Object|null} - Correct manifest block or null if not found
 */
function findCorrectManifest(analysis) {
  logger.info("🎯 Finding correct manifest from log entries...");

  if (analysis.manifestBlocks.length === 1) {
    logger.info("   ✅ Only one manifest found, using it");
    return analysis.manifestBlocks[0];
  }

  if (analysis.manifestBlocks.length === 0) {
    logger.info("   ❌ No manifest blocks found");
    return null;
  }

  // Extract database IDs from log entries
  const databaseIds = new Set();
  for (const logEntry of analysis.logEntryBlocks) {
    if (logEntry.content && logEntry.content.id) {
      // Extract manifest CID from database address like '/orbitdb/zdpu...'
      const manifestCID = logEntry.content.id.replace("/orbitdb/", "");
      databaseIds.add(manifestCID);
      logger.info(
        `   📝 Log entry references database: ${logEntry.content.id} (manifest: ${manifestCID})`,
      );
    }
  }

  logger.info(
    `   🔍 Found ${databaseIds.size} unique database ID(s) from ${analysis.logEntryBlocks.length} log entries`,
  );

  // Find manifest that matches the most referenced database ID
  const manifestCounts = new Map();
  for (const manifestBlock of analysis.manifestBlocks) {
    const count = databaseIds.has(manifestBlock.cid) ? 1 : 0;
    manifestCounts.set(manifestBlock.cid, count);
    logger.info(
      `   📋 Manifest ${manifestBlock.cid}: ${count > 0 ? "MATCHES" : "no match"}`,
    );
  }

  // Find the manifest with the highest count (most log entry references)
  let bestManifest = null;
  let bestCount = -1;

  for (const [manifestCID, count] of manifestCounts) {
    if (count > bestCount) {
      bestCount = count;
      bestManifest = analysis.manifestBlocks.find((m) => m.cid === manifestCID);
    }
  }

  if (bestManifest && bestCount > 0) {
    logger.info(
      `   ✅ Selected manifest: ${bestManifest.cid} (referenced by ${bestCount} log entries)`,
    );
    return bestManifest;
  }

  // Fallback: if no manifest matches log entries, use the first one and warn
  logger.warn(
    "   ⚠️ No manifest matched log entries, using first manifest as fallback",
  );
  return analysis.manifestBlocks[0];
}

/**
 * Default configuration options for UCAN bridge
 */
const DEFAULT_UCAN_OPTIONS = {
  timeout: 30000,
  gateway: "https://ipfs.aleph.cloud", // w3s.link redirects to a gateway retired on 2026-09-21
  batchSize: 10,
  maxConcurrency: 3,
  // UCAN-specific options
  ucanFile: undefined, // Path to UCAN CAR file
  ucanToken: undefined, // Base64-encoded UCAN token
  recipientKey: undefined, // Recipient identity private key (for delegation)
  agentDID: undefined, // Agent DID for the client
  spaceDID: undefined, // Target space DID
  // Fallback options
  fallbackDatabaseName: undefined,
  forceFallback: false,
};

/**
 * Load UCAN delegation from CAR file
 *
 * @param {string} ucanFilePath - Path to UCAN CAR file
 * @returns {Promise<Object>} - Parsed UCAN delegation
 */
async function loadUCANFromFile(ucanFilePath) {
  try {
    logger.info(`📖 Loading UCAN from file: ${ucanFilePath}`);

    const carBytes = await fs.readFile(ucanFilePath);

    // Extract the delegation directly from CAR bytes (like SecretShare)
    const delegation = await Delegation.extract(carBytes);

    if (!delegation.ok) {
      throw new Error("Failed to extract delegation from CAR file");
    }

    const extractedDelegation = delegation.ok;

    logger.info(`✅ UCAN loaded successfully`);
    logger.info(
      `   📋 Capabilities: ${extractedDelegation.capabilities.map((cap) => cap.can).join(", ")}`,
    );
    logger.info(`   🎯 Audience: ${extractedDelegation.audience.did()}`);
    logger.info(`   🔑 Issuer: ${extractedDelegation.issuer.did()}`);

    return extractedDelegation;
  } catch (error) {
    throw new Error(
      `Failed to load UCAN from file ${ucanFilePath}: ${error.message}`, { cause: error },
    );
  }
}

/**
 * Load UCAN delegation from base64 token
 *
 * @param {string} ucanToken - Base64-encoded UCAN token
 * @returns {Promise<Object>} - Parsed UCAN delegation
 */
async function loadUCANFromToken(ucanToken) {
  try {
    logger.info(`📖 Loading UCAN from token`);

    // Clean and normalize the token
    // Remove whitespace, newlines, and handle URL-safe base64
    let cleanedToken = ucanToken.trim().replace(/\s+/g, "");

    // Handle URL-safe base64 (replace - with + and _ with /)
    cleanedToken = cleanedToken.replace(/-/g, "+").replace(/_/g, "/");

    // Add padding if needed (base64 strings should be multiples of 4)
    while (cleanedToken.length % 4 !== 0) {
      cleanedToken += "=";
    }

    // Decode base64 token
    let tokenBytes;
    try {
      tokenBytes = Buffer.from(cleanedToken, "base64");
    } catch (base64Error) {
      throw new Error(
        `Invalid base64 token: ${base64Error.message}. Token preview: ${cleanedToken.substring(0, 50)}...`, { cause: base64Error },
      );
    }

    // Try @ucanto/core/delegation first (for pure UCAN tokens)
    try {
      const delegation = await Delegation.extract(tokenBytes);

      if (delegation.ok) {
        const extractedDelegation = delegation.ok;
        logger.info(`✅ UCAN token loaded successfully with @ucanto/core`);
        logger.info(
          `   📋 Capabilities: ${extractedDelegation.capabilities.map((cap) => cap.can).join(", ")}`,
        );
        logger.info(`   🎯 Audience: ${extractedDelegation.audience.did()}`);
        logger.info(`   🔑 Issuer: ${extractedDelegation.issuer.did()}`);
        return extractedDelegation;
      }
    } catch (ucantoError) {
      logger.info(
        `   ⚠️  @ucanto/core failed: ${ucantoError.message.substring(0, 100)}...`,
      );
    }

    // Try @web3-storage/w3up-client/proof (for w3 CLI generated tokens)
    try {
      const proof = await Proof.parse(cleanedToken);
      logger.info(`✅ UCAN token loaded successfully with w3up-client/proof`);
      logger.info(`   📋 Proof CID: ${proof.cid}`);

      // The proof itself is the delegation we need
      return proof;
    } catch (proofError) {
      logger.info(
        `   ⚠️  w3up-client/proof failed: ${proofError.message.substring(0, 100)}...`,
      );
    }

    throw new Error(
      "Failed to parse token with both @ucanto/core and @web3-storage/w3up-client methods",
    );
  } catch (error) {
    throw new Error(`Failed to load UCAN from token: ${error.message}`, { cause: error });
  }
}

/**
 * Initialize Storacha client using UCAN delegation (SecretShare pattern)
 *
 * @param {Object} options - UCAN configuration options
 * @returns {Promise<Object>} - Initialized Storacha client
 */
async function initializeStorachaClientWithUCAN(options) {
  const config = { ...DEFAULT_UCAN_OPTIONS, ...options };

  logger.info("🔐 Initializing Storacha client with UCAN authentication...");

  // Method 1: Use proper UCAN delegation (from our working example)
  if (config.ucanToken && config.recipientKey) {
    logger.info("   🎉 Using proper UCAN delegation approach...");

    try {
      // Parse recipient identity from JSON archive and fix the key format
      const recipientKeyData = JSON.parse(config.recipientKey);

      // JSON serialization converts Uint8Array to plain object, so we need to reconstruct it
      const fixedArchive = {
        id: recipientKeyData.id,
        keys: {
          [recipientKeyData.id]: new Uint8Array(
            Object.values(recipientKeyData.keys[recipientKeyData.id]),
          ),
        },
      };

      const recipientPrincipal = Signer.from(fixedArchive);
      const store = new StoreMemory();
      const client = await Client.create({
        principal: recipientPrincipal,
        store,
      });

      // Parse delegation token
      const delegationBytes = Buffer.from(config.ucanToken, "base64");
      const delegation = await Delegation.extract(delegationBytes);

      if (!delegation.ok) {
        throw new Error("Failed to extract delegation from token");
      }

      if (typeof client.addProof === "function") {
        await client.addProof(delegation.ok);
      }

      // Add space using delegation
      const space = await client.addSpace(delegation.ok);
      await client.setCurrentSpace(space.did());

      logger.info("✅ Storacha client initialized with UCAN delegation");
      logger.info(`   🤖 Agent: ${recipientPrincipal.did()}`);
      logger.info(`   🚀 Space: ${space.did()}`);
      logger.info(`   📋 Capabilities: ${delegation.ok.capabilities.length}`);

      return client;
    } catch (error) {
      logger.info(`   ⚠️  UCAN delegation failed: ${error.message}`);
    }
  }

  // Method 2: Try legacy approaches as fallback
  try {
    let delegation;

    if (config.ucanFile) {
      delegation = await loadUCANFromFile(config.ucanFile);
    } else if (config.ucanToken) {
      delegation = await loadUCANFromToken(config.ucanToken);
    }

    if (delegation && delegation.audience) {
      logger.info(`   🔄 Using legacy delegation approach...`);

      const audience = delegation.audience;
      const store = new StoreMemory();
      const client = await Client.create({ principal: audience, store });
      if (typeof client.addProof === "function") {
        await client.addProof(delegation);
      }
      const space = await client.addSpace(delegation);
      await client.setCurrentSpace(space.did());

      logger.info("✅ Storacha client initialized with legacy delegation");
      logger.info(`   🤖 Agent: ${audience.did()}`);
      logger.info(`   🚀 Space: ${space.did()}`);

      return client;
    }
  } catch (delegationError) {
    logger.info(`   ⚠️  Legacy delegation failed: ${delegationError.message}`);
  }

  throw new Error(
    "All UCAN authentication methods failed. Please check your UCAN credentials.",
  );
}

/**
 * Backup database using UCAN authentication
 *
 * @param {Object} orbitdb - OrbitDB instance
 * @param {string} databaseAddress - Database address or name
 * @param {Object} options - UCAN backup options
 * @returns {Promise<Object>} - Backup result
 */
export async function backupDatabaseWithUCAN(
  orbitdb,
  databaseAddress,
  options = {},
) {
  const config = { ...DEFAULT_UCAN_OPTIONS, ...options };
  const eventEmitter = options.eventEmitter;

  logger.info("🚀 Starting OrbitDB Database Backup to Storacha (UCAN)");
  logger.info(`📍 Database: ${databaseAddress}`);

  try {
    // Initialize Storacha client with UCAN
    const client = await initializeStorachaClientWithUCAN(config);

    // Open the database
    const database =
      typeof databaseAddress === "string" &&
      databaseAddress.startsWith("/orbitdb/")
        ? await orbitdb.open(databaseAddress)
        : await orbitdb.open(databaseAddress);

    // Extract all blocks (reuse existing function)
    const { blocks, blockSources, manifestCID } =
      await extractDatabaseBlocks(database);

    // Upload blocks to Storacha with progress tracking
    const { successful, cidMappings } = await uploadBlocksToStorachaUCAN(
      blocks,
      client,
      config.batchSize,
      config.maxConcurrency,
      eventEmitter,
    );

    if (successful.length === 0) {
      throw new Error("No blocks were successfully uploaded");
    }

    // Get block summary
    const blockSummary = {};
    for (const [_hash, source] of blockSources) {
      blockSummary[source] = (blockSummary[source] || 0) + 1;
    }

    logger.info("✅ UCAN Backup completed successfully!");

    return {
      success: true,
      manifestCID,
      databaseAddress: database.address,
      databaseName: database.name,
      blocksTotal: blocks.size,
      blocksUploaded: successful.length,
      blockSummary,
      cidMappings: Object.fromEntries(cidMappings),
    };
  } catch (error) {
    logger.error("❌ UCAN Backup failed:", error.message);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Upload blocks to Storacha using UCAN client
 */
async function uploadBlocksToStorachaUCAN(
  blocks,
  client,
  batchSize = 10,
  maxConcurrency = 3,
  eventEmitter = null,
) {
  logger.info(
    `📤 Uploading ${blocks.size} blocks to Storacha (UCAN) in batches of ${batchSize}...`,
  );

  const uploadResults = [];
  const cidMappings = new Map();
  const blocksArray = Array.from(blocks.entries());
  const totalBlocks = blocks.size;
  let completedBlocks = 0;

  // Emit initial progress
  if (eventEmitter) {
    eventEmitter.emit("uploadProgress", {
      type: "upload",
      current: 0,
      total: totalBlocks,
      percentage: 0,
      status: "starting",
    });
  }

  // Helper function to upload a single block
  const uploadSingleBlock = async ([hash, blockData]) => {
    try {
      const blockFile = new File([blockData.bytes], hash, {
        type: "application/octet-stream",
      });

      logger.info(
        `   📤 Uploading block ${hash} (${blockData.bytes.length} bytes)...`,
      );

      // Use UCAN-authenticated client
      const result = await client.uploadFile(blockFile);
      const uploadedCID = result.toString();

      logger.info(`   ✅ Uploaded (UCAN): ${hash} → ${uploadedCID}`);

      // Update progress
      completedBlocks++;
      if (eventEmitter) {
        eventEmitter.emit("uploadProgress", {
          type: "upload",
          current: completedBlocks,
          total: totalBlocks,
          percentage: Math.round((completedBlocks / totalBlocks) * 100),
          status: "uploading",
          currentBlock: {
            hash,
            uploadedCID,
            size: blockData.bytes.length,
          },
        });
      }

      return {
        originalHash: hash,
        uploadedCID,
        size: blockData.bytes.length,
      };
    } catch (error) {
      logger.error(`   ❌ Failed to upload block ${hash}: ${error.message}`);

      completedBlocks++;
      if (eventEmitter) {
        eventEmitter.emit("uploadProgress", {
          type: "upload",
          current: completedBlocks,
          total: totalBlocks,
          percentage: Math.round((completedBlocks / totalBlocks) * 100),
          status: "uploading",
          error: {
            hash,
            message: error.message,
          },
        });
      }

      return {
        originalHash: hash,
        error: error.message,
        size: blockData.bytes.length,
      };
    }
  };

  // Process blocks in batches (reuse existing batching logic)
  for (let i = 0; i < blocksArray.length; i += batchSize * maxConcurrency) {
    const megaBatch = blocksArray.slice(i, i + batchSize * maxConcurrency);
    const batches = [];

    for (let j = 0; j < megaBatch.length; j += batchSize) {
      const batch = megaBatch.slice(j, j + batchSize);
      batches.push(batch);
    }

    logger.info(
      `   🔄 Processing ${batches.length} concurrent batches (${megaBatch.length} blocks)...`,
    );

    const batchPromises = batches.map(async (batch, batchIndex) => {
      logger.info(
        `     📦 Batch ${batchIndex + 1}/${batches.length}: ${batch.length} blocks`,
      );

      const batchResults = await Promise.allSettled(
        batch.map(uploadSingleBlock),
      );

      return batchResults.map((result) =>
        result.status === "fulfilled"
          ? result.value
          : {
              originalHash: "unknown",
              error: result.reason?.message || "Unknown error",
              size: 0,
            },
      );
    });

    const batchResults = await Promise.all(batchPromises);

    for (const batchResult of batchResults) {
      for (const result of batchResult) {
        uploadResults.push(result);
        if (result.uploadedCID) {
          cidMappings.set(result.originalHash, result.uploadedCID);
        }
      }
    }
  }

  const successful = uploadResults.filter((r) => r.uploadedCID);
  const failed = uploadResults.filter((r) => r.error);

  logger.info(`   📊 UCAN Upload summary:`);
  logger.info(`      Total blocks: ${blocks.size}`);
  logger.info(`      Successful: ${successful.length}`);
  logger.info(`      Failed: ${failed.length}`);

  if (eventEmitter) {
    eventEmitter.emit("uploadProgress", {
      type: "upload",
      current: totalBlocks,
      total: totalBlocks,
      percentage: 100,
      status: "completed",
      summary: {
        successful: successful.length,
        failed: failed.length,
      },
    });
  }

  return { uploadResults, successful, failed, cidMappings };
}

/**
 * Restore database from Storacha using UCAN authentication
 *
 * @param {Object} orbitdb - Target OrbitDB instance
 * @param {Object} options - UCAN restore options
 * @returns {Promise<Object>} - Restore result
 */
export async function restoreDatabaseFromSpaceWithUCAN(orbitdb, options = {}) {
  const config = { ...DEFAULT_UCAN_OPTIONS, ...options };
  const eventEmitter = options.eventEmitter;

  logger.info("🔄 Starting OrbitDB Restore from Storacha (UCAN)");

  try {
    // Step 1: List ALL files in Storacha space using UCAN
    logger.info(
      "\\n📋 Step 1: Discovering all files in Storacha space (UCAN)...",
    );
    const spaceFiles = await listStorachaSpaceFilesWithUCAN(config);

    if (spaceFiles.length === 0) {
      throw new Error("No files found in Storacha space");
    }

    logger.info(
      `   🎉 SUCCESS! Found ${spaceFiles.length} files in space using UCAN authentication`,
    );

    // Step 2: Download ALL files from space with progress tracking
    const downloadedBlocks = await downloadBlocksWithProgressUCAN(
      spaceFiles,
      orbitdb,
      config,
      eventEmitter,
    );

    // Step 3: Intelligent block analysis
    logger.info(
      "\\n🔍 Step 3: Analyzing block structure with advanced intelligence...",
    );
    const analysis = await analyzeBlocks(
      orbitdb.ipfs.blockstore,
      downloadedBlocks,
    );

    if (analysis.manifestBlocks.length === 0 || options.forceFallback) {
      logger.info(
        "⚠️ No manifest blocks found - attempting fallback reconstruction...",
      );

      // Use existing fallback reconstruction logic
      const fallbackResult = await reconstructWithoutManifest(
        orbitdb,
        downloadedBlocks,
        config,
      );

      return {
        database: fallbackResult.database,
        metadata: fallbackResult.metadata,
        entriesCount: fallbackResult.entriesCount,
        entriesRecovered: fallbackResult.entriesCount,
        method: "fallback-reconstruction",
        success: true,
        preservedHashes: false,
        preservedAddress: false,
      };
    }

    // Step 4: Reconstruct database using discovered manifest
    logger.info("\\n🔄 Step 4: Reconstructing database from analysis...");

    // Find the correct manifest by matching log entries to database IDs
    const correctManifest = findCorrectManifest(analysis);
    if (!correctManifest) {
      throw new Error("Could not determine correct manifest from log entries");
    }

    const databaseAddress = `/orbitdb/${correctManifest.cid}`;

    logger.info(`   📥 Opening database at: ${databaseAddress}`);
    logger.info(
      `   🎯 Selected manifest: ${correctManifest.cid} (matched from log entries)`,
    );
    const reconstructedDB = await orbitdb.open(databaseAddress);

    // Wait for entries to load
    logger.info("   ⏳ Waiting for entries to load...");
    await new Promise((resolve) => setTimeout(resolve, config.timeout / 10));
    const reconstructedEntries = await reconstructedDB.all();
    await new Promise((resolve) => setTimeout(resolve, config.timeout / 10));

    // Handle different database types properly (reuse existing logic)
    let entriesArray;
    let entriesCount;
    if (reconstructedDB.type === "keyvalue") {
      const logEntries = await reconstructedDB.log.values();
      entriesArray = logEntries.map((logEntry) => ({
        hash: logEntry.hash,
        payload: logEntry.payload,
      }));
      entriesCount = Object.keys(reconstructedEntries).length;
    } else {
      entriesArray = Array.isArray(reconstructedEntries)
        ? reconstructedEntries
        : [];
      entriesCount = entriesArray.length;
    }

    logger.info(`   📊 Reconstructed entries: ${entriesCount}`);
    logger.info(`   🔍 Database type: ${reconstructedDB.type}`);

    logger.info("✅ UCAN Restore completed successfully!");

    return {
      success: true,
      database: reconstructedDB,
      orbitdb: orbitdb,
      manifestCID: correctManifest.cid,
      address: reconstructedDB.address,
      name: reconstructedDB.name,
      type: reconstructedDB.type,
      entriesRecovered: entriesCount,
      blocksRestored: downloadedBlocks.size,
      addressMatch: reconstructedDB.address === databaseAddress,
      spaceFilesFound: spaceFiles.length,
      analysis,
      entries: entriesArray,
    };
  } catch (error) {
    logger.error("❌ UCAN Restore failed:", error.message);

    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * List Storacha space files using UCAN authentication
 */
async function listStorachaSpaceFilesWithUCAN(options = {}) {
  logger.info("📋 Listing files in Storacha space using UCAN...");

  try {
    // Initialize client with UCAN
    const client = await initializeStorachaClientWithUCAN(options);

    // Use existing list logic but with UCAN client
    const listOptions = {};
    if (options.size) {
      listOptions.size = parseInt(String(options.size));
    } else {
      listOptions.size = 1000000;
    }
    if (options.cursor) {
      listOptions.cursor = options.cursor;
    }
    if (options.pre) {
      listOptions.pre = options.pre;
    }

    const result = await client.capability.upload.list(listOptions);

    logger.info(`   ✅ Found ${result.results.length} uploads in space (UCAN)`);

    const spaceFiles = result.results.map((upload) => ({
      root: upload.root.toString(),
      uploaded: upload.insertedAt ? new Date(upload.insertedAt) : new Date(),
      size:
        upload.shards?.reduce((total, shard) => {
          return total + (shard.size || 0);
        }, 0) || "unknown",
      shards: upload.shards?.length || 0,
      insertedAt: upload.insertedAt,
      updatedAt: upload.updatedAt,
    }));

    return spaceFiles;
  } catch (error) {
    logger.error("   ❌ UCAN listing error:", error.message);
    throw error;
  }
}

/**
 * Download blocks with UCAN authentication
 */
async function downloadBlocksWithProgressUCAN(
  spaceFiles,
  currentOrbitDB,
  config,
  eventEmitter = null,
) {
  logger.info("\\n📥 Downloading all space files (UCAN)...");
  const downloadedBlocks = new Map();
  const totalFiles = spaceFiles.length;
  let completedFiles = 0;

  if (eventEmitter) {
    eventEmitter.emit("downloadProgress", {
      type: "download",
      current: 0,
      total: totalFiles,
      percentage: 0,
      status: "starting",
    });
  }

  for (const spaceFile of spaceFiles) {
    const storachaCID = spaceFile.root;
    logger.info(`   🔄 Downloading (UCAN): ${storachaCID}`);

    try {
      const bytes = await downloadBlock(storachaCID, config);

      const orbitdbCID = convertStorachaCIDToOrbitDB(storachaCID);
      const parsedCID = CID.parse(orbitdbCID);

      // Store in target blockstore with error handling for closed blockstore
      if (!currentOrbitDB?.ipfs?.blockstore) {
        throw new Error(
          "Blockstore is not available - OrbitDB may have been closed",
        );
      }
      try {
        await currentOrbitDB.ipfs.blockstore.put(parsedCID, bytes);
      } catch (error) {
        if (
          error.message?.includes("not open") ||
          error.message?.includes("closed") ||
          error.message?.includes("Database is not open")
        ) {
          throw new Error(
            `Blockstore operation failed - OrbitDB was closed during download: ${error.message}`, { cause: error },
          );
        }
        throw error;
      }
      downloadedBlocks.set(orbitdbCID, { storachaCID, bytes: bytes.length });

      logger.info(`   ✅ Stored (UCAN): ${orbitdbCID}`);

      completedFiles++;
      if (eventEmitter) {
        eventEmitter.emit("downloadProgress", {
          type: "download",
          current: completedFiles,
          total: totalFiles,
          percentage: Math.round((completedFiles / totalFiles) * 100),
          status: "downloading",
          currentBlock: {
            storachaCID,
            orbitdbCID,
            size: bytes.length,
          },
        });
      }
    } catch (error) {
      logger.error(`   ❌ Failed (UCAN): ${storachaCID} - ${error.message}`);

      completedFiles++;
      if (eventEmitter) {
        eventEmitter.emit("downloadProgress", {
          type: "download",
          current: completedFiles,
          total: totalFiles,
          percentage: Math.round((completedFiles / totalFiles) * 100),
          status: "downloading",
          error: {
            storachaCID,
            message: error.message,
          },
        });
      }
    }
  }

  if (eventEmitter) {
    eventEmitter.emit("downloadProgress", {
      type: "download",
      current: totalFiles,
      total: totalFiles,
      percentage: 100,
      status: "completed",
      summary: {
        downloaded: downloadedBlocks.size,
        failed: totalFiles - downloadedBlocks.size,
      },
    });
  }

  logger.info(`   📊 Downloaded ${downloadedBlocks.size} blocks total (UCAN)`);
  return downloadedBlocks;
}

/**
 * Clear Storacha space using UCAN authentication
 */
export async function clearStorachaSpaceWithUCAN(options = {}) {
  logger.info("🧹 Clearing Storacha space using UCAN...");

  // Initialize client with UCAN
  const _client = await initializeStorachaClientWithUCAN(options); // Prefixed with underscore

  // Use the existing clear logic but pass UCAN-authenticated client
  // This would require modifying the original functions to accept a client parameter
  return await originalClearStorachaSpace({
    ...options,
    // Pass the client somehow - this needs refactoring in original functions
  });
}

/**
 * Enhanced OrbitDBStorachaBridge class with UCAN support
 */
export class OrbitDBStorachaBridgeUCAN extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = { ...DEFAULT_UCAN_OPTIONS, ...options };
  }

  async backup(orbitdb, databaseAddress, options = {}) {
    return await backupDatabaseWithUCAN(orbitdb, databaseAddress, {
      ...this.config,
      ...options,
      eventEmitter: this,
    });
  }

  async restoreFromSpace(orbitdb, options = {}) {
    return await restoreDatabaseFromSpaceWithUCAN(orbitdb, {
      ...this.config,
      ...options,
      eventEmitter: this,
    });
  }

  // Utility methods
  async listSpaceFiles(options = {}) {
    return await listStorachaSpaceFilesWithUCAN({ ...this.config, ...options });
  }

  async clearSpace(options = {}) {
    return await clearStorachaSpaceWithUCAN({ ...this.config, ...options });
  }

  convertCID(storachaCID) {
    return convertStorachaCIDToOrbitDB(storachaCID);
  }
}
