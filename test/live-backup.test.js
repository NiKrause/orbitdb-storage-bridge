/**
 * @fileoverview Increments: what was written since the last one, shipped as
 * one small CAR, and a node that never saw the database put back from them (#144).
 *
 * Real OrbitDB and Helia, offline, as restore-from-blocks.test.js runs them.
 * The backend is the in-process one, with its store exposed so a test can
 * count what went out and read it back.
 */

import {
  jest,
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
} from "@jest/globals";
import { IPFSAccessController } from "@orbitdb/core";
import { CID } from "multiformats/cid";
import { createMemoryBackend } from "../lib/backends/memory.js";
import { withEncryption } from "../lib/backends/encryption.js";
import { defineBackend } from "../lib/backends/types.js";
import { bundleDatabases } from "../lib/extract-blocks.js";
import {
  createLiveBackup,
  readIncrement,
  mergeIncrements,
  restoreFromIncrements,
  joinIncrements,
  INCREMENT_KIND,
  INCREMENT_VERSION,
} from "../lib/live-backup.js";
import { createHeliaOrbitDB, cleanupOrbitDBDirectories } from "../lib/utils.js";

jest.setTimeout(180000);

const OFFLINE = { useBootstrap: false, useDHT: false, autoDial: false };
const open = { AccessController: IPFSAccessController({ write: ["*"] }) };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A CAR names blocks in base32; OrbitDB in base58btc. The same block, one name. */
const canon = (hash) => CID.parse(hash).toV1().toString();
const has = (blocks, hash) =>
  [...blocks.keys()].some((name) => canon(name) === canon(hash));

/** The increments a memory backend holds, in the order they went in, read back. */
async function incrementsIn(backend, store) {
  const out = [];
  for (const id of store.keys())
    out.push(await readIncrement(await backend.getBlob(id)));
  return out;
}

/** A node that never saw the database, with the increments put back into it. */
async function restoredValues(side, { base, increments }, address) {
  const result = await restoreFromIncrements(side.orbitdb, {
    base,
    increments,
    open,
  });
  const db = result.databases.find((d) => d.address === address)?.database;
  const values = (await db.all()).map((e) => e.value);
  return { result, values, db };
}

/** AES-GCM with a key of its own, shaped like the package's encrypt/decrypt contract. */
async function aesGcm() {
  const key = await globalThis.crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return {
    encrypt: async (plaintext) => {
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = new Uint8Array(
        await globalThis.crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          key,
          plaintext,
        ),
      );
      return { ciphertext, iv };
    },
    decrypt: async (ciphertext, iv) =>
      new Uint8Array(
        await globalThis.crypto.subtle.decrypt(
          { name: "AES-GCM", iv },
          key,
          ciphertext,
        ),
      ),
  };
}

let alice;
let bob;
let carol;
let dave;
const sides = [];

beforeAll(async () => {
  alice = await createHeliaOrbitDB("-live-alice", OFFLINE);
  bob = await createHeliaOrbitDB("-live-bob", OFFLINE);
  carol = await createHeliaOrbitDB("-live-carol", OFFLINE);
  dave = await createHeliaOrbitDB("-live-dave", OFFLINE);
  sides.push(alice, bob, carol, dave);
});

afterAll(async () => {
  for (const side of sides) {
    await side?.orbitdb?.stop?.();
    await side?.helia?.stop?.();
  }
  await cleanupOrbitDBDirectories();
});

describe("increments", () => {
  test("the first increment carries manifest, access controller, identity and every entry; the second only what is new; nothing new ships nothing", async () => {
    const store = new Map();
    const backend = createMemoryBackend({ store });
    const todos = await alice.orbitdb.open("live-todos", {
      type: "events",
      ...open,
    });
    await todos.add("buy milk");
    await todos.add("fix the antenna");

    const shipped = [];
    const live = createLiveBackup({
      databases: { todos },
      backend,
      onShipped: (s) => shipped.push(s),
    });
    const first = await live.flush();
    expect(first.sequence).toBe(1);
    expect(first.entries).toBe(2);
    expect(store.size).toBe(1);

    const [one] = await incrementsIn(backend, store);
    expect(one.manifest.kind).toBe(INCREMENT_KIND);
    expect(one.manifest.v).toBe(INCREMENT_VERSION);
    expect(one.manifest.sequence).toBe(1);
    expect(one.manifest.base).toBeNull();
    expect(one.manifest.previous).toBeNull();
    const [described] = one.manifest.metadata.databases;
    expect(described.address).toBe(todos.address);
    expect(described.collection).toBe("todos");
    expect(described.entries).toBe(2);
    expect(described.since).toEqual([]);
    expect(described.heads).toEqual(
      (await todos.log.heads()).map((h) => h.hash),
    );
    // manifest + access controller + identity + 2 entries + the increment's root
    expect(one.blocks.size).toBe(6);
    expect(has(one.blocks, described.manifestCID)).toBe(true);
    expect(has(one.blocks, todos.identity.hash)).toBe(true);

    await todos.add("call the tax adviser");
    await todos.add("water the plants");
    await todos.add("read the manual");
    const second = await live.flush();
    expect(second.sequence).toBe(2);
    expect(second.entries).toBe(3);
    const [, two] = await incrementsIn(backend, store);
    expect(two.manifest.previous).toBe(first.handle.id);
    expect(two.manifest.metadata.databases[0].since).toEqual(described.heads);
    // manifest + access controller + identity + 3 entries + root: the first two entries do not travel again
    expect(two.blocks.size).toBe(7);

    expect(await live.flush()).toBeNull();
    expect(store.size).toBe(2);
    expect(shipped.map((s) => s.sequence)).toEqual([1, 2]);
    expect(live.status()).toMatchObject({
      sequence: 2,
      pending: 0,
      failures: 0,
      lastError: null,
    });

    // A node that never saw the database, from the increments alone.
    const { result, values } = await restoredValues(
      bob,
      { increments: await incrementsIn(backend, store) },
      todos.address,
    );
    expect(result.sequences).toEqual([1, 2]);
    expect(values).toEqual([
      "buy milk",
      "fix the antenna",
      "call the tax adviser",
      "water the plants",
      "read the manual",
    ]);
    expect(result.databases[0].joined).toBe(1);
    await live.stop();
  });

  test("a base backup plus the increments after it restores the same, and rebase starts the count again", async () => {
    const store = new Map();
    const backend = createMemoryBackend({ store });
    const notes = await alice.orbitdb.open("live-notes", {
      type: "keyvalue",
      ...open,
    });
    await notes.put("theme", "dark");
    await notes.put("lang", "de");

    const base = await bundleDatabases([notes]);
    const live = createLiveBackup({ databases: [notes], backend });
    await live.rebase({ base: "base-1" });
    expect(await live.flush()).toBeNull();

    await notes.put("theme", "light");
    const shipped = await live.flush();
    expect(shipped.sequence).toBe(1);
    expect(shipped.entries).toBe(1);
    const [increment] = await incrementsIn(backend, store);
    expect(increment.manifest.base).toBe("base-1");

    const merged = mergeIncrements({ base, increments: [increment] });
    expect(merged.metadata.databases[0].heads).toEqual(
      increment.manifest.metadata.databases[0].heads,
    );

    const { values } = await restoredValues(
      carol,
      { base, increments: [increment] },
      notes.address,
    );
    expect(values.sort()).toEqual(["de", "light"]);
    await live.stop();
  });

  test("an unreachable backend loses nothing: the state stays, and the next flush ships it all", async () => {
    const store = new Map();
    const inner = createMemoryBackend({ store });
    let down = true;
    const backend = defineBackend({
      ...inner,
      putBlob: async (bytes, meta) => {
        if (down) throw new Error("ECONNREFUSED");
        return inner.putBlob(bytes, meta);
      },
    });
    const errors = [];
    const log = await alice.orbitdb.open("live-outage", {
      type: "events",
      ...open,
    });
    await log.add("written while offline");
    const live = createLiveBackup({
      databases: [log],
      backend,
      onError: (e) => errors.push(e),
    });

    await expect(live.flush()).rejects.toThrow("ECONNREFUSED");
    expect(store.size).toBe(0);
    expect(live.status()).toMatchObject({ sequence: 0, failures: 1 });
    expect(errors).toHaveLength(1);

    await log.add("and another");
    down = false;
    const shipped = await live.flush();
    expect(shipped.sequence).toBe(1);
    expect(shipped.entries).toBe(2);
    expect(live.status()).toMatchObject({
      sequence: 1,
      failures: 1,
      lastError: null,
    });
    await live.stop();
  });

  test("entries that arrived by replication from another writer ship too, with that writer's identity", async () => {
    const store = new Map();
    const backend = createMemoryBackend({ store });
    const mine = await alice.orbitdb.open("live-shared", {
      type: "events",
      ...open,
    });
    await mine.add("alice's");
    const live = createLiveBackup({ databases: [mine], backend });
    await live.flush();

    // Bob writes to the same database on his node — which, offline, first
    // needs its manifest and access controller — and his entry and identity
    // reach Alice's node the way sync would bring them; her log joins it.
    for (const [name, { bytes }] of (await bundleDatabases([mine])).blocks) {
      await bob.helia.blockstore.put(CID.parse(name), bytes);
    }
    const theirs = await bob.orbitdb.open(mine.address, {
      type: "events",
      ...open,
    });
    await theirs.add("bob's");
    const [head] = await theirs.log.heads();
    for (const hash of [head.hash, theirs.identity.hash]) {
      const bytes =
        hash === head.hash
          ? await theirs.log.storage.get(hash)
          : theirs.identity.bytes;
      await alice.helia.blockstore.put(CID.parse(hash), bytes);
    }
    expect(await mine.log.joinEntry(head)).toBe(true);

    const shipped = await live.flush();
    expect(shipped.entries).toBe(1);
    const [, two] = await incrementsIn(backend, store);
    expect(has(two.blocks, head.hash)).toBe(true);
    expect(has(two.blocks, theirs.identity.hash)).toBe(true);
    expect(has(two.blocks, mine.identity.hash)).toBe(false);

    const { values } = await restoredValues(
      carol,
      { increments: await incrementsIn(backend, store) },
      mine.address,
    );
    expect(values.sort()).toEqual(["alice's", "bob's"]);
    await theirs.close();
    await live.stop();
  });

  test("starting ships what was written before the watcher came", async () => {
    const store = new Map();
    const backend = createMemoryBackend({ store });
    const db = await alice.orbitdb.open("live-backlog", {
      type: "events",
      ...open,
    });
    await db.add("before the watcher");
    const live = createLiveBackup({
      databases: [db],
      backend,
      after: 10,
      settle: 50,
    });
    await live.start();
    await sleep(400);
    expect(store.size).toBe(1);
    expect(live.status().sequence).toBe(1);
    await live.stop();
  });

  test("after enough updates it flushes by itself, and a burst becomes one increment", async () => {
    const store = new Map();
    const backend = createMemoryBackend({ store });
    const db = await alice.orbitdb.open("live-auto", {
      type: "events",
      ...open,
    });
    const shipped = [];
    const live = createLiveBackup({
      databases: [db],
      backend,
      after: 2,
      settle: 50,
      onShipped: (s) => shipped.push(s),
    });
    await live.start();
    await db.add("one");
    expect(store.size).toBe(0);
    await db.add("two");
    await db.add("three");
    await sleep(400);
    expect(shipped).toHaveLength(1);
    expect(shipped[0].entries).toBe(3);
    expect(live.status().pending).toBe(0);
    await live.stop();
  });

  test("a timer ships what is pending, and nothing when nothing is", async () => {
    const store = new Map();
    const backend = createMemoryBackend({ store });
    const db = await alice.orbitdb.open("live-timer", {
      type: "events",
      ...open,
    });
    const live = createLiveBackup({ databases: [db], backend, every: 100 });
    await live.start();
    await sleep(250);
    expect(store.size).toBe(0);
    await db.add("tick");
    await sleep(250);
    expect(store.size).toBe(1);
    await sleep(250);
    expect(store.size).toBe(1);
    await live.stop();
  });

  test("a restarted watcher takes up from the persisted heads and does not ship again", async () => {
    const store = new Map();
    const backend = createMemoryBackend({ store });
    const db = await alice.orbitdb.open("live-restart", {
      type: "events",
      ...open,
    });
    await db.add("before");
    let saved = null;
    const state = { load: async () => saved, save: async (s) => (saved = s) };

    const first = createLiveBackup({ databases: [db], backend, state });
    await first.flush();
    expect(saved.sequence).toBe(1);
    expect(saved.databases[db.address].heads).toHaveLength(1);
    await first.stop();

    await db.add("after");
    const second = createLiveBackup({ databases: [db], backend, state });
    const shipped = await second.flush();
    expect(shipped.sequence).toBe(2);
    expect(shipped.entries).toBe(1);
    expect(store.size).toBe(2);
    await second.stop();
  });

  test("a database watched later ships from its beginning, and one unwatched ships no more", async () => {
    const store = new Map();
    const backend = createMemoryBackend({ store });
    const a = await alice.orbitdb.open("live-later-a", {
      type: "events",
      ...open,
    });
    const b = await alice.orbitdb.open("live-later-b", {
      type: "events",
      ...open,
    });
    await a.add("a1");
    await b.add("b1");
    const live = createLiveBackup({ databases: [a], backend });
    await live.flush();
    live.watch(b, "b");
    const shipped = await live.flush();
    expect(shipped.entries).toBe(1);
    const [, two] = await incrementsIn(backend, store);
    expect(two.manifest.metadata.databases.map((d) => d.collection)).toEqual([
      "b",
    ]);
    live.unwatch(b);
    await b.add("b2");
    expect(await live.flush()).toBeNull();
    await live.stop();
  });

  test("a backend that stores but does not keep is asked to keep", async () => {
    const store = new Map();
    const inner = createMemoryBackend({ store });
    const kept = [];
    const backend = defineBackend({
      ...inner,
      capabilities: { ...inner.capabilities, pinByCid: true },
      putBlob: async (bytes, meta) => ({
        ...(await inner.putBlob(bytes, meta)),
        retained: false,
      }),
      pinCid: async (cid, meta) => {
        kept.push({ cid, meta });
        return { id: cid, cid, backend: "memory", retained: true };
      },
    });
    const db = await alice.orbitdb.open("live-keep", {
      type: "events",
      ...open,
    });
    await db.add("keep me");
    const live = createLiveBackup({ databases: [db], backend });
    const shipped = await live.flush();
    expect(kept).toHaveLength(1);
    expect(kept[0].cid).toBe(shipped.handle.id);
    expect(shipped.kept.retained).toBe(true);
    await live.stop();
  });

  test("sealed through withEncryption, the service sees nothing and the restore reads everything", async () => {
    const store = new Map();
    const key = await aesGcm();
    const backend = withEncryption(createMemoryBackend({ store }), key);
    const db = await alice.orbitdb.open("live-sealed", {
      type: "events",
      ...open,
    });
    await db.add("secret todo");
    const live = createLiveBackup({ databases: [db], backend });
    await live.flush();

    const [id] = store.keys();
    expect(
      Buffer.from(store.get(id)).includes(Buffer.from("secret todo")),
    ).toBe(false);
    await expect(readIncrement(store.get(id))).rejects.toThrow();
    const increment = await readIncrement(await backend.getBlob(id));
    const { values } = await restoredValues(
      dave,
      { increments: [increment] },
      db.address,
    );
    expect(values).toEqual(["secret todo"]);
    await live.stop();
  });

  test("blocks of the application's own travel in the next increment", async () => {
    const store = new Map();
    const backend = createMemoryBackend({ store });
    const db = await alice.orbitdb.open("live-own", {
      type: "events",
      ...open,
    });
    await db.add("with a file");
    const file = new TextEncoder().encode("a receipt file");
    const { sha256 } = await import("multiformats/hashes/sha2");
    const raw = await import("multiformats/codecs/raw");
    const fileCid = CID.createV1(raw.code, await sha256.digest(file));
    const own = new Map([[fileCid.toString(), { cid: fileCid, bytes: file }]]);
    const live = createLiveBackup({
      databases: [db],
      backend,
      blocks: () => own,
    });
    await live.flush();
    const [one] = await incrementsIn(backend, store);
    expect(has(one.blocks, fileCid.toString())).toBe(true);
    await live.stop();
  });

  test("joinIncrements brings the entries into a database that stays open", async () => {
    const store = new Map();
    const backend = createMemoryBackend({ store });
    const mine = await alice.orbitdb.open("live-join", {
      type: "keyvalue",
      ...open,
    });
    await mine.put("a", 1);
    const live = createLiveBackup({ databases: [mine], backend });
    await live.flush();
    await mine.put("b", 2);
    await mine.put("a", 3);
    await live.flush();

    // Dave opens the same address — offline, so the manifest has to be there
    // first — and holds the instance on screen, as an application would.
    for (const [name, { bytes }] of (await bundleDatabases([mine])).blocks) {
      await dave.helia.blockstore.put(CID.parse(name), bytes);
    }
    const theirs = await dave.orbitdb.open(mine.address, {
      type: "keyvalue",
      ...open,
    });
    expect(await theirs.all()).toEqual([]);

    const result = await joinIncrements(theirs, {
      increments: await incrementsIn(backend, store),
    });
    expect(result).toMatchObject({ joined: 1, heads: 1 });
    expect(await theirs.get("a")).toBe(3);
    expect(await theirs.get("b")).toBe(2);

    // What came back counts as shipped, and the numbering carries on: a
    // watcher on Dave's copy, told so, ships nothing now and continues at 3.
    const davesStore = new Map();
    const davesLive = createLiveBackup({
      databases: [theirs],
      backend: createMemoryBackend({ store: davesStore }),
    });
    await davesLive.rebase();
    expect(await davesLive.flush()).toBeNull();
    const saved = {
      load: async () => ({
        v: 1,
        sequence: 2,
        base: null,
        previous: "x",
        databases: {},
      }),
      save: async () => {},
    };
    const continuing = createLiveBackup({
      databases: [theirs],
      backend: createMemoryBackend({ store: davesStore }),
      state: saved,
    });
    await continuing.rebase();
    await theirs.put("c", 4);
    expect((await continuing.flush()).sequence).toBe(3);
    await davesLive.stop();
    await continuing.stop();
    await expect(joinIncrements(mine, { increments: [] })).rejects.toThrow();
    await theirs.close();
    await live.stop();
  });

  test("readIncrement refuses a CAR that is not an increment", async () => {
    const db = await alice.orbitdb.open("live-not", {
      type: "events",
      ...open,
    });
    await db.add("x");
    const { blocks, metadata } = await bundleDatabases([db]);
    const { createCARFromBlocks } = await import("../lib/backup-car.js");
    const car = await createCARFromBlocks(blocks, metadata.manifestCID);
    await expect(readIncrement(car)).rejects.toThrow("no increment manifest");
  });
});
