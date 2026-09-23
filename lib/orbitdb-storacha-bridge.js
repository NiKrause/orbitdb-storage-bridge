/**
 * OrbitDB Storacha Bridge - Main Library
 *
 * Provides complete OrbitDB database backup and restoration via Storacha/Filecoin
 * with 100% hash preservation and identity recovery.
 */

import * as Client from "@storacha/client";
import { StoreMemory } from "@storacha/client/stores/memory";
import { Signer } from "@storacha/client/principal/ed25519";
import * as Proof from "@storacha/client/proof";
import { BackendError } from "./backends/types.js";
import { CID } from "multiformats/cid";
import * as Block from "multiformats/block";
import * as dagCbor from "@ipld/dag-cbor";
import { sha256 } from "multiformats/hashes/sha2";
import { bases } from "multiformats/basics";
import { EventEmitter } from "events";
import { createHeliaOrbitDB, cleanupOrbitDBDirectories } from "./utils.js";
import { DEFAULT_GATEWAYS } from "./gateway-fetch.js";
import {
  generateBackupPrefix,
  getBackupFilenames,
  findLatestBackup,
} from "./backup-helpers.js";
import { logger, createLogger } from "./logger.js";
import { unixfs } from "@helia/unixfs";
import { readBlockBytes } from "./block-bytes.js";
// Moved out of this file so that backing up does not drag the Storacha client
// into a browser bundle; re-exported here, because this is where callers of
// every vintage look for it.
import { extractDatabaseBlocks } from "./extract-blocks.js";
import { resolveBackend } from "./backends/resolve.js";

export { extractDatabaseBlocks };

const HELIA_LOGGER = createLogger("helia");
const HELIA_COLOR = "\x1b[95m";
const COLOR_RESET = "\x1b[0m";

function logHeliaActivity(message) {
  HELIA_LOGGER(`${HELIA_COLOR}${message}${COLOR_RESET}`);
}

/**
 * Default configuration options
 */
const DEFAULT_OPTIONS = {
  // Core configuration
  timeout: 30000, // Timeout in milliseconds
  gateway: "https://ipfs.aleph.cloud", // dweb.link was retired on 2026-09-21
  verbose: false, // Enable verbose debug logging

  // Network download options
  useIPFSNetwork: true, // Enable network downloads by default
  gatewayFallback: true, // Fallback to gateway if network fails

  // Performance tuning (used in specific functions)
  batchSize: 10, // Batch size for upload/download operations (removeLayerFiles)
  maxConcurrency: 3, // Maximum concurrent batches (uploadBlocks)
  uploadBatchSize: 10, // Upload batch size for uploadBlocks
  uploadMaxConcurrency: 3, // Upload batch concurrency for uploadBlocks

  // Credentials (required - can also be set via environment variables)
  storachaKey: undefined, // Storacha private key (required)
  storachaProof: undefined, // Storacha proof (required)

  // Restore options
  fallbackDatabaseName: undefined, // Custom name for fallback reconstruction
  forceFallback: false, // Force fallback reconstruction mode
};

/**
 * Convert Storacha CID format to OrbitDB CID format
 *
 * @param {string} storachaCID - Storacha CID (bafkre... format)
 * @returns {string} - OrbitDB CID (zdpu... format)
 */
export function convertStorachaCIDToOrbitDB(storachaCID) {
  const storachaParsed = CID.parse(storachaCID);

  // Create CIDv1 with dag-cbor codec using the same multihash
  const orbitdbCID = CID.createV1(0x71, storachaParsed.multihash); // 0x71 = dag-cbor

  // Return in base58btc format (zdpu prefix)
  return orbitdbCID.toString(bases.base58btc);
}

/**
 * Extract manifest CID from OrbitDB address
 *
 * @param {string} databaseAddress - OrbitDB address (/orbitdb/zdpu...)
 * @returns {string} - Manifest CID
 */
export function extractManifestCID(databaseAddress) {
  return databaseAddress.split("/").pop();
}


/**
 * Initialize Storacha client with credentials
 *
 * @param {string} storachaKey - Storacha private key
 * @param {string} storachaProof - Storacha proof
 * @param {Object} [serviceConf] - Optional service configuration for custom endpoints
 * @param {string|URL} [receiptsEndpoint] - Optional receipts endpoint override
 * @returns {Promise<Object>} - Initialized Storacha client
 */
async function initializeStorachaClient(
  storachaKey,
  storachaProof,
  serviceConf,
  receiptsEndpoint,
) {
  const principal = Signer.parse(storachaKey);
  const store = new StoreMemory();
  const clientOptions = { principal, store };

  if (serviceConf) {
    clientOptions.serviceConf = serviceConf;
  }
  if (receiptsEndpoint) {
    clientOptions.receiptsEndpoint = receiptsEndpoint;
  }

  const client = await Client.create(clientOptions);

  const proof = await Proof.parse(storachaProof);
  const space = await client.addSpace(proof);
  await client.setCurrentSpace(space.did());

  return client;
}

/**
 * Initialize Storacha client with UCAN authentication
 *
 * @param {Object} options - UCAN options
 * @param {Object} options.client - Pre-initialized w3up client
 * @param {string} options.spaceDID - Target space DID
 * @returns {Promise<Object>} - Initialized Storacha client
 */
async function initializeStorachaClientWithUCAN(options) {
  logger.info("🔐 Initializing Storacha client with UCAN authentication...");

  if (!options.client) {
    throw new Error("UCAN client is required");
  }

  // If spaceDID is provided, set it as current space
  if (options.spaceDID) {
    logger.info(`   🚀 Setting current space: ${options.spaceDID}`);
    await options.client.setCurrentSpace(options.spaceDID);
  }

  logger.info("✅ UCAN Storacha client initialized");
  logger.info(`   🤖 Agent: ${options.client.agent.did()}`);
  logger.info(`   🚀 Current space: ${options.client.currentSpace()?.did()}`);

  return options.client;
}


/**
 * Upload blocks to Storacha with parallel batch processing and progress events
 *
 * @param {Map} blocks - Map of blocks to upload
 * @param {import('./backends/types.js').StorageBackend} backend - storage backend
 * @param {number} batchSize - Number of files to upload in parallel (default: 10)
 * @param {number} maxConcurrency - Maximum concurrent batches (default: 3)
 * @param {EventEmitter} eventEmitter - Optional event emitter for progress updates
 * @returns {Promise<Object>} - Upload results and CID mappings
 */
async function uploadBlocks(
  blocks,
  backend,
  batchSize = 10,
  maxConcurrency = 3,
  eventEmitter = null,
) {
  logger.info(
    `📤 Uploading ${blocks.size} blocks to ${backend.name} in batches of ${batchSize}...`,
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
      logger.info(
        `   📤 Uploading block ${hash} (${blockData.bytes.length} bytes)...`,
      );

      const handle = await backend.putBlob(blockData.bytes, { name: hash });
      const uploadedCID = handle.cid || handle.id;

      logger.info(`   ✅ Uploaded: ${hash} → ${uploadedCID}`);

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
      // Enhanced error handling for rate limits and service errors
      let errorMessage = error.message;
      let rateLimitInfo = "";

      // Check if it's a rate limit or service error with retry info
      if (error.status === 503 || error.code === 503) {
        const retryAfter =
          error.headers?.get?.("Retry-After") || error["retry-after"];
        const rateLimitReset =
          error.headers?.get?.("X-RateLimit-Reset") ||
          error["x-ratelimit-reset"];
        const rateLimitRemaining =
          error.headers?.get?.("X-RateLimit-Remaining") ||
          error["x-ratelimit-remaining"];

        rateLimitInfo += `\n   📊 Service Status: 503 Service Unavailable (rate limited or maintenance)`;

        if (retryAfter) {
          const retrySeconds = parseInt(retryAfter);
          let retryTime = retryAfter;
          if (!isNaN(retrySeconds)) {
            const futureTime = new Date(Date.now() + retrySeconds * 1000);
            retryTime = `${retrySeconds} seconds (available at ${futureTime.toLocaleTimeString()})`;
          } else {
            // Try to parse as HTTP date
            const retryDate = new Date(retryAfter);
            if (!isNaN(retryDate.getTime())) {
              const waitMs = Math.max(0, retryDate.getTime() - Date.now());
              const waitSecs = Math.ceil(waitMs / 1000);
              retryTime = `${waitSecs} seconds (available at ${retryDate.toLocaleTimeString()})`;
            }
          }
          rateLimitInfo += `\n   ⏱️  Retry-After: ${retryTime}`;
        }

        if (rateLimitReset) {
          const resetTime = parseInt(rateLimitReset);
          if (!isNaN(resetTime)) {
            const resetDate = new Date(resetTime * 1000);
            const waitMs = Math.max(0, resetDate.getTime() - Date.now());
            const waitSecs = Math.ceil(waitMs / 1000);
            rateLimitInfo += `\n   🔄 Rate Limit Reset: ${resetDate.toLocaleTimeString()} (in ${waitSecs}s)`;
          }
        }

        if (rateLimitRemaining) {
          rateLimitInfo += `\n   📈 Requests Remaining: ${rateLimitRemaining}`;
        }

        if (!retryAfter && !rateLimitReset) {
          rateLimitInfo += `\n   💡 No retry timing provided - service may be temporarily unavailable`;
        }

        errorMessage = `${errorMessage}${rateLimitInfo}`;
      } else if (error.status || error.code) {
        // Other HTTP errors
        const statusCode = error.status || error.code;
        errorMessage = `HTTP ${statusCode}: ${errorMessage}`;
      }

      logger.error(`   ❌ Failed to upload block ${hash}: ${errorMessage}`);

      // Update progress even for failed uploads
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

  // Process blocks in batches with controlled concurrency
  for (let i = 0; i < blocksArray.length; i += batchSize * maxConcurrency) {
    const megaBatch = blocksArray.slice(i, i + batchSize * maxConcurrency);
    const batches = [];

    // Split mega-batch into smaller batches
    for (let j = 0; j < megaBatch.length; j += batchSize) {
      const batch = megaBatch.slice(j, j + batchSize);
      batches.push(batch);
    }

    logger.info(
      `   🔄 Processing ${batches.length} concurrent batches (${megaBatch.length} blocks)...`,
    );

    // Process all batches in this mega-batch concurrently
    const batchPromises = batches.map(async (batch, batchIndex) => {
      logger.info(
        `     📦 Batch ${batchIndex + 1}/${batches.length}: ${batch.length} blocks`,
      );

      // Upload all blocks in this batch in parallel
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

    // Wait for all batches to complete
    const batchResults = await Promise.all(batchPromises);

    // Flatten and process results
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

  logger.info(`   📊 Upload summary:`);
  logger.info(`      Total blocks: ${blocks.size}`);
  logger.info(`      Successful: ${successful.length}`);
  logger.info(`      Failed: ${failed.length}`);
  logger.info(`      Batch size: ${batchSize}`);
  logger.info(`      Max concurrency: ${maxConcurrency}`);

  // Emit completion
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

// executeW3Command has been removed as it was deprecated and used Node.js-specific child_process
// Use SDK equivalents like listStorachaSpaceFiles() instead

/**
 * List all files in Storacha space using SDK (IMPROVED: Direct API access)
 *
 * @param {Object} options - Configuration options
 * @param {string} [options.storachaKey] - Storacha private key (defaults to env)
 * @param {string} [options.storachaProof] - Storacha proof (defaults to env)
 * @param {number} [options.size] - Maximum number of items to retrieve (default: 1000000)
 * @param {string} [options.cursor] - Pagination cursor
 * @returns {Promise<Array>} - Space files with metadata
 */
export async function listStorachaSpaceFiles(options = {}) {
  const _config = { ...DEFAULT_OPTIONS, ...options };
  logger.info("📋 Listing files in Storacha space using SDK...");

  try {
    // Initialize client - support both credential and UCAN authentication
    const backend = await resolveBackend(options);

    // Prepare list options
    const listOptions = {};
    if (options.size) {
      listOptions.size = parseInt(String(options.size));
    } else {
      listOptions.size = 1000000; // Default to get ALL files
    }
    if (options.cursor) {
      listOptions.cursor = options.cursor;
    }
    if (options.pre) {
      listOptions.pre = options.pre;
    }

    // List through the backend contract, so this works for any driver
    const entries = await backend.list(listOptions);

    logger.info(`   ✅ Found ${entries.length} uploads in space`);

    // Convert to the format we expect, with enhanced metadata
    const spaceFiles = entries.map((entry) => ({
      root: entry.id,
      uploaded: entry.insertedAt ? new Date(entry.insertedAt) : new Date(),
      size: entry.size || "unknown",
      shards: entry.raw?.shards?.length || 0,
      insertedAt: entry.insertedAt,
      updatedAt: entry.updatedAt,
    }));

    return spaceFiles;
  } catch (error) {
    logger.error("   ❌ SDK listing error:", error.message);
    throw error;
  }
}

/**
 * List files in a specific Storacha layer using SDK
 *
 * @param {string} layer - Layer to list ('upload', 'blob')
 * @param {Object} options - Configuration options
 * @returns {Promise<Array>} - Layer files
 */
export async function listLayerFiles(layer, options = {}) {
  const _config = { ...DEFAULT_OPTIONS, ...options };

  try {
    // Initialize client - support both credential and UCAN authentication
    const backend = await resolveBackend(options);
    const client = backend.client;

    // Prepare list options
    const listOptions = {};
    if (options.size) {
      listOptions.size = parseInt(String(options.size));
    } else {
      listOptions.size = 1000000; // Default to get ALL files
    }
    if (options.cursor) {
      listOptions.cursor = options.cursor;
    }
    if (options.pre) {
      listOptions.pre = options.pre;
    }

    let result;
    switch (layer) {
      case "upload": {
        result = await client.capability.upload.list(listOptions);
        return result.results.map((upload) => upload.root.toString());
      }

      case "blob": {
        result = await client.capability.blob.list(listOptions);
        return result.results.map((blob) => {
          // The blob structure is: { blob: { size: number, digest: Uint8Array }, cause: CID, insertedAt: string }
          if (blob.blob && blob.blob.digest) {
            // blob.blob.digest is already a Uint8Array, encode it to base64
            const encodedDigest = Buffer.from(blob.blob.digest).toString(
              "base64",
            );
            return encodedDigest;
          } else {
            logger.warn({ blob }, `   ⚠️ Unexpected blob structure`);
            return blob.toString(); // Fallback
          }
        });
      }

      default:
        throw new Error(`Unknown layer: ${layer}. Use 'upload' or 'blob'.`);
    }
  } catch (error) {
    logger.warn(`   ⚠️ Failed to list ${layer}: ${error.message}`);
    return [];
  }
}

/**
 * Remove files from a specific layer in batches
 *
 * @param {string} layer - Layer to clear ('upload', 'blob')
 * @param {Array} cids - Array of CIDs to remove
 * @param {Object} options - Configuration options
 * @returns {Promise<Object>} - Removal results
 */
export async function removeLayerFiles(layer, cids, options = {}) {
  if (cids.length === 0) {
    logger.info(`   ✓ ${layer}: No files to remove`);
    return { removed: 0, failed: 0 };
  }

  const batchSize = options.batchSize || 10;
  logger.info(
    `   🗑️ Removing ${cids.length} files from ${layer} layer using SDK (batch size: ${batchSize})...`,
  );

  try {
    // Initialize client - support both credential and UCAN authentication
    const backend = await resolveBackend(options);
    const client = backend.client;

    let removed = 0;
    let failed = 0;

    // Process CIDs in batches
    for (let i = 0; i < cids.length; i += batchSize) {
      const batch = cids.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(cids.length / batchSize);

      logger.info(
        `      📦 Processing batch ${batchNum}/${totalBatches} (${batch.length} files)...`,
      );

      // Process batch in parallel
      const batchPromises = batch.map(async (cid) => {
        try {
          switch (layer) {
            case "upload": {
              await client.capability.upload.remove(CID.parse(cid));
              break;
            }
            case "blob": {
              // For blob, we need to parse the digest format
              // cid should be a base64 encoded string, convert it back to Uint8Array
              let digest;
              if (typeof cid === "string") {
                // Convert to Buffer first, then to Uint8Array (API expects Uint8Array, not Buffer)
                const buffer = Buffer.from(cid, "base64");
                digest = new Uint8Array(buffer);
              } else {
                logger.error(
                  { cidType: typeof cid, cid },
                  `   ❌ Invalid blob CID format`,
                );
                throw new Error(
                  `Invalid blob CID format: expected string, got ${typeof cid}`,
                );
              }

              // Remove the blob using the correct API format: { bytes: Uint8Array }
              await client.capability.blob.remove({ bytes: digest });
              break;
            }

            default:
              throw new Error(
                `Unknown layer: ${layer}. Use 'upload' or 'blob'.`,
              );
          }

          return { success: true, cid };
        } catch (error) {
          return { success: false, cid, error: error.message };
        }
      });

      // Wait for all deletions in this batch to complete
      const batchResults = await Promise.allSettled(batchPromises);

      // Process results
      for (const result of batchResults) {
        if (result.status === "fulfilled") {
          if (result.value.success) {
            removed++;
            logger.info(`         ✓ Removed: ${result.value.cid}`);
          } else {
            failed++;
            logger.info(
              `         ❌ Failed to remove ${result.value.cid}: ${result.value.error}`,
            );
          }
        } else {
          failed++;
          logger.info(`         ❌ Batch operation failed: ${result.reason}`);
        }
      }

      // Add a small delay between batches to avoid overwhelming the API
      if (i + batchSize < cids.length) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    logger.info(`   📊 ${layer}: ${removed} removed, ${failed} failed`);
    return { removed, failed };
  } catch (error) {
    logger.error(`   ❌ Error removing from ${layer}: ${error.message}`);
    return { removed: 0, failed: cids.length };
  }
}

/**
 * Clear all files from Storacha space using SDK
 *
 * @param {Object} options - Configuration options
 * @returns {Promise<Object>} - Clearing results
 */
export async function clearStorachaSpace(options = {}) {
  logger.info("🧹 Clearing Storacha space using SDK...");
  logger.info("=".repeat(50));

  // FIXED: Remove 'store' layer as it's no longer available in the API
  const layers = ["upload", "blob"]; // Removed "store"
  const summary = {
    totalFiles: 0,
    totalRemoved: 0,
    totalFailed: 0,
    byLayer: {},
  };

  for (const layer of layers) {
    logger.info(`\n📋 Checking ${layer} layer...`);
    const cids = await listLayerFiles(layer, options);
    summary.totalFiles += cids.length;

    if (cids.length > 0) {
      const result = await removeLayerFiles(layer, cids, options);
      summary.totalRemoved += result.removed;
      summary.totalFailed += result.failed;
      summary.byLayer[layer] = result;
    } else {
      summary.byLayer[layer] = { removed: 0, failed: 0 };
      logger.info(`   ✓ ${layer}: Already empty`);
    }
  }

  logger.info("\n" + "=".repeat(50));
  logger.info("🧹 SPACE CLEARING RESULTS (SDK)");
  logger.info("=".repeat(50));
  logger.info(`📊 Total files found: ${summary.totalFiles}`);
  logger.info(`✅ Total files removed: ${summary.totalRemoved}`);
  logger.info(`❌ Total failures: ${summary.totalFailed}`);

  for (const [layer, stats] of Object.entries(summary.byLayer)) {
    logger.info(
      `   ${layer}: ${stats.removed} removed, ${stats.failed} failed`,
    );
  }

  const success =
    summary.totalFailed === 0 && summary.totalFiles === summary.totalRemoved;
  logger.info(
    `\n${success ? "✅" : "⚠️"} Space clearing: ${success ? "COMPLETE" : "PARTIAL"}`,
  );

  return {
    success,
    ...summary,
  };
}

/**
 * Download content from IPFS network using Helia with UnixFS
 *
 * Uses unixfs.cat() which handles DAG traversal automatically, making it suitable
 * for both single blocks and chunked files (like large CAR files).
 *
 * @param {string} cid - CID to download
 * @param {Object} helia - Helia IPFS instance
 * @param {Object} options - Configuration options
 * @param {Object} [options.unixfs] - Optional unixfs instance (will be created if not provided)
 * @returns {Promise<Uint8Array>} - Complete content bytes
 */
export async function downloadBlockFromIPFSNetwork(cid, helia, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };

  try {
    if (typeof config.reconnectToInMemoryHelia === "function") {
      try {
        await config.reconnectToInMemoryHelia();
      } catch (error) {
        logger.warn(
          `   ⚠️ In-memory Helia reconnect failed: ${error?.message ?? error}`,
        );
      }
    }

    // Check if helia instance is available and ready
    if (!helia) {
      throw new Error("Helia instance is not available");
    }

    const parsedCID = typeof cid === "string" ? CID.parse(cid) : cid;
    logHeliaActivity(`📥 helia unixfs.cat ${parsedCID.toString()}`);

    // Create unixfs instance from helia (or use provided one)
    const fs = options.unixfs || unixfs(helia);

    // Use unixfs.cat() to get complete content (handles DAGs automatically)
    // This uses Bitswap protocol to fetch from IPFS network and traverses DAGs
    const chunks = [];
    let timeoutId;

    // Create a timeout promise
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("Network download timeout")),
        config.timeout,
      );
    });

    // Race between cat() and timeout
    try {
      const catPromise = (async () => {
        for await (const chunk of fs.cat(parsedCID)) {
          chunks.push(chunk);
        }
      })();

      await Promise.race([catPromise, timeoutPromise]);
    } finally {
      // Clear timeout if cat() completes first
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }

    // Concatenate all chunks into a single Uint8Array
    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const bytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }

    logger.info(
      `   ✅ Downloaded ${bytes.length} bytes from IPFS network (CID: ${cid.substring(0, 12)}...)`,
    );
    logHeliaActivity(
      `✅ helia unixfs.cat complete ${parsedCID.toString()} (${bytes.length} bytes)`,
    );
    return bytes;
  } catch (error) {
    logHeliaActivity(
      `❌ helia unixfs.cat failed ${cid.toString?.() ?? cid}: ${error.message}`,
    );
    logger.warn(`   ⚠️ Failed to download from IPFS network: ${error.message}`);
    throw error;
  }
}

/**
 * Download a block by CID, peers first and HTTP gateways as the fallback.
 *
 * Nothing here has ever touched a Storacha client -- the old name
 * (`downloadBlockFromStoracha`, still exported as an alias) described where the block
 * had been put rather than where it is read from, which stopped being true the moment
 * a second backend existed. Bitswap does not care who paid for the pin.
 *
 * @param {string} cid - CID of the block to fetch
 * @param {Object} options - Configuration options
 * @param {Object} [options.helia] - Optional Helia instance for network download
 * @param {boolean} [options.useIPFSNetwork] - try peers before gateways
 * @param {boolean} [options.gatewayFallback] - fall back to HTTP gateways
 * @returns {Promise<Uint8Array>} - Block bytes
 */
export async function downloadBlock(cid, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };

  // Try IPFS network first if enabled and Helia instance is available
  if (config.useIPFSNetwork && config.helia) {
    try {
      const bytes = await downloadBlockFromIPFSNetwork(
        cid,
        config.helia,
        config,
      );
      return bytes;
    } catch (error) {
      logger.info(
        `   ⚠️ Network download failed, ${config.gatewayFallback ? "falling back to gateway" : "no fallback enabled"}: ${error.message}`,
      );
      if (!config.gatewayFallback) {
        throw new Error(
          `Could not download block ${cid} from IPFS network and gateway fallback is disabled`, { cause: error },
        );
      }
      // Continue to gateway fallback
    }
  }

  // Fallback to gateway download.
  // `dweb.link` and `ipfs.io` stood here until Protocol Labs retired them on
  // 2026-09-21; `storacha.link` and `w3s.link` had already become redirects to
  // the first of those. What is left is one host, which is not a fallback
  // chain — see issue #112 for the path that does not depend on one.
  const gateways = [...new Set([`${config.gateway}/ipfs`, ...DEFAULT_GATEWAYS])];

  for (const gateway of gateways) {
    try {
      const response = await fetch(`${gateway}/${cid}`, {
        signal: AbortSignal.timeout(config.timeout),
      });

      if (response.ok) {
        const contentType = response.headers?.get("content-type") || "";

        // Reject HTML responses (error pages)
        if (
          contentType.includes("text/html") ||
          contentType.includes("application/xhtml")
        ) {
          logger.debug(
            `   ⚠️ Gateway ${gateway} returned HTML (likely error page), trying next gateway...`,
          );
          continue; // Try next gateway
        }

        const bytes = new Uint8Array(await response.arrayBuffer());

        // Validate that we didn't get an HTML error page
        // Check first few bytes for HTML markers
        const textStart = new TextDecoder("utf-8", { fatal: false }).decode(
          bytes.slice(0, Math.min(100, bytes.length)),
        );
        if (
          textStart.trim().startsWith("<!DOCTYPE") ||
          textStart.trim().startsWith("<html") ||
          textStart.trim().startsWith("<?xml")
        ) {
          logger.debug(
            `   ⚠️ Gateway ${gateway} returned HTML/XML (likely error page), trying next gateway...`,
          );
          continue; // Try next gateway
        }

        logger.info(`   ✅ Downloaded ${bytes.length} bytes from ${gateway}`);
        return bytes;
      } else {
        // Enhanced logging for 503 and other error statuses
        let errorLog = `   ⚠️ Gateway ${gateway} returned status ${response.status}`;

        if (response.status === 503) {
          const retryAfter = response.headers?.get("Retry-After");
          const rateLimitReset = response.headers?.get("X-RateLimit-Reset");
          const rateLimitRemaining = response.headers?.get(
            "X-RateLimit-Remaining",
          );

          errorLog += ` (Service Unavailable - likely rate limited)`;

          if (retryAfter) {
            const retrySeconds = parseInt(retryAfter);
            if (!isNaN(retrySeconds)) {
              const futureTime = new Date(Date.now() + retrySeconds * 1000);
              errorLog += `\n           ⏱️ Retry-After: ${retrySeconds}s (available at ${futureTime.toLocaleTimeString()})`;
            } else {
              const retryDate = new Date(retryAfter);
              if (!isNaN(retryDate.getTime())) {
                const waitSecs = Math.ceil(
                  Math.max(0, retryDate.getTime() - Date.now()) / 1000,
                );
                errorLog += `\n           ⏱️ Retry-After: ${waitSecs}s (available at ${retryDate.toLocaleTimeString()})`;
              } else {
                errorLog += `\n           ⏱️ Retry-After: ${retryAfter}`;
              }
            }
          }

          if (rateLimitReset) {
            const resetTime = parseInt(rateLimitReset);
            if (!isNaN(resetTime)) {
              const resetDate = new Date(resetTime * 1000);
              const waitSecs = Math.ceil(
                Math.max(0, resetDate.getTime() - Date.now()) / 1000,
              );
              errorLog += `\n           🔄 Rate Limit Reset: ${resetDate.toLocaleTimeString()} (in ${waitSecs}s)`;
            }
          }

          if (rateLimitRemaining !== null && rateLimitRemaining !== undefined) {
            errorLog += `\n           📈 Requests Remaining: ${rateLimitRemaining}`;
          }
        }

        errorLog += `, trying next gateway...`;
        logger.debug(errorLog);
      }
    } catch (error) {
      logger.debug(`   ⚠️ Failed from ${gateway}: ${error.message}`);
    }
  }

  throw new Error(`Could not download block ${cid} from any gateway`);
}

/**
 * @deprecated Use {@link downloadBlock}. Kept because downstream code imports this name.
 * @type {typeof downloadBlock}
 */
export const downloadBlockFromStoracha = downloadBlock;

/**
 * Advanced block analysis (classification and log head detection)
 *
 * @param {Object} blockstore - IPFS blockstore
 * @param {Map} downloadedBlocks - Downloaded blocks map
 * @returns {Promise<Object>} - Analysis results
 */
export async function analyzeBlocks(blockstore, downloadedBlocks = null) {
  logger.debug("Analyzing downloaded blocks...");

  const analysis = {
    manifestBlocks: [],
    accessControllerBlocks: [],
    logEntryBlocks: [],
    identityBlocks: [],
    unknownBlocks: [],
    logStructure: new Map(),
    potentialHeads: [],
    logChain: new Map(),
  };

  const allCIDStrings = downloadedBlocks
    ? Array.from(downloadedBlocks.keys())
    : [];

  for (const cidString of allCIDStrings) {
    try {
      const cid = CID.parse(cidString);

      // Check if blockstore is available and accessible
      if (!blockstore || typeof blockstore.get !== "function") {
        throw new Error("Blockstore is not available or accessible");
      }

      let bytes;
      try {
        bytes = await readBlockBytes(blockstore, cid);
      } catch (error) {
        if (
          error.message?.includes("not open") ||
          error.message?.includes("closed") ||
          error.message?.includes("Database is not open")
        ) {
          throw new Error(
            `Blockstore operation failed - OrbitDB was closed during analysis: ${error.message}`, { cause: error },
          );
        }
        throw error;
      }

      if (cid.code === 0x71) {
        // dag-cbor codec
        try {
          const block = await Block.decode({
            cid,
            bytes,
            codec: dagCbor,
            hasher: sha256,
          });

          const content = block.value;
          logger.info("content.type", content);
          // Smart block classification
          //if (content.type && content.name && content.accessController) {
          if (content.accessController) {
            analysis.manifestBlocks.push({ cid: cidString, content });
            logger.info(`   📋 Manifest: ${cidString} (${content.name})`);
          } else if (content.sig && content.key && content.identity) {
            analysis.logEntryBlocks.push({ cid: cidString, content });
            analysis.logStructure.set(cidString, content);
            logger.info(`   📝 Log Entry: ${cidString}`);

            // Build log chain for head detection
            if (content.next && Array.isArray(content.next)) {
              for (const nextHash of content.next) {
                analysis.logChain.set(nextHash, cidString);
              }
            }
          } else if (content.id && content.type) {
            analysis.identityBlocks.push({ cid: cidString, content });
            logger.info(`   👤 Identity: ${cidString}`);
          } else if (
            content.type === "orbitdb-access-controller" ||
            content.type === "ipfs"
          ) {
            analysis.accessControllerBlocks.push({ cid: cidString, content });
            logger.info(`   🔒 Access Controller: ${cidString}`);
          } else {
            analysis.unknownBlocks.push({ cid: cidString, content });
            logger.info(`   ❓ Unknown: ${cidString}`);
          }
        } catch (decodeError) {
          analysis.unknownBlocks.push({
            cid: cidString,
            decodeError: decodeError.message,
          });
          logger.info(`   ⚠️ Decode failed: ${cidString}`);
        }
      } else {
        analysis.unknownBlocks.push({ cid: cidString, reason: "not dag-cbor" });
        logger.info(`   🔧 Raw block: ${cidString}`);
      }
    } catch (error) {
      logger.warn(`   ❌ Error analyzing block ${cidString}: ${error.message}`);
    }
  }

  // Intelligent head detection
  logger.info("🎯 Determining log heads:");
  for (const [entryHash, _entryContent] of analysis.logStructure) {
    if (!analysis.logChain.has(entryHash)) {
      analysis.potentialHeads.push(entryHash);
      logger.info(`   🎯 HEAD: ${entryHash}`);
    }
  }

  logger.info("📊 Analysis Summary:");
  logger.info(`   📋 Manifests: ${analysis.manifestBlocks.length}`);
  logger.info(`   📝 Log Entries: ${analysis.logEntryBlocks.length}`);
  logger.info(`   👤 Identities: ${analysis.identityBlocks.length}`);
  logger.info(
    `   🔒 Access Controllers: ${analysis.accessControllerBlocks.length}`,
  );
  logger.info(`   🎯 Heads Discovered: ${analysis.potentialHeads.length}`);

  return analysis;
}

/**
 * Download blocks from Storacha and bridge CID formats for OrbitDB
 *
 * @param {Map} cidMappings - Mapping of original → uploaded CIDs
 * @param {Object} client - Storacha client (unused, kept for compatibility)
 * @param {Object} targetBlockstore - Target blockstore to store blocks
 * @param {Object} options - Configuration options
 * @returns {Promise<Object>} - Bridge results
 */
async function downloadAndBridgeBlocks(
  cidMappings,
  client,
  targetBlockstore,
  options = {},
) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  logger.info(
    `📥 Downloading and bridging ${cidMappings.size} blocks for OrbitDB...`,
  );

  const bridgedBlocks = [];

  for (const [originalCID, storachaCID] of cidMappings) {
    try {
      logger.info(`   📥 Downloading ${storachaCID}...`);

      // Try network download first if enabled and Helia instance available
      let blockBytes = null;
      if (config.useIPFSNetwork && config.helia) {
        try {
          // Create unixfs if not provided
          if (!config.unixfs) {
            config.unixfs = unixfs(config.helia);
          }
          blockBytes = await downloadBlockFromIPFSNetwork(
            storachaCID,
            config.helia,
            { ...config, unixfs: config.unixfs },
          );
          logger.info(
            `   ✅ Downloaded ${blockBytes.length} bytes from IPFS network`,
          );
        } catch (error) {
          logger.info(
            `   ⚠️ Network download failed, ${config.gatewayFallback ? "falling back to gateway" : "no fallback"}: ${error.message}`,
          );
          if (!config.gatewayFallback) {
            throw new Error(
              `Failed to download block from IPFS network and gateway fallback is disabled: ${error.message}`, { cause: error },
            );
          }
        }
      }

      // Fallback to gateway if network failed or disabled
      if (!blockBytes) {
        const response = await fetch(`${config.gateway}/ipfs/${storachaCID}`, {
          signal: AbortSignal.timeout(config.timeout),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        blockBytes = new Uint8Array(await response.arrayBuffer());
        logger.info(
          `   ✅ Downloaded ${blockBytes.length} bytes from gateway ${config.gateway}`,
        );
      }

      // Convert Storacha CID to OrbitDB format
      const bridgedCID = convertStorachaCIDToOrbitDB(storachaCID);
      logger.info(`   🌉 Bridged CID: ${storachaCID} → ${bridgedCID}`);

      // Verify the bridged CID matches the original
      const match = bridgedCID === originalCID;
      if (match) {
        logger.info(`   ✅ CID bridge successful: ${bridgedCID}`);
      } else {
        logger.warn(
          `   ⚠️ CID bridge mismatch: expected ${originalCID}, got ${bridgedCID}`,
        );
      }

      // Store block in target blockstore under OrbitDB CID format
      const parsedBridgedCID = CID.parse(bridgedCID);
      await targetBlockstore.put(parsedBridgedCID, blockBytes);
      logger.info(`   💾 Stored in blockstore as: ${bridgedCID}`);

      bridgedBlocks.push({
        originalCID,
        storachaCID,
        bridgedCID,
        size: blockBytes.length,
        match,
      });
    } catch (error) {
      logger.error(
        `   ❌ Failed to download/bridge ${storachaCID}: ${error.message}`,
      );
      bridgedBlocks.push({
        originalCID,
        storachaCID,
        error: error.message,
      });
    }
  }

  const successful = bridgedBlocks.filter((b) => b.bridgedCID);
  const failed = bridgedBlocks.filter((b) => b.error);
  const matches = successful.filter((b) => b.match);

  logger.info(`   📊 Bridge summary:`);
  logger.info(`      Total blocks: ${cidMappings.size}`);
  logger.info(`      Downloaded: ${successful.length}`);
  logger.info(`      Failed: ${failed.length}`);
  logger.info(`      CID matches: ${matches.length}`);

  return { bridgedBlocks, successful, failed, matches };
}

/**
 * Back up an OrbitDB database through whichever backend is configured.
 *
 * **A CAR by default** (#54, 0.5.2). One opaque blob rather than a stream of
 * small ones: hash preservation is then structural instead of a property we
 * hope a vendor keeps, and it clears the minimum piece sizes that individual
 * OrbitDB blocks do not.
 *
 * The two strategies return **different fields**, so read `result.method`
 * rather than guessing from the shape. A CAR backup yields `backupFiles` with
 * the pointer to restore from; a block backup yields `cidMappings`, which the
 * CAR path cannot produce because there are no per-block handles to map. If
 * you were calling this before 0.5.2 and using `cidMappings`, pass
 * `strategy: "blocks"` — and read `assertCanTakeBlocks` for when a backend
 * will refuse.
 *
 * @param {Object} orbitdb - OrbitDB instance
 * @param {string} databaseAddress - Database address or name
 * @param {Object} options - Backup options
 * @param {"car"|"blocks"} [options.strategy="car"] - How to hand the database
 *   to the backend. `"blocks"` is refused by a backend that re-chunks or has a
 *   minimum piece size, before anything is sent.
 * @param {EventEmitter} options.eventEmitter - Optional event emitter for progress updates
 * @param {boolean} [options.logEntriesOnly] - Salvage mode: only log entries,
 *   for a database whose manifest cannot be read. Implies `strategy: "blocks"`,
 *   because a CAR without its manifest is one `restoreFromCID` refuses — and
 *   should, since it could be anybody's log.
 * @returns {Promise<Object>} - Backup result, carrying `method`
 */
/**
 * Whether this backend can be handed one OrbitDB block at a time.
 *
 * Two reasons it usually cannot, and both are quiet failures rather than loud
 * ones, which is why they are checked before a single block is sent:
 *
 * - **A minimum piece size.** Filecoin Onchain Cloud rejects anything under
 *   127 bytes and an OrbitDB block is routinely smaller, so a per-block backup
 *   dies partway through with some blocks stored and some not — the worst
 *   possible outcome, because it looks like a backup.
 * - **Re-chunking.** A backend that computes its own CID for what we send hands
 *   back a name for content we have never seen. Inside a CAR that cannot happen,
 *   because the CAR is one opaque blob and the CIDs inside it stay ours.
 *
 * @param {import("./backends/types.js").StorageBackend} backend
 */
function assertCanTakeBlocks(backend) {
  const caps = backend.capabilities ?? {};
  if (!caps.preservesInnerCids) {
    throw new BackendError(
      "UNSUPPORTED",
      `The ${backend.name} backend does not preserve the CIDs it is given, so it cannot be sent blocks one at a time. Use the default CAR strategy.`,
    );
  }
  if (caps.minBlobSize > 0) {
    throw new BackendError(
      "TOO_SMALL",
      `The ${backend.name} backend has a ${caps.minBlobSize}-byte minimum and OrbitDB blocks are routinely smaller, so a per-block backup would fail partway through. Use the default CAR strategy.`,
    );
  }
}

export async function backupDatabase(orbitdb, databaseAddress, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const eventEmitter = options.eventEmitter;
  const logEntriesOnly = options.logEntriesOnly || false;

  // CAR is the default (#54, 0.5.2). Hash preservation is then structural
  // rather than a property we hope a vendor keeps, and one blob clears the
  // minimum piece sizes that a stream of small blocks does not.
  //
  // `logEntriesOnly` stays on the block path and is not a strategy: it exists
  // to salvage a database whose manifest cannot be read, and a CAR without its
  // manifest is one `restoreFromCID` refuses — correctly, since it could be
  // anybody's log.
  const strategy = options.strategy ?? (logEntriesOnly ? "blocks" : "car");
  if (strategy !== "car" && strategy !== "blocks") {
    throw new BackendError("UNSUPPORTED", `Unknown backup strategy "${strategy}"`);
  }
  if (strategy === "car") {
    // Imported here rather than at the top: `backup-car.js` imports this
    // module, and a static edge back would close the cycle.
    const { backupDatabaseCAR } = await import("./backup-car.js");
    return backupDatabaseCAR(orbitdb, databaseAddress, options);
  }

  const backupMode = logEntriesOnly
    ? "Log Entries Only (Fallback Mode)"
    : "Full Backup";

  logger.info("🚀 Starting OrbitDB Database Backup to Storacha");
  logger.info(`📍 Database: ${databaseAddress}`);
  logger.info(`🔧 Backup Mode: ${backupMode}`);

  try {
    // Initialize Storacha client - support both credential and UCAN authentication
    const backend = await resolveBackend(config);
    // Before a single block is sent, not after some of them are.
    assertCanTakeBlocks(backend);

    // Open the database
    const database = await orbitdb.open(databaseAddress, options.dbConfig);

    // Extract blocks based on backup mode
    const { blocks, blockSources, manifestCID } = await extractDatabaseBlocks(
      database,
      {
        logEntriesOnly,
      },
    );

    // Upload blocks to Storacha with progress tracking
    let successful, cidMappings;
    try {
      const result = await uploadBlocks(
        blocks,
        backend,
        config.uploadBatchSize,
        config.uploadMaxConcurrency,
        eventEmitter,
      );
      successful = result.successful;
      cidMappings = result.cidMappings;

      if (successful.length === 0) {
        throw new Error("No blocks were successfully uploaded");
      }
    } catch (error) {
      if (
        error.message?.includes("Unauthorized") ||
        error.message?.includes("Capability")
      ) {
        if (eventEmitter) {
          eventEmitter.emit("uploadProgress", {
            type: "upload",
            current: 0,
            total: blocks.size,
            percentage: 0,
            status: "error",
            error: {
              type: "ucan",
              message:
                "UCAN authorization failed: Your capabilities are not sufficient for uploading. Please check your space permissions.",
              details: error.message,
            },
          });
        }
        throw new Error(
          "UCAN authorization failed: Your capabilities are not sufficient for uploading. Please check your space permissions.", { cause: error },
        );
      }
      throw error;
    }

    // Get block summary
    const blockSummary = {};
    for (const [_hash, source] of blockSources) {
      blockSummary[source] = (blockSummary[source] || 0) + 1;
    }

    logger.info("✅ Backup completed successfully!");

    return {
      success: true,
      // Named, because the two strategies return different fields and a caller
      // that branches on shape rather than on this is guessing.
      method: "blocks",
      manifestCID,
      databaseAddress: database.address,
      databaseName: database.name,
      blocksTotal: blocks.size,
      blocksUploaded: successful.length,
      blockSummary,
      cidMappings: Object.fromEntries(cidMappings),
    };
  } catch (error) {
    logger.error("❌ Backup failed:", error.message);
    return {
      success: false,
      error: error.message,
      // A BackendError says the backend cannot serve this request, which is a
      // different thing from the backup having failed, and a caller that has to
      // read the message to tell them apart will get it wrong.
      ...(error instanceof BackendError ? { code: error.code } : {}),
    };
  }
}

/**
 * Optimized restore from Storacha for fallback reconstruction (log entries only)
 *
 * @param {Object} orbitdb - Target OrbitDB instance
 * @param {Object} options - Restore options
 * @param {string} [options.storachaKey] - Storacha private key (defaults to env)
 * @param {string} [options.storachaProof] - Storacha proof (defaults to env)
 * @param {EventEmitter} [options.eventEmitter] - Optional event emitter for progress updates
 * @returns {Promise<Object>} - Restore result
 */
export async function restoreLogEntriesOnly(orbitdb, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const eventEmitter = options.eventEmitter;

  logger.info("⚡ Starting Optimized Log-Entries-Only Restore from Storacha");

  try {
    // Step 1: List ALL files in Storacha space
    logger.info("\n📋 Step 1: Discovering all files in Storacha space...");
    const spaceFiles = await listStorachaSpaceFiles(config);

    if (spaceFiles.length === 0) {
      throw new Error("No files found in Storacha space");
    }

    logger.info(`   🎉 SUCCESS! Found ${spaceFiles.length} files in space`);

    // Step 2: Download ONLY log entry blocks (optimized)
    // Ensure helia instance is included in config for network downloads
    const downloadConfig = {
      ...config,
      helia: config.helia || orbitdb.ipfs,
    };
    const logEntryBlocks = await downloadLogEntriesOnly(
      spaceFiles,
      orbitdb,
      downloadConfig,
      eventEmitter,
    );

    if (logEntryBlocks.size === 0) {
      throw new Error("No log entries found in Storacha space");
    }

    logger.info(
      `   ⚡ OPTIMIZATION: Downloaded only ${logEntryBlocks.size} log entries instead of ${spaceFiles.length} total files`,
    );

    // Step 3: Direct fallback reconstruction with joinEntry support
    logger.info(
      "\n🔧 Step 3: Reconstructing database from log entries with joinEntry...",
    );
    const fallbackResult = await reconstructWithoutManifest(
      orbitdb,
      logEntryBlocks,
      config,
      true, // Enable joinEntry mode for proper log traversal
    );

    logger.info(
      "✅ Optimized Log-Entries-Only Restore completed successfully!",
    );

    return {
      database: fallbackResult.database,
      metadata: fallbackResult.metadata,
      entriesCount: fallbackResult.entriesCount,
      entriesRecovered: fallbackResult.entriesCount,
      method: "optimized-log-entries-only",
      success: true,
      preservedHashes: false,
      preservedAddress: false,
      spaceFilesFound: spaceFiles.length,
      logEntriesDownloaded: logEntryBlocks.size,
      optimizationSavings: {
        totalFiles: spaceFiles.length,
        filesDownloaded: logEntryBlocks.size,
        filesSkipped: spaceFiles.length - logEntryBlocks.size,
        percentageSaved: Math.round(
          ((spaceFiles.length - logEntryBlocks.size) / spaceFiles.length) * 100,
        ),
      },
    };
  } catch (error) {
    logger.error(
      "❌ Optimized Log-Entries-Only Restore failed:",
      error.message,
    );

    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Mapping-independent restore from Storacha (ENHANCED)
 *
 * @param {Object} orbitdb - Target OrbitDB instance
 * @param {Object} options - Restore options
 * @param {string} [options.storachaKey] - Storacha private key (defaults to env)
 * @param {string} [options.storachaProof] - Storacha proof (defaults to env)
 * @param {boolean} [options.forceFallback] - Force fallback reconstruction mode (default: false)
 * @param {string} [options.fallbackDatabaseName] - Custom name for fallback reconstruction
 * @param {EventEmitter} [options.eventEmitter] - Optional event emitter for progress updates
 * @returns {Promise<Object>} - Restore result
 */
export async function restoreDatabaseFromSpace(orbitdb, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const eventEmitter = options.eventEmitter;
  // Use orbitdb parameter directly instead of creating an alias

  logger.info("🔄 Starting Mapping-Independent OrbitDB Restore from Storacha");

  // Backups are CARs since 0.5.2, so look for one first. Both paths are the
  // same intent — scan the space, reconstruct without being told the mapping —
  // and differ only in what the space turns out to hold, which is exactly the
  // decision a caller cannot make for itself.
  //
  // The fallback is not politeness: every backup written before 0.5.2 is a set
  // of individual blocks, and dropping that path would strand them.
  const strategy = options.strategy ?? "auto";
  if (strategy === "auto" || strategy === "car") {
    // Dynamic, because backup-car.js imports this module.
    const { listAvailableBackups, restoreFromSpaceCAR } = await import("./backup-car.js");
    let carBackups = [];
    try {
      carBackups = (await listAvailableBackups(config)) ?? [];
    } catch (error) {
      if (strategy === "car") throw error;
      logger.info(`   ⚠️ Could not look for CAR backups (${error.message}); scanning for blocks`);
    }

    if (carBackups.length > 0) {
      const latest = carBackups[0];
      logger.info(`   📦 Restoring the CAR backup from ${latest.timestamp}`);
      // The listing already found it; passing both spares a second scan of the
      // whole space, which downloads every file in it to identify the metadata.
      return restoreFromSpaceCAR(orbitdb, {
        ...options,
        timestamp: latest.timestamp,
        metadataCID: latest.metadataCID,
      });
    }

    if (strategy === "car") {
      throw new Error("No CAR backup found in this space");
    }
    logger.info("   ↩︎ No CAR backup in this space; scanning for individual blocks");
  }

  try {
    // Step 1: List ALL files in Storacha space
    logger.info("\n📋 Step 1: Discovering all files in Storacha space...");
    const spaceFiles = await listStorachaSpaceFiles(config);

    if (spaceFiles.length === 0) {
      throw new Error("No files found in Storacha space");
    }

    logger.info(
      `   🎉 SUCCESS! Found ${spaceFiles.length} files in space without requiring CID mappings`,
    );

    // Step 2: Download ALL files from space with progress tracking
    // Ensure helia instance is included in config for network downloads
    const downloadConfig = {
      ...config,
      helia: config.helia || orbitdb.ipfs,
    };
    const downloadedBlocks = await downloadBlocksWithProgress(
      spaceFiles,
      orbitdb,
      downloadConfig,
      eventEmitter,
    );

    // ... rest of existing code remains the same ...

    // Step 3: Intelligent block analysis
    logger.info("\n🔍 Step 3: Analyzing block structure...");
    const analysis = await analyzeBlocks(
      orbitdb.ipfs.blockstore,
      downloadedBlocks,
    );

    if (analysis.manifestBlocks.length === 0 || options.forceFallback) {
      logger.info(
        "⚠️ No manifest blocks found - attempting fallback reconstruction...",
      );

      // Fallback: decode blocks and extract payloads to import as new entries
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
    logger.info("\n🔄 Step 4: Reconstructing database from analysis...");

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

    // Extract database type from manifest if available, otherwise infer from log entries
    let databaseType = inferDatabaseType(analysis.logEntryBlocks); // fallback
    if (correctManifest.content && correctManifest.content.type) {
      databaseType = correctManifest.content.type;
      logger.info(`   📋 Database type from manifest: ${databaseType}`);
    } else {
      logger.debug(`Inferred database type: ${databaseType}`);
    }

    const reconstructedDB = await orbitdb.open(
      databaseAddress,
      config.dbConfig ? config.dbConfig : { type: databaseType },
    );

    // OPTIMIZED: Only join HEAD entries - OrbitDB will traverse backward automatically
    logger.info(
      "   🔗 Step 4a: Joining HEAD entries to reconstruct complete log...",
    );
    logger.info(
      `   🎯 Found ${analysis.potentialHeads.length} HEAD(s) in ${analysis.logEntryBlocks.length} total log entries`,
    );
    let joinedHeads = 0;

    // Only process HEAD entries - OrbitDB automatically traverses backward from each head
    for (const headCID of analysis.potentialHeads) {
      try {
        // Find the corresponding log entry block for this head
        const logEntryBlock = analysis.logEntryBlocks.find(
          (block) => block.cid === headCID,
        );

        if (!logEntryBlock) {
          logger.warn(
            `   ⚠️ HEAD ${headCID.slice(0, 12)}... not found in log entry blocks`,
          );
          continue;
        }

        // Create an entry object that matches OrbitDB's expected format
        const entryData = {
          hash: logEntryBlock.cid,
          v: logEntryBlock.content.v,
          id: logEntryBlock.content.id,
          key: logEntryBlock.content.key,
          sig: logEntryBlock.content.sig,
          next: logEntryBlock.content.next,
          refs: logEntryBlock.content.refs,
          clock: logEntryBlock.content.clock,
          payload: logEntryBlock.content.payload,
          identity: logEntryBlock.content.identity,
        };

        // Use joinEntry - this will automatically traverse and join all connected entries
        const updated = await reconstructedDB.log.joinEntry(entryData);
        if (updated) {
          joinedHeads++;
          logger.info(
            `   ✓ Joined HEAD ${joinedHeads}/${analysis.potentialHeads.length}: ${headCID.slice(0, 12)}...`,
          );
          logger.info(
            `      (OrbitDB will automatically traverse and load all connected entries)`,
          );
        } else {
          logger.info(`   → HEAD already in log: ${headCID.slice(0, 12)}...`);
        }
      } catch (joinError) {
        logger.warn(
          `   ⚠️ Failed to join HEAD ${headCID}: ${joinError.message}`,
        );
        // Continue with other heads even if one fails
      }
    }

    logger.info(
      `   📊 Successfully joined ${joinedHeads}/${analysis.potentialHeads.length} HEAD entries`,
    );

    // Wait for log to settle after joining entries
    logger.info("   ⏳ Waiting for log to settle after joining entries...");
    await new Promise((resolve) => setTimeout(resolve, config.timeout / 5));

    const reconstructedEntries = await reconstructedDB.all();
    logger.info("   ⏳ Additional wait for entries to fully load...");
    await new Promise((resolve) => setTimeout(resolve, config.timeout / 10));

    // Handle different database types properly
    let entriesArray;
    let entriesCount;
    if (reconstructedDB.type === "keyvalue") {
      // For key-value databases, all() returns an object
      // Get the actual log entries to preserve hashes
      const logEntries = await reconstructedDB.log.values();
      entriesArray = logEntries.map((logEntry) => ({
        hash: logEntry.hash,
        payload: logEntry.payload,
      }));
      entriesCount = Object.keys(reconstructedEntries).length;
    } else {
      // For other database types (events, documents), all() returns an array
      entriesArray = Array.isArray(reconstructedEntries)
        ? reconstructedEntries
        : [];
      entriesCount = entriesArray.length;
    }

    logger.info(`   📊 Final reconstructed entries: ${entriesCount}`);
    logger.info(`   🔍 Database type: ${reconstructedDB.type}`);
    logger.info(`   🔗 HEAD entries joined: ${joinedHeads}`);

    logger.info(
      "✅ Mapping-Independent Restore with proper joinEntry completed successfully!",
    );

    return {
      success: true,
      database: reconstructedDB,
      orbitdb: orbitdb, // Return the OrbitDB instance
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
    logger.error("❌ Mapping-Independent Restore failed:", error.message);

    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Restore an OrbitDB database from Storacha (Legacy mapping-dependent)
 *
 * @param {Object} orbitdb - Target OrbitDB instance
 * @param {string} manifestCID - Manifest CID from backup
 * @param {Object} cidMappings - Optional CID mappings (if available)
 * @param {Object} options - Restore options
 * @returns {Promise<Object>} - Restore result
 */
export async function restoreDatabase(
  orbitdb,
  manifestCID,
  cidMappings = null,
  options = {},
) {
  const config = { ...DEFAULT_OPTIONS, ...options };

  logger.info("🔄 Starting OrbitDB Database Restore from Storacha");
  logger.info(`📍 Manifest CID: ${manifestCID}`);

  // No temporary resources needed

  try {
    // Initialize Storacha client - support both credential and UCAN authentication
    const backend = await resolveBackend(config);
    const client = backend.client;

    // If no CID mappings provided, we need to discover them
    // This is a simplified version - in practice you'd store mappings during backup
    if (!cidMappings) {
      throw new Error(
        "CID mappings required for restore. Store them during backup.",
      );
    }

    // Convert object back to Map if needed
    const mappings =
      cidMappings instanceof Map
        ? cidMappings
        : new Map(Object.entries(cidMappings));

    // Download and bridge blocks
    const { successful, matches } = await downloadAndBridgeBlocks(
      mappings,
      client,
      orbitdb.ipfs.blockstore,
      { ...config, helia: orbitdb.ipfs },
    );

    if (successful.length === 0) {
      throw new Error("No blocks were successfully restored");
    }

    if (matches.length < successful.length) {
      throw new Error("Some CID bridges failed - reconstruction may fail");
    }

    // Analyze blocks to find log entries and HEAD entries
    logger.info("🔍 Analyzing restored blocks to find log entries...");
    const downloadedBlocks = new Set(Array.from(mappings.keys())); // OrbitDB CIDs
    const analysis = await analyzeBlocks(
      orbitdb.ipfs.blockstore,
      downloadedBlocks,
    );

    // Reconstruct database
    const databaseAddress = `/orbitdb/${manifestCID}`;
    logger.info(`📥 Opening database at: ${databaseAddress}`);

    // Determine database type from manifest or analysis
    let databaseType = inferDatabaseType(analysis.logEntryBlocks);
    const manifestBlock = analysis.manifestBlocks.find(
      (m) => m.cid === manifestCID,
    );
    if (manifestBlock?.content?.type) {
      databaseType = manifestBlock.content.type;
    }

    const reconstructedDB = await orbitdb.open(databaseAddress, {
      type: databaseType,
    });

    // Join HEAD entries to reconstruct the log (similar to restoreDatabaseFromSpace)
    if (analysis.potentialHeads.length > 0) {
      logger.info(
        `🔗 Joining ${analysis.potentialHeads.length} HEAD entry/entries to reconstruct complete log...`,
      );
      let joinedHeads = 0;

      for (const headCID of analysis.potentialHeads) {
        try {
          const logEntryBlock = analysis.logEntryBlocks.find(
            (block) => block.cid === headCID,
          );

          if (!logEntryBlock) {
            logger.warn(
              `⚠️ HEAD ${headCID.slice(0, 12)}... not found in log entry blocks`,
            );
            continue;
          }

          // Create an entry object that matches OrbitDB's expected format
          const entryData = {
            hash: logEntryBlock.cid,
            v: logEntryBlock.content.v,
            id: logEntryBlock.content.id,
            key: logEntryBlock.content.key,
            sig: logEntryBlock.content.sig,
            next: logEntryBlock.content.next,
            refs: logEntryBlock.content.refs,
            clock: logEntryBlock.content.clock,
            payload: logEntryBlock.content.payload,
            identity: logEntryBlock.content.identity,
          };

          // Use joinEntry - this will automatically traverse and join all connected entries
          const updated = await reconstructedDB.log.joinEntry(entryData);
          if (updated) {
            joinedHeads++;
            logger.info(
              `✓ Joined HEAD ${joinedHeads}/${analysis.potentialHeads.length}: ${headCID.slice(0, 12)}...`,
            );
          }
        } catch (joinError) {
          logger.warn(
            `⚠️ Failed to join HEAD ${headCID}: ${joinError.message}`,
          );
        }
      }

      logger.info(
        `📊 Successfully joined ${joinedHeads}/${analysis.potentialHeads.length} HEAD entries`,
      );
    }

    // Wait for log to settle after joining entries
    logger.info("⏳ Waiting for entries to load...");
    await new Promise((resolve) => setTimeout(resolve, config.timeout / 5));
    await new Promise((resolve) => setTimeout(resolve, config.timeout / 10));

    // Handle different database types properly
    let reconstructedEntries;
    let entriesArray;
    let entriesCount;

    if (reconstructedDB.type === "keyvalue") {
      reconstructedEntries = await reconstructedDB.all();
      // For key-value databases, all() returns an object
      const logEntries = await reconstructedDB.log.values();
      entriesArray = logEntries.map((logEntry) => ({
        hash: logEntry.hash,
        value: logEntry.payload.value,
      }));
      entriesCount = Object.keys(reconstructedEntries).length;
    } else {
      // For other database types (events, documents), all() returns an array
      reconstructedEntries = await reconstructedDB.all();
      entriesArray = Array.isArray(reconstructedEntries)
        ? reconstructedEntries
        : [];
      entriesCount = entriesArray.length;
    }

    logger.info("✅ Restore completed successfully!", entriesCount);

    return {
      success: true,
      database: reconstructedDB,
      manifestCID,
      address: reconstructedDB.address,
      name: reconstructedDB.name,
      type: reconstructedDB.type,
      entriesRecovered: entriesCount,
      blocksRestored: successful.length,
      addressMatch: reconstructedDB.address === databaseAddress,
      entries: entriesArray.map((e) => ({
        hash: e.hash || e._id || e.id,
        value: e.value || e,
      })),
    };
  } catch (error) {
    logger.error("❌ Restore failed:", error.message);
    return {
      success: false,
      error: error.message,
    };
  } // No cleanup needed
}

/**
 * Enhanced OrbitDBStorachaBridge class with event emission
 */
export class OrbitDBStorachaBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Back up a database. A CAR by default; pass `strategy: "blocks"` for the
   * pre-0.5.2 per-block path, which some backends will refuse.
   */
  async backup(orbitdb, databaseAddress, options = {}) {
    // Pass this instance as eventEmitter to enable progress events
    return await backupDatabase(orbitdb, databaseAddress, {
      ...this.config,
      ...options,
      eventEmitter: this,
    });
  }

  async backupLogEntriesOnly(orbitdb, databaseAddress, options = {}) {
    // Optimized backup for fallback reconstruction - only log entries
    return await backupDatabase(orbitdb, databaseAddress, {
      ...this.config,
      ...options,
      logEntriesOnly: true,
      eventEmitter: this,
    });
  }

  async restore(orbitdb, manifestCID, cidMappings, options = {}) {
    return await restoreDatabase(orbitdb, manifestCID, cidMappings, {
      ...this.config,
      ...options,
    });
  }

  // BREAKTHROUGH: Mapping-independent restore
  async restoreFromSpace(orbitdb, options = {}) {
    return await restoreDatabaseFromSpace(orbitdb, {
      ...this.config,
      ...options,
      eventEmitter: this,
    });
  }

  // OPTIMIZATION: Log-entries-only restore (much faster for fallback reconstruction)
  async restoreLogEntriesOnly(orbitdb, options = {}) {
    return await restoreLogEntriesOnly(orbitdb, {
      ...this.config,
      ...options,
      eventEmitter: this,
    });
  }

  // Utility methods
  async listSpaceFiles(options = {}) {
    return await listStorachaSpaceFiles({ ...this.config, ...options });
  }

  async analyzeBlocks(blockstore, downloadedBlocks) {
    return await analyzeBlocks(blockstore, downloadedBlocks);
  }

  extractManifestCID(databaseAddress) {
    return extractManifestCID(databaseAddress);
  }

  convertCID(storachaCID) {
    return convertStorachaCIDToOrbitDB(storachaCID);
  }
}

/**
 * Find the correct manifest block by matching log entries to database IDs
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
 * Download only log entry blocks from Storacha (optimized for fallback reconstruction)
 *
 * @param {Array} spaceFiles - Array of space files to download
 * @param {Object} currentOrbitDB - OrbitDB instance
 * @param {Object} config - Configuration options
 * @param {EventEmitter} eventEmitter - Optional event emitter for progress updates
 * @returns {Promise<Map>} - Downloaded log entry blocks map
 */
async function downloadLogEntriesOnly(
  spaceFiles,
  currentOrbitDB,
  config,
  eventEmitter = null,
) {
  logger.info("\n📥 Downloading and filtering log entry blocks only...");
  const logEntryBlocks = new Map();
  const totalFiles = spaceFiles.length;
  let completedFiles = 0;
  let logEntriesFound = 0;

  // Emit initial progress
  if (eventEmitter) {
    eventEmitter.emit("downloadProgress", {
      type: "download",
      current: 0,
      total: totalFiles,
      percentage: 0,
      status: "starting (log entries only)",
    });
  }

  for (const spaceFile of spaceFiles) {
    const storachaCID = spaceFile.root;
    logger.info(`   🔄 Checking: ${storachaCID}`);

    try {
      // Ensure helia instance is passed for network downloads
      const downloadConfig = {
        ...config,
        helia: config.helia || currentOrbitDB?.ipfs,
      };
      const bytes = await downloadBlock(storachaCID, downloadConfig);

      // Convert Storacha CID to OrbitDB format
      const orbitdbCID = convertStorachaCIDToOrbitDB(storachaCID);
      const parsedCID = CID.parse(orbitdbCID);

      // Only process dag-cbor blocks (potential log entries)
      if (parsedCID.code === 0x71) {
        try {
          const block = await Block.decode({
            cid: parsedCID,
            bytes,
            codec: dagCbor,
            hasher: sha256,
          });

          const content = block.value;

          // Check if this looks like an OrbitDB log entry
          if (
            content &&
            content.v === 2 &&
            content.id &&
            content.clock &&
            content.payload !== undefined
          ) {
            // Store in target blockstore
            await currentOrbitDB.ipfs.blockstore.put(parsedCID, bytes);
            logEntryBlocks.set(orbitdbCID, {
              storachaCID,
              bytes: bytes.length,
            });
            logEntriesFound++;

            logger.info(`   ✅ Log entry stored: ${orbitdbCID}`);
          } else {
            logger.info(`   ⚪ Skipped non-log block: ${orbitdbCID}`);
          }
        } catch {
          logger.info(`   ⚪ Skipped non-decodable block: ${orbitdbCID}`);
        }
      } else {
        logger.info(`   ⚪ Skipped non-CBOR block: ${orbitdbCID}`);
      }

      // Update progress
      completedFiles++;
      if (eventEmitter) {
        eventEmitter.emit("downloadProgress", {
          type: "download",
          current: completedFiles,
          total: totalFiles,
          percentage: Math.round((completedFiles / totalFiles) * 100),
          status: "downloading (log entries only)",
          currentBlock: {
            storachaCID,
            orbitdbCID,
            size: bytes.length,
            isLogEntry: logEntryBlocks.has(orbitdbCID),
          },
        });
      }
    } catch (error) {
      logger.error(`   ❌ Failed: ${storachaCID} - ${error.message}`);

      // Update progress even for failed downloads
      completedFiles++;
      if (eventEmitter) {
        eventEmitter.emit("downloadProgress", {
          type: "download",
          current: completedFiles,
          total: totalFiles,
          percentage: Math.round((completedFiles / totalFiles) * 100),
          status: "downloading (log entries only)",
          error: {
            storachaCID,
            message: error.message,
          },
        });
      }
    }
  }

  // Emit completion
  if (eventEmitter) {
    eventEmitter.emit("downloadProgress", {
      type: "download",
      current: totalFiles,
      total: totalFiles,
      percentage: 100,
      status: "completed (log entries only)",
      summary: {
        totalFiles: totalFiles,
        logEntriesFound: logEntriesFound,
        blocksSkipped: totalFiles - logEntriesFound,
      },
    });
  }

  logger.info(
    `   📊 Found ${logEntriesFound} log entries out of ${totalFiles} total files`,
  );
  return logEntryBlocks;
}

/**
 * Download blocks from Storacha with progress events
 *
 * @param {Array} spaceFiles - Array of space files to download
 * @param {Object} currentOrbitDB - OrbitDB instance
 * @param {Object} config - Configuration options
 * @param {EventEmitter} eventEmitter - Optional event emitter for progress updates
 * @returns {Promise<Map>} - Downloaded blocks map
 */
async function downloadBlocksWithProgress(
  spaceFiles,
  currentOrbitDB,
  config,
  eventEmitter = null,
) {
  logger.info("\n📥 Downloading all space files...");
  const downloadedBlocks = new Map();
  const totalFiles = spaceFiles.length;
  let completedFiles = 0;

  // Emit initial progress
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
    logger.info(`   🔄 Downloading: ${storachaCID}`);

    try {
      // Ensure helia instance is passed for network downloads
      const downloadConfig = {
        ...config,
        helia: config.helia || currentOrbitDB?.ipfs,
      };
      const bytes = await downloadBlock(storachaCID, downloadConfig);

      // Convert Storacha CID to OrbitDB format
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

      logger.info(`   ✅ Stored: ${orbitdbCID}`);

      // Update progress
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
      logger.error(`   ❌ Failed: ${storachaCID} - ${error.message}`);

      // Update progress even for failed downloads
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

  // Emit completion
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

  logger.info(`   📊 Downloaded ${downloadedBlocks.size} blocks total`);
  return downloadedBlocks;
}

/**
 * Fallback reconstruction when no manifest is found
 * Decodes blocks, extracts payloads, and creates a new database
 *
 * @param {Object} orbitdb - OrbitDB instance
 * @param {Map} downloadedBlocks - Downloaded blocks map
 * @param {Object} config - Configuration options
 * @param {boolean} useJoinEntry - Whether to use joinEntry for reconstruction
 * @returns {Promise<Object>} - Reconstruction results
 */
export async function reconstructWithoutManifest(
  orbitdb,
  downloadedBlocks,
  config,
  useJoinEntry = false,
) {
  logger.info(
    `🔧 Starting fallback reconstruction without manifest ${useJoinEntry ? "with joinEntry support" : "(legacy mode)"}...`,
  );

  const logEntries = [];
  const unknownBlocks = [];

  // Step 1: Decode all blocks and identify log entries
  logger.info("🔍 Step 1: Decoding blocks to find log entries...");

  for (const [cidString, _] of downloadedBlocks) {
    try {
      const cid = CID.parse(cidString);
      const bytes = await readBlockBytes(orbitdb.ipfs.blockstore, cid);

      if (cid.code === 0x71) {
        // dag-cbor codec
        try {
          const block = await Block.decode({
            cid,
            bytes,
            codec: dagCbor,
            hasher: sha256,
          });

          const content = block.value;

          // Check if this looks like an OrbitDB log entry
          if (
            content &&
            content.v === 2 &&
            content.id &&
            content.clock &&
            content.payload !== undefined
          ) {
            logEntries.push({
              cid: cidString,
              content,
              hash: cidString,
              payload: content.payload,
            });

            logger.info(`   📝 Found log entry: ${cidString.slice(0, 12)}...`);
          }
        } catch (decodeError) {
          unknownBlocks.push({ cid: cidString, error: decodeError.message });
        }
      }
    } catch (error) {
      logger.warn(
        `   ⚠️ Error processing block ${cidString}: ${error.message}`,
      );
    }
  }

  logger.info(`   ✅ Found ${logEntries.length} log entries`);

  if (logEntries.length === 0) {
    throw new Error(
      "No OrbitDB log entries found in blocks - cannot reconstruct database",
    );
  }

  // Step 2: Analyze payload patterns to determine database type
  logger.info(
    "🔍 Step 2: Analyzing payload patterns to determine database type...",
  );

  const databaseType = inferDatabaseType(logEntries);
  logger.info(`   📊 Inferred database type: ${databaseType}`);

  // Step 3: Create new database and import entries
  logger.info(`🆕 Step 3: Creating new ${databaseType} database...`);

  const dbName = config.fallbackDatabaseName || `restored-${Date.now()}`;

  // Merge config.dbConfig with inferred type, prioritizing the inferred type
  const dbOptions = {
    ...config.dbConfig,
    type: databaseType,
  };

  const database = await orbitdb.open(dbName, dbOptions);

  logger.info(`   ✅ Created database: ${database.address}`);

  // Step 4: Import entries using appropriate method
  let importedCount = 0;
  const importErrors = [];

  if (useJoinEntry) {
    logger.info("📥 Step 4: Using joinEntry to properly reconstruct log...");

    // Sort by clock time to maintain order
    logEntries.sort((a, b) => {
      const timeA = a.content.clock?.time || 0;
      const timeB = b.content.clock?.time || 0;
      return timeA - timeB;
    });

    for (const entry of logEntries) {
      try {
        // Use joinEntry to properly add this entry to the log
        const entryData = {
          hash: entry.hash,
          v: entry.content.v,
          id: entry.content.id,
          key: entry.content.key,
          sig: entry.content.sig,
          next: entry.content.next,
          refs: entry.content.refs,
          clock: entry.content.clock,
          payload: entry.content.payload,
          identity: entry.content.identity,
        };

        const updated = await database.log.joinEntry(entryData);
        if (updated) {
          importedCount++;
          logger.info(
            `   ✓ Joined entry ${importedCount}/${logEntries.length}: ${entry.hash.slice(0, 12)}...`,
          );
        } else {
          // Entry might already be in the log
          logger.info(
            `   → Entry already processed: ${entry.hash.slice(0, 12)}...`,
          );
        }
      } catch (error) {
        importErrors.push({ entry: entry.hash, error: error.message });
        logger.warn(
          `   ⚠️ Failed to join entry ${entry.hash.slice(0, 12)}...: ${error.message}`,
        );
      }
    }

    logger.info(
      `   📊 Join complete: ${importedCount}/${logEntries.length} entries joined`,
    );
  } else {
    logger.info(
      "📥 Step 4: Importing entries in chronological order (legacy mode)...",
    );

    // Sort by clock time to maintain order
    logEntries.sort((a, b) => {
      const timeA = a.content.clock?.time || 0;
      const timeB = b.content.clock?.time || 0;
      return timeA - timeB;
    });

    for (const entry of logEntries) {
      try {
        await importEntryByType(database, entry, databaseType);
        importedCount++;
        logger.info(
          `   ✅ Imported entry ${importedCount}/${logEntries.length}`,
        );
      } catch (error) {
        importErrors.push({ entry: entry.hash, error: error.message });
        logger.warn(
          `   ⚠️ Failed to import entry ${entry.hash.slice(0, 12)}...: ${error.message}`,
        );
      }
    }
  }

  logger.info(
    `   📊 ${useJoinEntry ? "Join" : "Import"} complete: ${importedCount}/${logEntries.length} entries ${useJoinEntry ? "joined" : "imported"}`,
  );

  if (importErrors.length > 0) {
    logger.warn(
      `   ⚠️ ${importErrors.length} ${useJoinEntry ? "join" : "import"} errors occurred`,
    );
  }

  // Create fallback metadata
  const metadata = {
    type: "fallback-reconstruction",
    databaseType: databaseType,
    originalEntryCount: logEntries.length,
    importedEntryCount: importedCount,
    reconstructedAt: new Date().toISOString(),
    address: database.address.toString(),
    name: dbName,
    importErrors: importErrors.length,
  };

  return {
    database,
    metadata,
    entriesCount: importedCount,
  };
}

/**
 * Infer database type from payload patterns
 *
 * @param {Array} logEntries - Array of log entries
 * @returns {string} - Inferred database type
 */
function inferDatabaseType(logEntries) {
  const payloadPatterns = {
    hasDocumentOps: 0,
    hasKeyValueOps: 0,
    hasSimplePayloads: 0,
    hasCounterOps: 0,
  };

  logger.info(
    `   🔍 Analyzing ${logEntries.length} log entries for database type...`,
  );

  // Debug: Check structure of first few entries
  logger.debug(
    {
      firstEntryStructure:
        logEntries.length > 0 ? Object.keys(logEntries[0]) : "No entries",
      hasPayload:
        logEntries.length > 0
          ? logEntries[0].payload
            ? "exists"
            : "undefined"
          : "N/A",
      firstEntryPreview:
        logEntries.length > 0
          ? JSON.stringify(logEntries[0], null, 2).slice(0, 500) + "..."
          : "N/A",
    },
    `   🔍 First entry structure`,
  );

  for (const entry of logEntries) {
    // Fix: Access payload from entry.content.payload, not entry.payload
    const payload = entry.content ? entry.content.payload : entry.payload;

    // Debug logging for first few entries
    if (
      payloadPatterns.hasDocumentOps +
        payloadPatterns.hasKeyValueOps +
        payloadPatterns.hasSimplePayloads +
        payloadPatterns.hasCounterOps <
      3
    ) {
      logger.debug(
        { payload },
        `   🔍 Entry ${payloadPatterns.hasDocumentOps + payloadPatterns.hasKeyValueOps + payloadPatterns.hasSimplePayloads + payloadPatterns.hasCounterOps + 1} payload`,
      );
    }

    if (payload && typeof payload === "object") {
      // Check for document/keyvalue operation patterns
      if (
        (payload.op === "PUT" || payload.op === "DEL") &&
        payload.key !== undefined
      ) {
        // Documents typically use _id as primary key or have _id in the value
        if (
          payload.key === "_id" ||
          payload.key.startsWith("_id") ||
          (payload.op === "PUT" &&
            payload.value &&
            typeof payload.value === "object" &&
            payload.value._id)
        ) {
          payloadPatterns.hasDocumentOps++;
        } else {
          // Any PUT/DEL with a key that's not document-style is keyvalue
          payloadPatterns.hasKeyValueOps++;
        }
      } else if (
        payload.op === "COUNTER" ||
        payload.op === "DEC" ||
        payload.op === "INC"
      ) {
        payloadPatterns.hasCounterOps++;
      } else if (payload.op === "ADD") {
        // Explicit ADD operation for events
        payloadPatterns.hasSimplePayloads++;
      } else {
        // Complex object without standard operation structure - likely events
        payloadPatterns.hasSimplePayloads++;
      }
    } else {
      // Simple payload (string, number, etc.) - likely events
      payloadPatterns.hasSimplePayloads++;
    }
  }

  logger.info("   📊 Payload analysis:", payloadPatterns);

  // Log some sample payloads for debugging
  if (logEntries.length > 0) {
    const sampleEntries = logEntries.slice(0, 3);
    const samples = sampleEntries.map((entry, i) => {
      const p = entry.content ? entry.content.payload : entry.payload;
      if (p && typeof p === "object") {
        return {
          index: i + 1,
          op: p.op,
          keyType: typeof p.key,
          hasValue: p.value !== undefined,
        };
      } else {
        return { index: i + 1, simplePayloadType: typeof p };
      }
    });
    logger.debug({ samples }, `   🔍 Sample payloads`);
  }

  // Determine type based on majority pattern
  if (payloadPatterns.hasCounterOps > 0) {
    logger.info(
      { counterOps: payloadPatterns.hasCounterOps },
      `   🎯 Detected: counter`,
    );
    return "counter";
  } else if (
    payloadPatterns.hasDocumentOps > payloadPatterns.hasKeyValueOps &&
    payloadPatterns.hasDocumentOps > payloadPatterns.hasSimplePayloads
  ) {
    logger.info(
      { documentOps: payloadPatterns.hasDocumentOps },
      `   🎯 Detected: documents`,
    );
    return "documents";
  } else if (
    payloadPatterns.hasKeyValueOps > payloadPatterns.hasSimplePayloads
  ) {
    logger.info(
      { keyValueOps: payloadPatterns.hasKeyValueOps },
      `   🎯 Detected: keyvalue`,
    );
    return "keyvalue";
  } else {
    logger.info(
      { simplePayloads: payloadPatterns.hasSimplePayloads },
      `   🎯 Detected: events (fallback)`,
    );
    return "events"; // Default fallback
  }
}

/**
 * Import a log entry into the appropriate database type
 *
 * @param {Object} database - Target OrbitDB database
 * @param {Object} entry - Log entry to import
 * @param {string} databaseType - Database type
 */
async function importEntryByType(database, entry, databaseType) {
  const payload = entry.payload;

  switch (databaseType) {
    case "events":
      // Events databases are append-only, only support ADD operations
      if (payload && payload.op === "ADD") {
        await database.add(payload.value || payload);
      } else {
        // Fallback: treat any payload as an event to add
        await database.add(payload);
      }
      break;

    case "documents":
      if (payload && payload.op === "PUT" && payload.value) {
        await database.put(payload.value);
      } else if (payload && payload.op === "DEL" && payload.key) {
        // Delete document by key (usually _id)
        await database.del(payload.key);
      } else if (payload && typeof payload === "object") {
        // Fallback: treat as document even without operation structure
        await database.put(payload);
      } else {
        throw new Error("Invalid document payload structure");
      }
      break;

    case "keyvalue":
      if (
        payload &&
        payload.op === "PUT" &&
        payload.key &&
        payload.value !== undefined
      ) {
        await database.put(payload.key, payload.value); // Use put for keyvalue, not set
      } else if (payload && payload.op === "DEL" && payload.key) {
        // Delete by key
        await database.del(payload.key);
      } else {
        throw new Error("Invalid keyvalue payload structure");
      }
      break;

    case "counter":
      if (payload && payload.op === "COUNTER") {
        await database.inc(payload.value || 1);
      } else if (payload && payload.op === "DEC") {
        // Decrement operation (negative increment)
        await database.inc(-(payload.value || 1));
      } else {
        // Fallback: try to increment by 1
        await database.inc(1);
      }
      break;

    default:
      throw new Error(`Unsupported database type: ${databaseType}`);
  }
}

// Export all utilities
export {
  cleanupOrbitDBDirectories,
  createHeliaOrbitDB,
  initializeStorachaClient,
  initializeStorachaClientWithUCAN,
  resolveBackend,
  // Timestamped backup helpers
  generateBackupPrefix,
  getBackupFilenames,
  findLatestBackup,
};
