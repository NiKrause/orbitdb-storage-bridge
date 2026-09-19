/**
 * @fileoverview Access Control Integration Tests for OrbitDB Storage Bridge
 *
 * This test suite validates that different identities are properly handled during
 * backup and restore operations, including access control enforcement and identity
 * separation across different nodes.
 *
 * Tests scenarios from demo-different-identity.js that are not covered by the
 * main integration test suite.
 */

import "dotenv/config";
import {
  backupDatabase,
  restoreDatabaseFromSpace,
  clearStorachaSpace,
} from "../lib/orbitdb-storacha-bridge.js";

import { identify } from "@libp2p/identify";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { tcp } from "@libp2p/tcp";
import { gossipsub } from "@libp2p/gossipsub";
import { createHelia } from "helia";
import { createOrbitDB } from "@orbitdb/core";
import { LevelBlockstore } from "blockstore-level";
import { LevelDatastore } from "datastore-level";
import { logger } from "../lib/logger.js";

/**
 * Check if Storacha service is available
 * @returns {Promise<boolean>} true if available, false otherwise
 */
async function isStorachaAvailable() {
  try {
    const response = await fetch("https://w3s.link", {
      method: "HEAD",
      headers: { "User-Agent": "@le-space/orbitdb-storage-bridge-test" },
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });
    return response.status < 500; // Accept any status except 5xx server errors
  } catch (error) {
    logger.warn(
      { error: error.message },
      `🔌 Storacha connectivity check failed: ${error.message}`,
    );
    return false;
  }
}

/**
 * Create a Helia/OrbitDB instance with explicit identity for testing
 */
async function createHeliaOrbitDBWithIdentity(suffix = "", identityId = null) {
  const libp2pOptions = {
    addresses: { listen: ["/ip4/0.0.0.0/tcp/0"] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
    },
  };

  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  const blockstore = new LevelBlockstore(
    `./orbitdb-access-test-${uniqueId}${suffix}`,
  );
  const datastore = new LevelDatastore(
    `./orbitdb-access-test-${uniqueId}${suffix}-data`,
  );

  // Helia 7 builds libp2p from options, and fills any of the keys it knows
  // that are left out from its own defaults, which dial the public network.
  const helia = await createHelia({
    libp2p: { peerDiscovery: [], ...libp2pOptions },
    blockstore,
    datastore,
  }).start();
  const libp2p = helia.libp2p;

  const orbitdb = await createOrbitDB({
    ipfs: helia,
    id: identityId,
    directory: `./orbitdb-access-test-${uniqueId}${suffix}-orbitdb`,
  });

  return {
    helia,
    orbitdb,
    libp2p,
    blockstore,
    datastore,
    identity: orbitdb.identity,
  };
}

describe("OrbitDB Storage Bridge - Access Control Integration", () => {
  let aliceNode, bobNode;
  let storachaAvailable = false;

  beforeAll(async () => {
    // Check if Storacha is available before running tests
    storachaAvailable = await isStorachaAvailable();
    if (!storachaAvailable) {
      logger.warn(
        "⚠️ Storacha service appears to be unavailable. Tests will be skipped or modified.",
      );
    }
  });

  beforeEach(async () => {
    if (!process.env.STORACHA_KEY || !process.env.STORACHA_PROOF) {
      return;
    }

    // Only try to clear space if Storacha is available
    if (storachaAvailable) {
      try {
        await clearStorachaSpace({
          storachaKey: process.env.STORACHA_KEY,
          storachaProof: process.env.STORACHA_PROOF,
        });
      } catch (error) {
        logger.warn({ error: error.message }, "Space clearing failed");
      }
    }
  });

  afterEach(async () => {
    // Cleanup nodes
    const nodes = [aliceNode, bobNode].filter(Boolean);
    for (const node of nodes) {
      try {
        await node.orbitdb.stop();
        await node.helia.stop();
        await node.blockstore.close();
        await node.datastore.close();
      } catch (error) {
        logger.warn({ error: error.message }, "Cleanup warning");
      }
    }
    aliceNode = null;
    bobNode = null;
  });

  /**
   * Test explicit different identities with access control enforcement
   *
   * This test validates the scenario from demo-different-identity.js:
   * 1. Alice creates a database with her identity
   * 2. Alice backs up the database to Storacha
   * 3. Bob (different identity) restores the database
   * 4. Bob can read Alice's data but cannot write to it
   * 5. Access control properly prevents unauthorized writes
   */
  test("Different identities with access control enforcement", async () => {
    if (!process.env.STORACHA_KEY || !process.env.STORACHA_PROOF) {
      logger.info("⏭️ Skipping test: Missing Storacha credentials");
      return;
    }

    if (!storachaAvailable) {
      logger.info(
        "⏭️ Skipping test: Storacha service appears to be unavailable",
      );
      return;
    }

    let aliceDB;

    try {
      // Step 1: Create Alice's node with her identity
      aliceNode = await createHeliaOrbitDBWithIdentity("-alice", "alice");

      // Step 2: Alice creates database with default access controller
      aliceDB = await aliceNode.orbitdb.open("access-control-test", {
        type: "events",
        // Default access controller only allows creator to write
      });

      // Step 3: Alice adds data
      const aliceEntries = [
        "Alice's first entry",
        "Alice's private data",
        "Only Alice should be able to write here",
      ];

      for (const entry of aliceEntries) {
        await aliceDB.add(entry);
      }

      const aliceIdentityId = aliceNode.orbitdb.identity.id;

      // Step 4: Backup Alice's database
      const backupResult = await backupDatabase(
        aliceNode.orbitdb,
        aliceDB.address,
        {
          storachaKey: process.env.STORACHA_KEY,
          storachaProof: process.env.STORACHA_PROOF,
        },
      );

      // Handle network failures gracefully
      if (!backupResult.success) {
        if (backupResult.error && backupResult.error.includes("fetch failed")) {
          logger.warn("⚠️ Network connectivity issue detected, skipping test");
          return;
        }
        // Re-throw if it's not a network issue
        throw new Error(`Backup failed: ${backupResult.error}`);
      }

      expect(backupResult.success).toBe(true);
      expect(backupResult.blocksUploaded).toBeGreaterThan(0);

      // Step 5: Close Alice's database and node
      await aliceDB.close();
      await aliceNode.orbitdb.stop();
      await aliceNode.helia.stop();
      await aliceNode.blockstore.close();
      await aliceNode.datastore.close();
      aliceNode = null;

      // Step 6: Create Bob's node with his different identity
      bobNode = await createHeliaOrbitDBWithIdentity("-bob", "bob");
      const bobIdentityId = bobNode.orbitdb.identity.id;

      // Verify identities are different
      expect(aliceIdentityId).not.toBe(bobIdentityId);

      // Step 7: Bob restores database from Storacha
      const restoreResult = await restoreDatabaseFromSpace(bobNode.orbitdb, {
        storachaKey: process.env.STORACHA_KEY,
        storachaProof: process.env.STORACHA_PROOF,
      });

      expect(restoreResult.success).toBe(true);
      expect(restoreResult.entriesRecovered).toBe(aliceEntries.length);

      // Step 8: Verify Bob can read Alice's data
      expect(restoreResult.entries).toHaveLength(aliceEntries.length);
      const restoredValues = restoreResult.entries.map((entry) => entry.value);
      for (const originalEntry of aliceEntries) {
        expect(restoredValues).toContain(originalEntry);
      }

      // Step 9: Verify identity separation in restored data
      const logEntries = await restoreResult.database.log.values();
      if (logEntries.length > 0) {
        const firstLogEntry = logEntries[0];
        expect(firstLogEntry.identity).toBeTruthy();
        expect(firstLogEntry.identity).not.toBe(bobIdentityId);
        // This should be Alice's identity from the restored data
      }

      // Step 10: CRITICAL TEST - Bob attempts to write (should fail)
      let writeAttemptFailed = false;
      let writeErrorMessage = "";

      try {
        await restoreResult.database.add(
          "Bob trying to write to Alice's database",
        );
      } catch (error) {
        writeAttemptFailed = true;
        writeErrorMessage = error.message;
      }

      // Assertions for access control
      expect(writeAttemptFailed).toBe(true);
      expect(writeErrorMessage).toMatch(/not allowed to write|access denied/i);

      // Step 11: Verify database state hasn't changed after failed write attempt
      const entriesAfterWriteAttempt = await restoreResult.database.all();
      expect(entriesAfterWriteAttempt).toHaveLength(aliceEntries.length);

      logger.info("✅ Access control test results:");
      logger.info(
        { aliceIdentityId },
        `   👩 Alice's identity: ${aliceIdentityId}`,
      );
      logger.info({ bobIdentityId }, `   👨 Bob's identity: ${bobIdentityId}`);
      logger.info(
        { different: aliceIdentityId !== bobIdentityId },
        `   📊 Identities different: ${aliceIdentityId !== bobIdentityId}`,
      );
      logger.info(
        { entriesCount: restoreResult.entries.length },
        `   📖 Bob can read: ${restoreResult.entries.length} entries`,
      );
      logger.info(
        { writeAttemptFailed },
        `   🔒 Bob write blocked: ${writeAttemptFailed}`,
      );
      logger.info(
        { writeErrorMessage },
        `   📝 Error message: ${writeErrorMessage}`,
      );

      // Close Bob's database
      await restoreResult.database.close();
    } finally {
      if (aliceDB) {
        try {
          await aliceDB.close();
        } catch {
          // Already closed
        }
      }
    }
  }, 120000); // 2 minute timeout

  /**
   * Test that identity blocks are properly preserved during backup/restore
   *
   * Validates that the identity information from the original database creator
   * is preserved and accessible in the restored database, even when restored
   * by a different user.
   */
  test("Identity block preservation in backup and restore", async () => {
    if (!process.env.STORACHA_KEY || !process.env.STORACHA_PROOF) {
      logger.info("⏭️ Skipping test: Missing Storacha credentials");
      return;
    }

    if (!storachaAvailable) {
      logger.info(
        "⏭️ Skipping test: Storacha service appears to be unavailable",
      );
      return;
    }

    let sourceDB;

    try {
      // Create source node with specific identity
      aliceNode = await createHeliaOrbitDBWithIdentity(
        "-identity-test",
        "identity-test-alice",
      );
      sourceDB = await aliceNode.orbitdb.open("identity-preservation-test", {
        type: "events",
      });

      // Add entries so we have identity information in the log
      await sourceDB.add("Entry with identity info");
      await sourceDB.add("Second entry with identity");

      // Backup database
      const backupResult = await backupDatabase(
        aliceNode.orbitdb,
        sourceDB.address,
        {
          storachaKey: process.env.STORACHA_KEY,
          storachaProof: process.env.STORACHA_PROOF,
        },
      );

      // Handle network failures gracefully
      if (!backupResult.success) {
        if (backupResult.error && backupResult.error.includes("fetch failed")) {
          logger.warn("⚠️ Network connectivity issue detected, skipping test");
          return;
        }
        // Re-throw if it's not a network issue
        throw new Error(`Backup failed: ${backupResult.error}`);
      }

      expect(backupResult.success).toBe(true);

      // Verify that identity blocks are included in backup
      if (backupResult.blockSummary) {
        // Should have identity blocks if they were properly extracted
        logger.info(
          { blockSummary: backupResult.blockSummary },
          "Block summary",
        );
      }

      // Clean up source
      await sourceDB.close();
      await aliceNode.orbitdb.stop();
      await aliceNode.helia.stop();
      await aliceNode.blockstore.close();
      await aliceNode.datastore.close();
      aliceNode = null;

      // Create different node for restore
      bobNode = await createHeliaOrbitDBWithIdentity(
        "-restore-identity",
        "identity-test-bob",
      );

      // Restore database
      const restoreResult = await restoreDatabaseFromSpace(bobNode.orbitdb, {
        storachaKey: process.env.STORACHA_KEY,
        storachaProof: process.env.STORACHA_PROOF,
      });

      expect(restoreResult.success).toBe(true);

      // Verify identity information is preserved
      if (restoreResult.analysis && restoreResult.analysis.identityBlocks) {
        expect(restoreResult.analysis.identityBlocks.length).toBeGreaterThan(0);
        logger.info(
          { count: restoreResult.analysis.identityBlocks.length },
          `✅ Identity blocks preserved: ${restoreResult.analysis.identityBlocks.length} blocks`,
        );
      }

      // Verify log entries contain original identity information
      const logEntries = await restoreResult.database.log.values();
      if (logEntries.length > 0) {
        const firstEntry = logEntries[0];
        expect(firstEntry.identity).toBeTruthy();
        expect(typeof firstEntry.identity).toBe("string");
        logger.info(
          { identity: firstEntry.identity },
          `✅ Log entry identity preserved: ${firstEntry.identity}`,
        );
      }

      await restoreResult.database.close();
    } finally {
      if (sourceDB) {
        try {
          await sourceDB.close();
        } catch {
          // Already closed
        }
      }
    }
  }, 120000);
});
