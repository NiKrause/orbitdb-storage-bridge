/**
 * @fileoverview Several databases in one backup, and back.
 *
 * `bundleDatabases` packs three databases of different types into one block
 * Map with the metadata that names them all; `restoreFromBlocks` puts every one
 * of them back into a node that has never seen them, from blocks already in
 * hand — the shape an application has after opening a backup it sealed itself.
 * Both nodes run offline: nothing is fetched, nothing is dialled.
 */

import { jest, describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { IPFSAccessController } from "@orbitdb/core";
import { bundleDatabases } from "../lib/extract-blocks.js";
import { restoreFromBlocks, restoreFromCID, readBlocksFromCAR, standalone } from "../lib/restore-cid.js";
import { isValidMetadata } from "../lib/backup-metadata.js";
import { createCARFromBlocks } from "../lib/backup-car.js";
import { createHeliaOrbitDB, cleanupOrbitDBDirectories } from "../lib/utils.js";
import { CID } from "multiformats/cid";

jest.setTimeout(180000);

const OFFLINE = { useBootstrap: false, useDHT: false, autoDial: false };
const open = { AccessController: IPFSAccessController({ write: ["*"] }) };

let alice;
let bob;
let carol;
let dbs;

beforeAll(async () => {
  alice = await createHeliaOrbitDB("-bundle-alice", OFFLINE);
  bob = await createHeliaOrbitDB("-bundle-bob", OFFLINE);
  carol = await createHeliaOrbitDB("-bundle-carol", OFFLINE);

  const todos = await alice.orbitdb.open("bundle-todos", { type: "events", ...open });
  for (const todo of ["buy milk", "fix the antenna"]) await todos.add(todo);
  const settings = await alice.orbitdb.open("bundle-settings", { type: "keyvalue", ...open });
  await settings.put("theme", "dark");
  await settings.put("theme", "light");
  const people = await alice.orbitdb.open("bundle-people", { type: "documents", ...open });
  await people.put({ _id: "p1", name: "Ada" });
  dbs = { todos, settings, people };
});

afterAll(async () => {
  for (const db of Object.values(dbs ?? {})) await db?.close?.();
  for (const side of [alice, bob, carol]) {
    await side?.orbitdb?.stop?.();
    await side?.helia?.stop?.();
  }
  await cleanupOrbitDBDirectories();
});

/** The three databases, read back as plain values. */
async function contents(orbitdb, metadata) {
  const out = {};
  for (const { address, type } of metadata.databases) {
    const db = await orbitdb.open(address, { type, ...open });
    out[type] = (await db.all()).map((e) => e.value);
  }
  return out;
}

describe("bundleDatabases", () => {
  test("names every database with its heads, and counts as it goes", async () => {
    const seen = [];
    const { blocks, metadata } = await bundleDatabases(dbs, {
      onProgress: (p) => seen.push(p),
      timestamp: 1,
    });

    expect(isValidMetadata(metadata)).toBe(true);
    expect(metadata.databaseCount).toBe(3);
    expect(metadata.timestamp).toBe(1);
    expect(metadata.totalBlocks).toBe(blocks.size);
    expect(metadata.totalEntries).toBe(5);
    expect(metadata.databases.map((d) => d.type)).toEqual(["events", "keyvalue", "documents"]);
    for (const d of metadata.databases) {
      expect(d.heads.length).toBeGreaterThan(0);
      expect(blocks.has(d.manifestCID)).toBe(true);
    }

    expect(seen.map((p) => [p.index, p.total, p.name, p.entries])).toEqual([
      [0, 3, "bundle-todos", 2],
      [1, 3, "bundle-settings", 2],
      [2, 3, "bundle-people", 1],
    ]);
    // The writer's identity is the same block in all three, and is kept once.
    expect(seen.reduce((n, p) => n + p.blocks, 0)).toBe(blocks.size);
  });

  test("refuses nothing to bundle", async () => {
    await expect(bundleDatabases([])).rejects.toThrow(/at least one database/);
  });
});

describe("blocks own their buffer", () => {
  // `CarReader` hands out each block as a view into the one ArrayBuffer the
  // whole CAR lives in, and IndexedDB's structured clone persists the buffer
  // behind a view rather than the view. A browser restoring a 3.7 MB backup
  // therefore wrote 3.7 MB per block — about 7.5 GB for 2 016 of them — and
  // refused everything past roughly block 500 with `QuotaExceededError`. No
  // test here can see that cost: Node has no IndexedDB, so this asserts the
  // property that causes it.
  const isView = (bytes) =>
    bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength;

  test("readBlocksFromCAR hands out no views into the whole CAR", async () => {
    const { blocks, metadata } = await bundleDatabases(dbs);
    const car = await createCARFromBlocks(blocks, metadata.manifestCID);
    const readBack = await readBlocksFromCAR(car);

    expect(readBack.size).toBeGreaterThan(1);
    expect([...readBack].filter(([, { bytes }]) => isView(bytes)).map(([name]) => name)).toEqual([]);
  });

  test("standalone copies a view and leaves bytes that already own their buffer", () => {
    const whole = new Uint8Array([1, 2, 3, 4, 5, 6]);
    expect(standalone(whole)).toBe(whole);

    const view = whole.subarray(2, 4);
    const copy = standalone(view);
    expect(copy).not.toBe(view);
    expect([...copy]).toEqual([3, 4]);
    expect(copy.buffer.byteLength).toBe(2);
  });
});

describe("restoreFromBlocks", () => {
  test("puts every database back into a node that never saw them", async () => {
    const { blocks, metadata } = await bundleDatabases(dbs);
    // Through a CAR and its verifying reader, as an application would have them.
    const car = await createCARFromBlocks(blocks, metadata.manifestCID);
    const readBack = await readBlocksFromCAR(car);

    const seen = [];
    const restored = await restoreFromBlocks(bob.orbitdb, readBack, metadata, {
      onProgress: (p) => seen.push(p),
    });

    expect(restored.databases.map((d) => d.address)).toEqual(
      metadata.databases.map((d) => d.address),
    );
    expect(restored.databases.every((d) => d.joined > 0)).toBe(true);
    expect(seen.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(await contents(bob.orbitdb, metadata)).toEqual({
      events: ["buy milk", "fix the antenna"],
      keyvalue: ["light"],
      documents: [{ _id: "p1", name: "Ada" }],
    });
    expect(bob.libp2p.getConnections()).toHaveLength(0);
  });

  test("writes each entry into one log storage, not into every database's", async () => {
    const { blocks, metadata } = await bundleDatabases(dbs);
    const readBack = await readBlocksFromCAR(await createCARFromBlocks(blocks, metadata.manifestCID));

    // Its own node: restoring into one the other tests use would hand them a
    // database that is already complete.
    const dave = await createHeliaOrbitDB("-bundle-dave", OFFLINE);
    const puts = [];
    const realOpen = dave.orbitdb.open.bind(dave.orbitdb);
    dave.orbitdb.open = async (...args) => {
      const db = await realOpen(...args);
      if (!db.log.storage.__counted) {
        const realPut = db.log.storage.put.bind(db.log.storage);
        db.log.storage.put = async (hash, bytes) => {
          puts.push({ address: db.address, hash });
          return realPut(hash, bytes);
        };
        db.log.storage.__counted = true;
      }
      return db;
    };

    try {
      await restoreFromBlocks(dave.orbitdb, readBack, metadata, { open });

      // The property that matters: no block reaches more than one database.
      // Writing every block into every database — what this used to do — puts
      // all of them into all three (issue #152). Joining a head writes its own
      // entry again, so the count per database is not fixed; the spread is.
      const addressesPerHash = new Map();
      for (const { hash, address } of puts) {
        if (!addressesPerHash.has(hash)) addressesPerHash.set(hash, new Set());
        addressesPerHash.get(hash).add(address);
      }
      expect([...addressesPerHash.values()].every((addresses) => addresses.size === 1)).toBe(true);
      expect(new Set(puts.map((p) => p.address)).size).toBe(metadata.databases.length);
      expect(addressesPerHash.size).toBeLessThanOrEqual(metadata.totalEntries);

      expect(await contents(dave.orbitdb, metadata)).toEqual({
        events: ["buy milk", "fix the antenna"],
        keyvalue: ["light"],
        documents: [{ _id: "p1", name: "Ada" }],
      });
    } finally {
      dave.orbitdb.open = realOpen;
      await dave.orbitdb?.stop?.();
      await dave.helia?.stop?.();
    }
  });

  test("metadata that states no heads: each log's own are found in the blocks", async () => {
    const { blocks, metadata } = await bundleDatabases(dbs);
    const withoutHeads = {
      ...metadata,
      databases: metadata.databases.map(({ heads: _heads, ...rest }) => rest),
    };
    const restored = await restoreFromBlocks(carol.orbitdb, blocks, withoutHeads);
    expect(restored.databases.map((d) => d.joined)).toEqual([1, 1, 1]);
    expect((await contents(carol.orbitdb, metadata)).keyvalue).toEqual(["light"]);
  });

  test("a database whose manifest is not among the blocks is refused before anything is stored", async () => {
    const { blocks, metadata } = await bundleDatabases(dbs);
    const missing = new Map(blocks);
    missing.delete(metadata.databases[1].manifestCID);
    await expect(restoreFromBlocks(bob.orbitdb, missing, metadata)).rejects.toThrow(
      /does not contain the manifest/,
    );
    await expect(restoreFromBlocks(bob.orbitdb, [], metadata)).rejects.toThrow(/must be a Map/);
    await expect(restoreFromBlocks(bob.orbitdb, blocks, { hello: 1 })).rejects.toThrow(
      /Invalid backup metadata/,
    );
  });
});

describe("restoreFromCID, now with more than one database", () => {
  test("restores them all, and keeps the one-database answer at the top", async () => {
    const { blocks, metadata } = await bundleDatabases(dbs);
    const car = await createCARFromBlocks(blocks, metadata.manifestCID);
    const store = new Map([
      ["bafyTESTmeta", new TextEncoder().encode(JSON.stringify({ ...metadata, carCID: "bafyTESTcar" }))],
      ["bafyTESTcar", car],
    ]);
    const restored = await restoreFromCID(bob.orbitdb, {
      metadataCID: "bafyTESTmeta",
      fetchBytes: async (cid) => store.get(cid),
    });
    expect(restored.databases).toHaveLength(3);
    expect(restored.address).toBe(metadata.databases[0].address);
    expect((await restored.database.all()).map((e) => e.value)).toEqual([
      "buy milk",
      "fix the antenna",
    ]);
  });
});

describe("an encrypted database", () => {
  // OrbitDB's `encryption.data`: a reversible stand-in for real sealing, so
  // the stored payload is not the plain value and must be decrypted to join.
  const MARK = 0xee;
  const encryption = {
    data: {
      encrypt: async (bytes) => new Uint8Array([MARK, ...bytes]),
      decrypt: async (bytes) => {
        if (bytes[0] !== MARK) throw new Error("not sealed");
        return bytes.subarray(1);
      },
    },
  };

  test("comes back: its heads are joined as the log decodes them, not as raw fields", async () => {
    const sealed = await alice.orbitdb.open("bundle-sealed", { type: "keyvalue", encryption, ...open });
    await sealed.put("amount", "-52.59");
    await sealed.put("amount", "-12.34");

    const { blocks, metadata } = await bundleDatabases([sealed]);
    const restored = await restoreFromBlocks(carol.orbitdb, blocks, metadata, {
      open: { encryption, ...open },
    });

    expect(restored.databases[0].joined).toBe(1);
    expect(await restored.databases[0].database.get("amount")).toBe("-12.34");
    await sealed.close();
  });
});

describe("a blockstore that will not take the blocks", () => {
  // Its own node: carol has already been restored into above, and a log that
  // holds the head already reports it as nothing joined.
  let dave;
  beforeAll(async () => {
    dave = await createHeliaOrbitDB("-bundle-dave", OFFLINE);
  });
  afterAll(async () => {
    await dave?.orbitdb?.stop?.();
    await dave?.helia?.stop?.();
  });

  /** How many of these blocks the node's blockstore holds. */
  async function heldBy(orbitdb, blocks) {
    let held = 0;
    for (const cidString of blocks.keys()) {
      if (await orbitdb.ipfs.blockstore.has(CID.parse(cidString))) held++;
    }
    return held;
  }

  /** Take `n` blocks, then refuse the rest the way a spent browser quota does. */
  function refuseAfter(orbitdb, n) {
    const blockstore = orbitdb.ipfs.blockstore;
    const own = Object.prototype.hasOwnProperty.call(blockstore, "put");
    const real = blockstore.put.bind(blockstore);
    let taken = 0;
    blockstore.put = async (cid, bytes) => {
      if (taken++ >= n) {
        const error = new Error("QuotaExceededError");
        error.name = "PutFailedError";
        throw error;
      }
      return real(cid, bytes);
    };
    return () => {
      if (own) blockstore.put = real;
      else delete blockstore.put;
    };
  }

  test("stops there, rather than leaving the log to wait out the heads it cannot find", async () => {
    const { blocks, metadata } = await bundleDatabases([dbs.todos]);
    const closed = [];
    const undo = refuseAfter(dave.orbitdb, 2);
    try {
      await expect(
        restoreFromBlocks(dave.orbitdb, blocks, metadata, {
          open,
          beforeJoin: () => closed.push("closed"),
        }),
      ).rejects.toMatchObject({ name: "BlocksNotStoredError", stored: 2, total: blocks.size });
    } finally {
      undo();
    }
    // And it stops early enough that the caller still holds everything it had:
    // closing the books for a restore that cannot run is how a browser ends up
    // on its lock screen with nothing in it.
    expect(closed).toEqual([]);
  });

  test("beforeJoin runs once every block is in, and before any database opens", async () => {
    const { blocks, metadata } = await bundleDatabases([dbs.todos]);
    const order = [];
    const restored = await restoreFromBlocks(dave.orbitdb, blocks, metadata, {
      open,
      beforeJoin: async () => order.push(`blocks in: ${await heldBy(dave.orbitdb, blocks)}`),
      onProgress: () => order.push("database opened"),
    });
    expect(order).toEqual([`blocks in: ${blocks.size}`, "database opened"]);
    expect(restored.databases[0].joined).toBe(1);
  });
});

describe("a head the backup does not carry", () => {
  // Its own nodes: a node that already holds the log joins nothing new, and
  // "joined 0" would then mean two different things.
  let erin;
  let frank;
  beforeAll(async () => {
    erin = await createHeliaOrbitDB("-bundle-erin", OFFLINE);
    frank = await createHeliaOrbitDB("-bundle-frank", OFFLINE);
  });
  afterAll(async () => {
    for (const side of [erin, frank]) {
      await side?.orbitdb?.stop?.();
      await side?.helia?.stop?.();
    }
  });

  const sameCid = (/** @type {any} */ a, /** @type {any} */ b) => {
    try {
      return CID.parse(String(a)).toV1().toString() === CID.parse(String(b)).toV1().toString();
    } catch {
      return false;
    }
  };

  /** A backup with its one head taken out of the blocks and kept aside. */
  async function withoutItsHead() {
    const { blocks, metadata } = await bundleDatabases([dbs.todos]);
    const head = metadata.databases[0].heads[0];
    const key = [...blocks.keys()].find((k) => sameCid(k, head));
    expect(key).toBeDefined();
    const bytes = blocks.get(key).bytes;
    blocks.delete(key);
    return { blocks, metadata, head, bytes };
  }

  test("is named rather than quietly dropped", async () => {
    const { blocks, metadata, head } = await withoutItsHead();
    const restored = await restoreFromBlocks(erin.orbitdb, blocks, metadata, { open });
    // The restore itself does not fail: the caller may know another way in.
    expect(restored.missingHeads).toHaveLength(1);
    expect(sameCid(restored.missingHeads[0], head)).toBe(true);
    expect(restored.databases[0].joined).toBe(0);
  });

  test("is fetched from a second source, checked against its CID, and joined", async () => {
    const { blocks, metadata, head, bytes } = await withoutItsHead();
    /** @type {string[]} */
    const asked = [];
    /** @type {string[]} */
    const order = [];
    const restored = await restoreFromBlocks(frank.orbitdb, blocks, metadata, {
      open,
      beforeJoin: () => order.push("books closed"),
      fetchBytes: async (/** @type {string} */ cid) => {
        asked.push(cid);
        order.push("asked the second source");
        return bytes;
      },
    });
    expect(asked).toHaveLength(1);
    // Asking can fail, so it happens while the caller still holds everything.
    expect(order).toEqual(["asked the second source", "books closed"]);
    expect(sameCid(asked[0], head)).toBe(true);
    expect(restored.missingHeads).toEqual([]);
    expect(restored.databases[0].joined).toBe(1);
    expect((await restored.databases[0].database.all()).map((/** @type {any} */ e) => e.value)).toEqual([
      "buy milk",
      "fix the antenna",
    ]);
  });

  test("requireHeads refuses the restore, and before the books are closed", async () => {
    const { blocks, metadata } = await withoutItsHead();
    /** @type {string[]} */
    const order = [];
    await expect(
      restoreFromBlocks(erin.orbitdb, blocks, metadata, {
        open,
        requireHeads: true,
        beforeJoin: () => order.push("books closed"),
      }),
    ).rejects.toMatchObject({ name: "MissingHeadsError" });
    expect(order).toEqual([]);
  });

  test("a second source answering with something else is refused", async () => {
    const { blocks, metadata } = await withoutItsHead();
    const restored = await restoreFromBlocks(erin.orbitdb, blocks, metadata, {
      open,
      fetchBytes: async () => new Uint8Array([1, 2, 3]),
    });
    expect(restored.missingHeads).toHaveLength(1);
    expect(restored.databases[0].joined).toBe(0);
  });
});
