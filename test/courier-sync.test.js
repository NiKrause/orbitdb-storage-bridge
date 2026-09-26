/**
 * @fileoverview Courier Sync Tests
 *
 * Two OrbitDB instances converge over an in-memory byte courier — no libp2p
 * connection, no pubsub, no network. This is phase 0 of the LoRa data plane
 * (https://github.com/NiKrause/funkpost/issues/1, tracked
 * here as issue #50): the protocol logic, tested against a courier that is
 * deliberately lossy, duplicating and reordering, the way a mesh is.
 *
 * The hard assertion running through the suite: replication happens while
 * both libp2p nodes hold ZERO connections.
 */

/* global setImmediate */
import {
  jest,
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
} from "@jest/globals";
import { IPFSAccessController } from "@orbitdb/core";
import {
  createCourierSync,
  createDelta,
  applyDelta,
  databaseTag,
} from "../lib/courier-sync.js";
import { createMemoryCourierPair } from "../lib/memory-courier.js";
import * as dagCbor from "@ipld/dag-cbor";
import { createHeliaOrbitDB, cleanupOrbitDBDirectories } from "../lib/utils.js";

jest.setTimeout(180000);

const OFFLINE = { useBootstrap: false, useDHT: false, autoDial: false };
const GZIP_THRESHOLD_FOR_TEST = 256; // mirrors courier-sync GZIP_THRESHOLD

/**
 * Drive both couriers and both protocol queues until nothing moves anymore.
 * Each round waits for in-flight deliveries, then for the handlers those
 * deliveries triggered; handlers may send again, hence the bounded loop.
 */
async function converge(pair, syncs, rounds = 25) {
  for (let i = 0; i < rounds; i++) {
    await pair.idle();
    for (const sync of syncs) await sync.idle();
  }
}

/** keyvalue all() returns [{ key, value, hash }]; the sorted keys tell the story. */
const keysOf = async (db) => (await db.all()).map((entry) => entry.key).sort();

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

describe("Courier Sync — OrbitDB replication over a byte courier, no libp2p", () => {
  let alice;
  let bob;
  const openedDbs = [];
  const track = (db) => {
    if (db) openedDbs.push(db);
    return db;
  };

  beforeAll(async () => {
    alice = await createHeliaOrbitDB("-courier-alice", OFFLINE);
    bob = await createHeliaOrbitDB("-courier-bob", OFFLINE);
  });

  afterAll(async () => {
    for (const db of openedDbs) {
      try {
        await db.close();
      } catch {
        // already closed is fine
      }
    }
    for (const node of [alice, bob]) {
      if (!node) continue;
      try {
        await node.orbitdb.stop();
        await node.helia.stop();
        await node.blockstore.close();
        await node.datastore.close();
      } catch {
        // best-effort teardown
      }
    }
    await cleanupOrbitDBDirectories();
  });

  test("first contact: a fresh peer bootstraps a database it has never seen", async () => {
    const db = track(
      await alice.orbitdb.open("courier-first-contact", { type: "keyvalue" }),
    );
    await db.put("one", { text: "Buy groceries" });
    await db.put("two", { text: "Walk the dog" });
    await db.put("three", { text: "Finish the data plane" });

    const pair = createMemoryCourierPair();
    const syncA = await createCourierSync({ db, courier: pair.a });
    const syncB = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: db.address,
      courier: pair.b,
    });

    await syncA.start();
    await syncB.start();
    await converge(pair, [syncA, syncB]);

    expect(track(syncB.db)).toBeTruthy();
    expect(syncB.db.address).toBe(db.address);
    expect(await syncB.db.get("one")).toEqual({ text: "Buy groceries" });
    expect(await keysOf(syncB.db)).toEqual(["one", "three", "two"]);

    // The claim behind the whole design, asserted:
    expect(alice.libp2p.getConnections().length).toBe(0);
    expect(bob.libp2p.getConnections().length).toBe(0);

    await syncA.stop();
    await syncB.stop();
  });

  test("live update: a new entry crosses the courier and fires 'update'", async () => {
    const db = track(
      await alice.orbitdb.open("courier-live", { type: "keyvalue" }),
    );
    await db.put("seed", { text: "hello" });

    const pair = createMemoryCourierPair();
    const syncA = await createCourierSync({ db, courier: pair.a });
    const syncB = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: db.address,
      courier: pair.b,
    });
    await syncA.start();
    await syncB.start();
    await converge(pair, [syncA, syncB]);

    const updates = [];
    track(syncB.db).events.on("update", (entry) => updates.push(entry));

    await db.put("later", { text: "added after bootstrap" });
    await converge(pair, [syncA, syncB]);

    expect(await syncB.db.get("later")).toEqual({
      text: "added after bootstrap",
    });
    expect(updates.length).toBeGreaterThan(0);

    await syncA.stop();
    await syncB.stop();
  });

  test("announceOnLocalUpdate: false stays quiet until asked, and answers when it is", async () => {
    // For a courier that costs money or airtime: several writes, one send.
    // The application decides when the radio is used, not the keystroke.
    const db = track(
      await alice.orbitdb.open("courier-on-demand", { type: "keyvalue" }),
    );
    await db.put("seed", { text: "hello" });

    const pair = createMemoryCourierPair();
    const syncA = await createCourierSync({
      db,
      courier: pair.a,
      announceOnLocalUpdate: false,
    });
    const syncB = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: db.address,
      courier: pair.b,
    });
    await syncA.start();
    await syncB.start();
    await converge(pair, [syncA, syncB]);
    expect(await syncB.db.get("seed")).toEqual({ text: "hello" });

    // Three writes, and the courier must not move for any of them. Both the
    // absence of data and the absence of *traffic* are asserted: a peer that
    // stayed empty because messages were lost would pass the first check only.
    const sentBefore = pair.stats.sent;
    await db.put("one", { text: "1" });
    await db.put("two", { text: "2" });
    await db.put("three", { text: "3" });
    await converge(pair, [syncA, syncB]);

    expect(await syncB.db.get("one")).toBeUndefined();
    expect(await syncB.db.get("three")).toBeUndefined();
    expect(pair.stats.sent).toEqual(sentBefore);

    // One deliberate announce carries all three at once — the point of opting
    // out is batching, not silence.
    await syncA.announce();
    await converge(pair, [syncA, syncB]);

    expect(await syncB.db.get("one")).toEqual({ text: "1" });
    expect(await syncB.db.get("two")).toEqual({ text: "2" });
    expect(await syncB.db.get("three")).toEqual({ text: "3" });

    await syncA.stop();
    await syncB.stop();
  });

  test("announceOnLocalUpdate: false still answers a peer that asks", async () => {
    // Going quiet must not mean going deaf: a joiner who has never seen the
    // database still bootstraps from a silent writer.
    const db = track(
      await alice.orbitdb.open("courier-quiet-but-awake", { type: "keyvalue" }),
    );
    await db.put("seed", { text: "hello" });

    const pair = createMemoryCourierPair();
    const syncA = await createCourierSync({
      db,
      courier: pair.a,
      announceOnLocalUpdate: false,
    });
    const syncB = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: db.address,
      courier: pair.b,
    });
    await syncA.start();
    await syncB.start();
    await converge(pair, [syncA, syncB]);

    expect(await syncB.db.get("seed")).toEqual({ text: "hello" });

    await syncA.stop();
    await syncB.stop();
  });

  test("divergence: both sides write while unplugged, then merge to equal heads", async () => {
    const db = track(
      await alice.orbitdb.open("courier-diverge", {
        type: "keyvalue",
        AccessController: IPFSAccessController({
          write: [alice.orbitdb.identity.id, bob.orbitdb.identity.id],
        }),
      }),
    );
    await db.put("base", { by: "alice" });

    const pair = createMemoryCourierPair();
    const syncA = await createCourierSync({ db, courier: pair.a });
    const syncB = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: db.address,
      courier: pair.b,
    });
    await syncA.start();
    await syncB.start();
    await converge(pair, [syncA, syncB]);
    const bobDb = track(syncB.db);
    expect(bobDb).toBeTruthy();

    // Unplug — write on both sides while no courier runs.
    await syncA.stop();
    await syncB.stop();
    await db.put("a1", { by: "alice" });
    await db.put("a2", { by: "alice" });
    await bobDb.put("b1", { by: "bob" });
    await bobDb.put("b2", { by: "bob" });

    // Replug.
    await syncA.start();
    await syncB.start();
    await converge(pair, [syncA, syncB]);

    expect(await keysOf(db)).toEqual(["a1", "a2", "b1", "b2", "base"]);
    expect(await keysOf(bobDb)).toEqual(["a1", "a2", "b1", "b2", "base"]);

    const aliceHeads = (await db.log.heads()).map((e) => e.hash).sort();
    const bobHeads = (await bobDb.log.heads()).map((e) => e.hash).sort();
    expect(aliceHeads).toEqual(bobHeads);

    await syncA.stop();
    await syncB.stop();
  });

  test("duplicate delivery: every message arrives twice, convergence is exact", async () => {
    const db = track(
      await alice.orbitdb.open("courier-duplicates", { type: "keyvalue" }),
    );
    await db.put("only", { text: "once, please" });

    const pair = createMemoryCourierPair({ duplicateFn: () => true });
    const errors = [];
    const syncA = await createCourierSync({ db, courier: pair.a });
    const syncB = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: db.address,
      courier: pair.b,
    });
    syncA.on("error", (e) => errors.push(e));
    syncB.on("error", (e) => errors.push(e));

    await syncA.start();
    await syncB.start();
    await converge(pair, [syncA, syncB]);

    expect(await keysOf(track(syncB.db))).toEqual(["only"]);
    expect((await syncB.db.log.values()).length).toBe(1);
    expect(errors).toEqual([]);
    expect(pair.stats.duplicated).toBeGreaterThan(0);

    await syncA.stop();
    await syncB.stop();
  });

  test("reordering: LIFO delivery of every batch still converges", async () => {
    const db = track(
      await alice.orbitdb.open("courier-reorder", { type: "keyvalue" }),
    );
    await db.put("r1", { n: 1 });
    await db.put("r2", { n: 2 });
    await db.put("r3", { n: 3 });

    const pair = createMemoryCourierPair({ order: "lifo" });
    const syncA = await createCourierSync({ db, courier: pair.a });
    const syncB = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: db.address,
      courier: pair.b,
    });
    await syncA.start();
    await syncB.start();
    await converge(pair, [syncA, syncB]);

    await db.put("r4", { n: 4 });
    await converge(pair, [syncA, syncB]);

    expect(await keysOf(track(syncB.db))).toEqual(["r1", "r2", "r3", "r4"]);

    await syncA.stop();
    await syncB.stop();
  });

  test("loss and recovery: a dropped delta is healed by a poke", async () => {
    const db = track(
      await alice.orbitdb.open("courier-loss", { type: "keyvalue" }),
    );
    await db.put("l1", { text: "will get lost in transit, once" });

    // Blockade every delta-sized message; small control messages pass. This
    // models a mesh that keeps losing the long fragmented transmissions.
    let blockade = true;
    let dropped = 0;
    const pair = createMemoryCourierPair({
      dropFn: ({ bytes }) => {
        if (blockade && bytes.length > 500) {
          dropped++;
          return true;
        }
        return false;
      },
    });

    const syncA = await createCourierSync({ db, courier: pair.a });
    const syncB = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: db.address,
      courier: pair.b,
    });
    await syncA.start();
    await syncB.start();
    await converge(pair, [syncA, syncB]);

    expect(dropped).toBeGreaterThan(0);
    expect(syncB.db).toBeNull(); // the bootstrap really was lost

    // The channel clears; recovery is one poke — the re-announce a real
    // courier would schedule.
    blockade = false;
    await syncB.announce();
    await converge(pair, [syncA, syncB]);

    expect(track(syncB.db)).toBeTruthy();
    expect(await keysOf(syncB.db)).toEqual(["l1"]);

    await syncA.stop();
    await syncB.stop();
  });

  test("a stranger can carry and read, but not write", async () => {
    // Access controller admits only alice.
    const db = track(
      await alice.orbitdb.open("courier-acl", { type: "keyvalue" }),
    );
    await db.put("owned", { by: "alice" });

    const pair = createMemoryCourierPair();
    const syncA = await createCourierSync({ db, courier: pair.a });
    const syncB = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: db.address,
      courier: pair.b,
    });
    await syncA.start();
    await syncB.start();
    await converge(pair, [syncA, syncB]);

    // Read replication works…
    expect(await syncB.db.get("owned")).toEqual({ by: "alice" });
    track(syncB.db);
    // …the write stays gated by the access controller.
    await expect(syncB.db.put("mine", { by: "bob" })).rejects.toThrow(
      /not allowed/i,
    );

    await converge(pair, [syncA, syncB]);
    expect(await keysOf(db)).toEqual(["owned"]);

    await syncA.stop();
    await syncB.stop();
  });

  test("messages for another database are ignored (address tag)", async () => {
    const tagA = await databaseTag("/orbitdb/zdpuSomewhere");
    const tagB = await databaseTag("/orbitdb/zdpuElsewhere");
    expect(Buffer.from(tagA).equals(Buffer.from(tagB))).toBe(false);

    const db = track(
      await alice.orbitdb.open("courier-tag", { type: "keyvalue" }),
    );
    await db.put("t1", { text: "tagged" });

    const pair = createMemoryCourierPair();
    const syncA = await createCourierSync({ db, courier: pair.a });
    await syncA.start();

    // A foreign sync on the same courier, bound to a different address, must
    // neither crash nor bootstrap from alice's messages.
    const foreign = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: "/orbitdb/zdpuAvFRosgkKTKzZKiennHqxpZC9ycEcqCsBEwmXNP3hbGvA",
      courier: pair.b,
    });
    const errors = [];
    foreign.on("error", (e) => errors.push(e));
    await foreign.start();
    await converge(pair, [syncA, foreign]);

    expect(foreign.db).toBeNull();
    expect(errors).toEqual([]);

    await syncA.stop();
    await foreign.stop();
  });

  test("a large first-contact bootstrap compresses on the wire and still converges", async () => {
    const db = track(
      await alice.orbitdb.open("courier-compress", { type: "keyvalue" }),
    );
    for (let i = 0; i < 25; i++) {
      await db.put(`k${i}`, {
        text: `entry number ${i} — some repetitive filler that deflates well`,
      });
    }

    // What the bootstrap would weigh uncompressed.
    const delta = await createDelta({ db, theirHeads: [] });
    const tagBytes = await databaseTag(db.address);
    const rawLen = dagCbor.encode({
      v: 1,
      tag: tagBytes,
      t: "blocks",
      heads: delta.heads,
      blocks: delta.blocks,
    }).length;

    const pair = createMemoryCourierPair();
    const syncA = await createCourierSync({ db, courier: pair.a });
    let blocksWire = 0;
    syncA.on("message", (m) => {
      if (m.direction === "out" && m.type === "blocks")
        blocksWire = Math.max(blocksWire, m.bytes);
    });
    const syncB = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: db.address,
      courier: pair.b,
    });
    await syncA.start();
    await syncB.start();
    await converge(pair, [syncA, syncB]);

    expect((await keysOf(track(syncB.db))).length).toBe(25);
    expect(rawLen).toBeGreaterThan(GZIP_THRESHOLD_FOR_TEST);
    expect(blocksWire).toBeGreaterThan(0);
    expect(blocksWire).toBeLessThan(rawLen); // compression shrank it on the wire

    await syncA.stop();
    await syncB.stop();
  });

  test("a joiner re-wants on its own until the bootstrap arrives (no manual poke)", async () => {
    const db = track(
      await alice.orbitdb.open("courier-rejoin", { type: "keyvalue" }),
    );
    await db.put("r1", { text: "will be dropped on the first pass" });

    // Drop the first blocks payload wholesale; let everything after through.
    let blockade = true;
    const pair = createMemoryCourierPair({
      dropFn: ({ bytes }) => {
        if (blockade && bytes.length > 200) {
          blockade = false; // only the first big one
          return true;
        }
        return false;
      },
    });
    const syncA = await createCourierSync({ db, courier: pair.a });
    const syncB = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: db.address,
      courier: pair.b,
      rejoinIntervalMs: 40, // re-ask quickly for the test
    });
    await syncA.start();
    await syncB.start();

    // The first bootstrap was lost. Without touching syncB, the periodic
    // re-want must recover it. Give the interval room to fire, then converge.
    await new Promise((resolve) => setTimeout(resolve, 120));
    await converge(pair, [syncA, syncB]);

    expect(track(syncB.db)).toBeTruthy();
    expect(await keysOf(syncB.db)).toEqual(["r1"]);

    await syncA.stop();
    await syncB.stop();
  });

  test("the delta carries the writer's identity even when the log's storage has never held it", async () => {
    // An app that makes its own identities — `Identities()` without `ipfs`, which
    // is what a passkey or DID provider does in a browser — keeps them in memory,
    // not in the blockstore the log reads. Asking the log for such an identity
    // finds nothing locally and, over a courier, there is no network to fall back
    // to: the delta would travel without the block the receiver needs to verify
    // the entries.
    const db = track(
      await alice.orbitdb.open("courier-identity-elsewhere", {
        type: "keyvalue",
      }),
    );
    await db.put("k1", { n: 1 });

    const identityHash = db.identity.hash;
    const storage = db.log.storage;
    const asked = [];
    db.log.storage = {
      ...storage,
      get: async (hash) => {
        asked.push(hash);
        return hash === identityHash ? undefined : storage.get(hash);
      },
    };

    try {
      const delta = await createDelta({ db, theirHeads: [] });
      const identityBlock = delta.blocks.find(
        (block) => block.hash === identityHash,
      );

      expect(identityBlock).toBeDefined();
      expect(identityBlock.bytes).toEqual(db.identity.bytes);
      expect(asked).not.toContain(identityHash);
    } finally {
      db.log.storage = storage;
    }
  });

  test("createDelta/applyDelta round-trip carries exactly the missing suffix", async () => {
    const db = track(
      await alice.orbitdb.open("courier-delta-math", { type: "keyvalue" }),
    );
    await db.put("d1", { n: 1 });
    const midHeads = (await db.log.heads()).map((e) => e.hash);
    await db.put("d2", { n: 2 });
    await db.put("d3", { n: 3 });

    const full = await createDelta({ db, theirHeads: [] });
    const suffix = await createDelta({ db, theirHeads: midHeads });

    // The suffix knows nothing of manifest or d1's block.
    expect(suffix.blocks.length).toBeLessThan(full.blocks.length);
    const suffixHashes = suffix.blocks.map((b) => b.hash);
    expect(suffixHashes).not.toContain(midHeads[0]);

    // An incomplete delta is refused before any join, with the gap named.
    // Bob gets only the static blocks (manifest, access controller, identity)
    // so the address opens; the entry chain then arrives with a hole in it.
    const { CID } = await import("multiformats/cid");
    const { base58btc } = await import("multiformats/bases/base58");
    const dagCbor = await import("@ipld/dag-cbor");
    const isEntry = (bytes) => {
      const value = dagCbor.decode(bytes);
      return Boolean(value && value.sig && value.payload !== undefined);
    };
    for (const block of full.blocks) {
      if (!isEntry(block.bytes)) {
        await bob.orbitdb.ipfs.blockstore.put(
          CID.parse(block.hash, base58btc),
          block.bytes,
        );
      }
    }
    const freshTarget = track(
      await bob.orbitdb.open(db.address, { sync: false }),
    );
    const headOnly = {
      heads: suffix.heads,
      blocks: suffix.blocks.filter((b) => isEntry(b.bytes)).slice(-1),
    };
    const refused = await applyDelta({ db: freshTarget, delta: headOnly });
    expect(refused.complete).toBe(false);
    expect(refused.joined).toBe(0);
    expect(refused.missing.length).toBeGreaterThan(0);
  });

  /**
   * A delta has to be a delta.
   *
   * An entry's `refs` name previous entries directly, and a walk that stops
   * only at the hashes the peer announced follows them around the stop and
   * reaches the root. A peer missing one entry was sent the whole log: 12
   * blocks and 8742 B where 2 blocks and 1533 B were owed — measured on two
   * phones over LoRa, where the carrier moves about half a kilobyte a minute
   * (#127). Ten minutes of airtime to deliver one todo.
   *
   * The round-trip test above could not catch it: `refs` first appear at three
   * entries, and at three entries the newest has exactly one — which is the
   * stop hash itself. The bug needs a log long enough to have a history to walk
   * into.
   */
  test("a peer one entry behind is sent that entry, not the log", async () => {
    const db = track(
      await alice.orbitdb.open("courier-delta-refs", { type: "keyvalue" }),
    );
    for (let i = 0; i < 12; i++) await db.put(`k${i}`, { text: `todo ${i}` });

    const newest = (await db.log.heads())[0];
    const entry = dagCbor.decode(await db.log.storage.get(newest.hash));
    const parent = entry.next[0];

    // The skip-list this is about: without it there is nothing to walk around.
    expect(entry.refs.length).toBeGreaterThan(1);

    const delta = await createDelta({ db, theirHeads: [parent] });
    const hashes = delta.blocks.map((block) => block.hash);

    expect(hashes).toContain(newest.hash);
    expect(hashes).not.toContain(parent);
    for (const ref of entry.refs) expect(hashes).not.toContain(ref);

    // The entry, and the identity block it references. Never the history.
    expect(delta.blocks.length).toBeLessThanOrEqual(2);
  });

  /**
   * The delta may not go to block storage for something the log does not have.
   *
   * `IPFSBlockStorage.get` on a miss waits out a network timeout. Against a
   * Helia node with no peers — every phone in the field — that was measured at
   * 20 s for a single hash, which stalled the whole exchange past the timeouts
   * around it while the delta it eventually produced was perfectly correct
   * (0.14.0, funkpost#170).
   *
   * The peer's announced heads are exactly where misses live: their newest
   * entry is by definition the one we have not got. So this is not an edge
   * case, it is the ordinary path.
   *
   * Convergence cannot pin it here. The nodes in this suite are built with
   * `useBootstrap: false, useDHT: false, autoDial: false`, where a miss fails
   * at once — which is why the bug shipped. What pins it is the rule itself:
   * ask the index, and only then the blocks.
   */
  test("the delta asks the index, never block storage, about a head we do not hold", async () => {
    const db = track(
      await alice.orbitdb.open("courier-delta-no-network", {
        type: "keyvalue",
      }),
    );
    for (let i = 0; i < 4; i++) await db.put(`k${i}`, { n: i });

    const stranger = "zdpuAnEntryThisDatabaseHasNeverSeen";
    const asked = [];
    const storage = db.log.storage;
    const realGet = storage.get.bind(storage);
    storage.get = async (hash) => {
      asked.push(hash);
      return realGet(hash);
    };

    let delta;
    try {
      delta = await createDelta({ db, theirHeads: [stranger] });
    } finally {
      storage.get = realGet;
    }

    expect(asked).not.toContain(stranger);
    // And it still does its job: nothing of that peer's ancestry is walkable,
    // so everything we hold is owed. Correct, and now also prompt.
    expect(delta.blocks.length).toBeGreaterThan(0);
    expect(delta.heads).toEqual((await db.log.heads()).map((e) => e.hash));
  });

  test("a peer standing where we do is sent nothing", async () => {
    const db = track(
      await alice.orbitdb.open("courier-delta-quiet", { type: "keyvalue" }),
    );
    for (let i = 0; i < 5; i++) await db.put(`k${i}`, { n: i });
    const ours = (await db.log.heads()).map((entry) => entry.hash);

    const delta = await createDelta({ db, theirHeads: ours });
    expect(delta.blocks).toEqual([]);
    expect(delta.heads).toEqual(ours);
  });

  /**
   * The other half, unfixed and pinned here so it changes visibly.
   *
   * When the peer has written something of its own, the head it announces is an
   * entry we have never seen. Nothing of its ancestry can be walked, so the
   * stop set is that hash alone and the delta is everything we hold. Applying
   * is idempotent, so this costs bytes rather than correctness — but on a
   * duty-cycled carrier bytes are minutes, and this is the case two people
   * editing one list reach on their first concurrent change.
   *
   * The frontier exchange `createDelta`'s docstring leaves for later is what
   * closes it: a peer that names a few ancestors alongside its heads gives the
   * other side something it can stop at.
   */
  test("a peer whose head we do not hold still costs the whole log", async () => {
    const db = track(
      await alice.orbitdb.open("courier-delta-diverged", { type: "keyvalue" }),
    );
    for (let i = 0; i < 12; i++) await db.put(`k${i}`, { n: i });

    const everything = await createDelta({ db, theirHeads: [] });
    const stranger = await createDelta({
      db,
      theirHeads: ["zdpuAnEntryThisDatabaseHasNeverSeen"],
    });

    const entriesIn = (delta) =>
      delta.blocks.filter((block) => {
        try {
          const value = dagCbor.decode(block.bytes);
          return Boolean(value && value.sig && value.payload !== undefined);
        } catch {
          return false;
        }
      }).length;

    expect(entriesIn(stranger)).toBe(entriesIn(everything));
  });

  /**
   * The two ways a delivery changes nothing, and why telling them apart is the
   * whole point.
   *
   * A day of field logs from two phones over LoRa showed five complete `blocks`
   * deliveries and not one join, with no line to say which of these it was —
   * "synced" only fires when something moved, so a courier doing no harm and a
   * courier doing no good both produced perfect silence (#127).
   */
  test("a delivery that joins nothing says whether it was already held or never sent", async () => {
    const db = track(
      await alice.orbitdb.open("courier-applied-outcome", { type: "keyvalue" }),
    );
    await db.put("a", { n: 1 });
    await db.put("b", { n: 2 });

    const full = await createDelta({ db, theirHeads: [] });

    // Bob is offline from Alice, so the manifest has to be handed over before
    // the address can open at all — as first contact does over the courier.
    const { CID } = await import("multiformats/cid");
    const { base58btc } = await import("multiformats/bases/base58");
    const isEntry = (bytes) => {
      const value = dagCbor.decode(bytes);
      return Boolean(value && value.sig && value.payload !== undefined);
    };
    for (const block of full.blocks) {
      if (isEntry(block.bytes)) continue;
      await bob.orbitdb.ipfs.blockstore.put(
        CID.parse(block.hash, base58btc),
        block.bytes,
      );
    }
    const target = track(await bob.orbitdb.open(db.address, { sync: false }));

    const first = await applyDelta({ db: target, delta: full });
    expect(first.heads).toBe(1);
    expect(first.outcome).toMatchObject({ joined: 1, held: 0, absent: 0 });

    // The same delivery again: wasteful, and correct. `held`.
    const again = await applyDelta({ db: target, delta: full });
    expect(again.complete).toBe(true);
    expect(again.joined).toBe(0);
    expect(again.outcome).toMatchObject({ joined: 0, held: 1, absent: 0 });

    // A head named without the block that carries it: not wasteful, wrong.
    // Identical from outside until now, and it has to read differently.
    await db.put("c", { n: 3 });
    const suffix = await createDelta({ db, theirHeads: full.heads });
    const hollow = await applyDelta({
      db: target,
      delta: { heads: suffix.heads, blocks: [] },
    });
    expect(hollow.complete).toBe(true);
    expect(hollow.joined).toBe(0);
    expect(hollow.outcome).toMatchObject({ joined: 0, held: 0, absent: 1 });
  });

  test("every delivery is reported, including the ones that join nothing", async () => {
    const db = track(
      await alice.orbitdb.open("courier-applied-event", { type: "keyvalue" }),
    );
    await db.put("only", { text: "once" });

    // Duplicated delivery is the cheap way to a redundant delta: the second
    // copy carries what the log already holds, which is the shape a field run
    // has to be able to recognise without a desk to check it against.
    const pair = createMemoryCourierPair({ duplicateFn: () => true });
    const syncA = await createCourierSync({ db, courier: pair.a });
    const syncB = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: db.address,
      courier: pair.b,
    });
    const applied = [];
    const synced = [];
    syncB.on("applied", (report) => applied.push(report));
    syncB.on("synced", (report) => synced.push(report));

    await syncA.start();
    await syncB.start();
    await converge(pair, [syncA, syncB]);

    expect(await keysOf(track(syncB.db))).toEqual(["only"]);
    expect(synced.length).toBeGreaterThanOrEqual(1);

    // More arrived than moved the database, and every arrival is accounted for.
    expect(applied.length).toBeGreaterThan(synced.length);
    expect(applied.some((r) => r.joined === 1)).toBe(true);
    expect(applied.some((r) => r.joined === 0 && r.held > 0)).toBe(true);
    for (const report of applied) expect(report.absent).toBe(0);

    await syncA.stop();
    await syncB.stop();
  });

  /** Resolve on the next turn of the event loop, after pending I/O callbacks. */

  test("a joiner's database is handed out only once the bootstrap is in it", async () => {
    const db = track(
      await alice.orbitdb.open("courier-bootstrap-window", {
        type: "keyvalue",
      }),
    );
    await db.put("one", { text: "already here" });
    await db.put("two", { text: "also here" });

    const pair = createMemoryCourierPair();
    const syncA = await createCourierSync({ db, courier: pair.a });
    const syncB = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: db.address,
      courier: pair.b,
    });
    let joined = false;
    syncB.on("synced", () => {
      joined = true;
    });

    // Look at every turn of the event loop. The first time the database is
    // visible, the bootstrap has to be in it already — an application writes
    // as soon as it has a database, and a write that races the join is lost.
    let visibleBeforeJoined = null;
    let watching = true;
    const watcher = (async () => {
      while (watching && visibleBeforeJoined === null) {
        if (syncB.db) visibleBeforeJoined = !joined;
        await nextTurn();
      }
    })();

    await syncA.start();
    await syncB.start();
    await converge(pair, [syncA, syncB]);
    watching = false;
    await watcher;
    track(syncB.db);

    expect(visibleBeforeJoined).toBe(false);
    expect(await keysOf(syncB.db)).toEqual(["one", "two"]);

    await syncA.stop();
    await syncB.stop();
  });

  test("presence: the question gets an answer even from a peer that never speaks", async () => {
    // The distinction the whole thing exists for. A carrier can report the
    // radios in range; it cannot report whether a program on the other end
    // keeps this database. Only that program can answer.
    //
    // Everything B says is dropped until the hello, so the answer is the only
    // message that can prove anything — otherwise B's own announce on start
    // would have told A, and this test would pass with the hello broken.
    const db = track(
      await alice.orbitdb.open("courier-presence", { type: "keyvalue" }),
    );
    let deaf = true;
    const pair = createMemoryCourierPair({
      dropFn: ({ from }) => deaf && from === "b",
    });
    const syncA = await createCourierSync({ db, courier: pair.a });
    const syncB = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: db.address,
      courier: pair.b,
    });

    // Before anybody has said anything: nothing heard, nobody present.
    expect(syncA.presence()).toEqual({ peers: [], lastHeardAgoMs: null });

    await syncA.start();
    await syncB.start();
    await converge(pair, [syncA, syncB]);
    expect(syncA.presence()).toEqual({ peers: [], lastHeardAgoMs: null });

    deaf = false;
    await syncA.hello();
    await converge(pair, [syncA, syncB]);

    const seen = syncA.presence();
    expect(seen.peers.map((peer) => peer.id)).toEqual([syncB.peerId]);
    expect(seen.lastHeardAgoMs).toBeLessThan(5000);

    await syncA.stop();
    await syncB.stop();
  });

  test("presence: ordinary traffic counts, so the silence is what costs extra", async () => {
    // Nobody should pay airtime for a heartbeat while the two are talking
    // anyway: every message carries the sender id, so a sync round is already
    // an answer to "is anybody there".
    const db = track(
      await alice.orbitdb.open("courier-presence-traffic", {
        type: "keyvalue",
      }),
    );
    await db.put("seed", { text: "hello" });

    const pair = createMemoryCourierPair();
    const syncA = await createCourierSync({ db, courier: pair.a });
    const syncB = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: db.address,
      courier: pair.b,
    });
    await syncA.start();
    await syncB.start();
    await converge(pair, [syncA, syncB]);

    // No hello was ever sent — the bootstrap alone told both sides.
    expect(syncA.presence().peers.map((peer) => peer.id)).toEqual([
      syncB.peerId,
    ]);
    expect(syncB.presence().peers.map((peer) => peer.id)).toEqual([
      syncA.peerId,
    ]);

    await syncA.stop();
    await syncB.stop();
  });

  test("presence: a peer keeping another database is not company", async () => {
    // Same air, same courier, different conversation. Hearing it proves a
    // radio is in range, which is exactly the answer this API refuses to give.
    const mine = track(
      await alice.orbitdb.open("courier-presence-mine", { type: "keyvalue" }),
    );
    const theirs = track(
      await bob.orbitdb.open("courier-presence-theirs", { type: "keyvalue" }),
    );
    await theirs.put("theirs", { text: "not your conversation" });

    const pair = createMemoryCourierPair();
    const syncA = await createCourierSync({ db: mine, courier: pair.a });
    const syncB = await createCourierSync({ db: theirs, courier: pair.b });
    await syncA.start();
    await syncB.start();

    await syncA.hello();
    await theirs.put("more", { text: "chatter on the same air" });
    await converge(pair, [syncA, syncB]);

    expect(syncA.presence()).toEqual({ peers: [], lastHeardAgoMs: null });

    await syncA.stop();
    await syncB.stop();
  });

  test("presence: a mesh repeating our own message is not company", async () => {
    // A LoRa mesh rebroadcasts what it carries, so a node hears itself. That
    // must never read as "somebody is out there", or an app alone in a valley
    // would be told it has company.
    const db = track(
      await alice.orbitdb.open("courier-presence-echo", { type: "keyvalue" }),
    );
    const listeners = new Set();
    const repeater = {
      send: async (bytes) => {
        for (const cb of listeners) cb(bytes);
      },
      onPayload: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    };
    const sync = await createCourierSync({ db, courier: repeater });
    await sync.start();
    await sync.hello();
    await sync.idle();

    expect(sync.presence()).toEqual({ peers: [], lastHeardAgoMs: null });

    await sync.stop();
  });

  test("presence: a peer that has gone quiet stops counting", async () => {
    const db = track(
      await alice.orbitdb.open("courier-presence-timeout", {
        type: "keyvalue",
      }),
    );
    const pair = createMemoryCourierPair();
    // The window has to be wider than the time between Bob's last message and
    // the assertion below, and that time is not ours to control: convergence
    // does real OrbitDB work, and a loaded runner stretches it. At 1 ms — which
    // is what this test used to pass — the peer had already expired before it
    // could be counted, and the assertion failed with 0 where 1 was expected on
    // a scheduled run of main. A second attempt went green, which is exactly
    // what makes it worth fixing rather than re-running.
    const window = 1000;
    const syncA = await createCourierSync({
      db,
      courier: pair.a,
      peerTimeoutMs: window,
    });
    const syncB = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: db.address,
      courier: pair.b,
    });
    await syncA.start();
    await syncB.start();
    await converge(pair, [syncA, syncB]);
    expect(syncA.presence().peers.length).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, window + 100));
    const later = syncA.presence();
    expect(later.peers).toEqual([]);
    // Still true, and still useful: the air did carry something once.
    expect(later.lastHeardAgoMs).not.toBeNull();

    // And a carrier that changed underneath — another channel, another room —
    // makes even that meaningless.
    syncA.forgetPeers();
    expect(syncA.presence()).toEqual({ peers: [], lastHeardAgoMs: null });

    await syncA.stop();
    await syncB.stop();
  });

  test("presence costs seven bytes a message, and the question itself one frame", async () => {
    // The price, counted rather than asserted to be small: the sender id is
    // seven bytes of dag-cbor on every message, and asking outright is two
    // messages that each fit in a single 200-byte LoRa frame with room over.
    const db = track(
      await alice.orbitdb.open("courier-presence-cost", { type: "keyvalue" }),
    );
    const tag = await databaseTag(db.address);
    const withId = dagCbor.encode({
      v: 1,
      tag,
      p: new Uint8Array(4),
      t: "announce",
      heads: [],
    });
    const withoutId = dagCbor.encode({ v: 1, tag, t: "announce", heads: [] });
    expect(withId.length - withoutId.length).toBe(7);

    const sizes = [];
    const courier = { send: async () => {}, onPayload: () => () => {} };
    const sync = await createCourierSync({ db, courier });
    sync.on("message", (event) => sizes.push(event));
    await sync.hello();
    const hello = sizes.find((event) => event.type === "hello");
    expect(hello.bytes).toBeLessThan(40);
  });

  /**
   * funkpost#83, from two radios on a public channel: a joiner asked fourteen
   * times and got one answer. The creator's first reply was still in flight,
   * and `courier.send` resolves on *delivery* — so every later message sat
   * behind it on the same chain and was never even looked at.
   */
  test("a send that never settles does not stop the sync from listening", async () => {
    const db = track(
      await alice.orbitdb.open("courier-head-of-line", { type: "keyvalue" }),
    );
    await db.put("one", { text: "Buy groceries" });

    const pair = createMemoryCourierPair();
    let holding = false;
    const held = [];
    const release = () => held.splice(0).forEach((resolve) => resolve());
    // A courier that takes a message and then says nothing — neither delivered
    // nor failed, which is exactly what the hardware log showed.
    const stuck = {
      send: async (bytes) => {
        if (holding) await new Promise((resolve) => held.push(resolve));
        return pair.a.send(bytes);
      },
      onPayload: (cb) => pair.a.onPayload(cb),
    };

    const syncA = await createCourierSync({ db, courier: stuck });
    const syncB = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: db.address,
      courier: pair.b,
    });
    const heard = [];
    const sentBlocks = [];
    syncA.on("message", (event) => {
      if (event.direction === "in") heard.push(event.type);
      if (event.direction === "out" && event.type === "blocks")
        sentBlocks.push(event);
    });

    await syncA.start(); // the announce gets out; everything after it hangs
    holding = true;
    await syncB.start();

    // The joiner keeps asking, the way its rejoin timer does on the air.
    for (let round = 0; round < 4; round += 1) {
      await syncB.announce();
      await pair.idle();
      await syncB.idle();
    }
    // Not `syncA.idle()`: the creator's outbox is stuck on purpose, and that
    // is the whole point — so wait for the evidence instead of for quiet.
    const until = async (check, ms = 5000) => {
      const deadline = Date.now() + ms;
      while (!check() && Date.now() < deadline) await nextTurn();
    };
    await until(() => heard.length >= 4 && sentBlocks.length >= 1);

    // The point: every one of those was heard and handled while the first
    // reply was still stuck. Before the outbox, this was exactly 1.
    expect(heard.length).toBeGreaterThanOrEqual(4);
    expect(syncB.db).toBeNull(); // nothing could reach it, which is honest

    // And one reply is in flight, not five: the asks that arrived while it was
    // stuck superseded each other, so the radio does not pay for four copies
    // of the same answer.
    expect(sentBlocks.length).toBe(1);

    release();
    holding = false;
    await converge(pair, [syncA, syncB]);

    // The one that was in flight and could not be taken back, plus the single
    // one that was waiting behind it — and whatever the bootstrap still needs
    // after that, which is the protocol doing its ordinary repair.
    expect(sentBlocks.length).toBeGreaterThanOrEqual(2);
    expect(track(syncB.db)).toBeTruthy();
    expect(await syncB.db.get("one")).toEqual({ text: "Buy groceries" });

    await syncA.stop();
    await syncB.stop();
  });

  test("a courier that never answers at all is given up on, and the next message still goes", async () => {
    const db = track(
      await alice.orbitdb.open("courier-send-timeout", { type: "keyvalue" }),
    );

    let answering = false;
    const sent = [];
    const mute = {
      send: async (bytes) => {
        sent.push(bytes);
        if (!answering) await new Promise(() => {}); // never settles, ever
      },
      onPayload: () => () => {},
    };

    const sync = await createCourierSync({
      db,
      courier: mute,
      sendTimeoutMs: 50,
    });

    // start() announces, and says so rather than hanging for good.
    await expect(sync.start()).rejects.toThrow(/neither delivered nor failed/);

    // The outbox is not wedged: the carrier comes back, the next message goes.
    answering = true;
    await sync.announce();
    expect(sent.length).toBe(2);

    await sync.stop();
  });
});
