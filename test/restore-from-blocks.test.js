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
import { restoreFromBlocks, restoreFromCID, readBlocksFromCAR } from "../lib/restore-cid.js";
import { isValidMetadata } from "../lib/backup-metadata.js";
import { createCARFromBlocks } from "../lib/backup-car.js";
import { createHeliaOrbitDB, cleanupOrbitDBDirectories } from "../lib/utils.js";

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
