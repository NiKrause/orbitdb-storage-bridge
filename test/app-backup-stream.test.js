/**
 * @fileoverview An application's backup sealed in frames, restored as it
 * arrives (#187).
 *
 * Real OrbitDB and Helia, offline, as app-backup.test.js runs them. The file
 * is fed in small pieces, as a gateway sends it; what is asserted is the
 * order of things a restore on a phone depends on: the header without a key
 * from the first bytes, a wrong key before any block is stored, a backup of
 * other books before any block is stored, and no database touched by a file
 * that does not reach its end. And the backup of before, sealed in one
 * piece, restores as it did.
 */

import { jest, describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { IPFSAccessController } from "@orbitdb/core";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import {
  buildAppBackup,
  openAppBackup,
  readAppBackupHeader,
  readAppBackupHeaderStream,
  restoreAppBackup,
  restoreAppBackupStream,
} from "../lib/app-backup.js";
import { FrameError, isFramed } from "../lib/backends/frames.js";
import { isEncrypted, readEnvelope } from "../lib/backends/encryption.js";
import {
  openCARStream,
  readBlocksFromCAR,
  restoreFromStoredBlocks,
  storeBlocks,
  storeBlocksFromCAR,
} from "../lib/restore-cid.js";
import { createCARFromBlocks } from "../lib/backup-car.js";
import { createHeliaOrbitDB, cleanupOrbitDBDirectories } from "../lib/utils.js";

jest.setTimeout(180000);

const OFFLINE = { useBootstrap: false, useDHT: false, autoDial: false };
const open = { AccessController: IPFSAccessController({ write: ["*"] }) };
const text = (s) => new TextEncoder().encode(s);
const HEADER = text(JSON.stringify({ vault: "one sealed slot per passkey would be here" }));
const FRAME = 512;

const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
const otherKey = globalThis.crypto.getRandomValues(new Uint8Array(32));

/** AES-GCM in the shape of the envelope in one piece: the backups of before. */
async function aesGcm() {
  const k = await globalThis.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return {
    encrypt: async (plaintext) => {
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, plaintext));
      return { ciphertext, iv };
    },
    decrypt: async (ciphertext, iv) =>
      new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv }, k, ciphertext)),
  };
}

/** The file as a gateway sends it: in pieces, never whole. */
async function* pieces(bytes, size = 300) {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, Math.min(bytes.length, at + size));
}

/** A blockstore that counts what it is given, in front of a real one. */
function counting(blockstore) {
  const puts = [];
  return {
    puts,
    blockstore: new Proxy(blockstore, {
      get: (target, name) =>
        name === "put"
          ? async (cid, bytes, ...rest) => {
              puts.push(cid.toString());
              return target.put(cid, bytes, ...rest);
            }
          : typeof target[name] === "function"
            ? target[name].bind(target)
            : target[name],
    }),
  };
}

/** An OrbitDB whose blockstore is watched, and whose `open` is counted. */
function watched(side) {
  const { puts, blockstore } = counting(side.helia.blockstore);
  const opens = [];
  const orbitdb = new Proxy(side.orbitdb, {
    get: (target, name) => {
      if (name === "ipfs") return new Proxy(target.ipfs, { get: (t, n) => (n === "blockstore" ? blockstore : t[n]) });
      if (name === "open")
        return (address, ...rest) => {
          opens.push(String(address));
          return target.open(address, ...rest);
        };
      return typeof target[name] === "function" ? target[name].bind(target) : target[name];
    },
  });
  return { orbitdb, puts, opens };
}

let alice;
const sides = [];
let dbs;
let addresses;
let file;
let fileCid;
let legacy;

const fresh = async (name) => {
  const side = await createHeliaOrbitDB(`-appstream-${name}`, OFFLINE);
  sides.push(side);
  return side;
};

beforeAll(async () => {
  alice = await fresh("alice");
  const invoices = await alice.orbitdb.open("appstream-invoices", { type: "documents", ...open });
  for (let i = 1; i <= 12; i++) await invoices.put({ _id: `2026-000${String(i).padStart(2, "0")}`, customer: `Kunde ${i} AG` });
  const settings = await alice.orbitdb.open("appstream-settings", { type: "keyvalue", ...open });
  await settings.put("issuer", "Wolkenfabrik Hosting UG");
  dbs = { invoices, settings };
  addresses = Object.fromEntries(Object.entries(dbs).map(([name, db]) => [name, db.address]));

  // A block of the application's own, larger than a frame: it spans several.
  file = new Uint8Array(5000);
  globalThis.crypto.getRandomValues(file);
  fileCid = CID.createV1(raw.code, await sha256.digest(file));
  legacy = await aesGcm();
});

afterAll(async () => {
  for (const db of Object.values(dbs ?? {})) await db?.close?.();
  for (const side of sides) {
    await side?.orbitdb?.stop?.();
    await side?.helia?.stop?.();
  }
  await cleanupOrbitDBDirectories();
});

const build = (overrides = {}) =>
  buildAppBackup({
    app: "invoice",
    databases: dbs,
    key,
    frameSize: FRAME,
    blocks: new Map([[fileCid.toString(), { cid: fileCid, bytes: file }]]),
    header: HEADER,
    appVersion: "1.2.3",
    now: () => new Date("2026-10-03T12:00:00Z"),
    ...overrides,
  });

describe("the file, sealed in frames", () => {
  test("is the same file around another envelope: OSBA, the header in the clear, then OSBE version 2", async () => {
    const { bytes, manifest, carBytes } = await build();
    const { version, header, body } = readAppBackupHeader(bytes);
    expect(version).toBe(1);
    expect(new TextDecoder().decode(header)).toBe(new TextDecoder().decode(HEADER));
    expect(isEncrypted(body)).toBe(true);
    expect(isFramed(body)).toBe(true);
    expect(manifest.header).toMatch(/^[0-9a-f]{64}$/);
    // Several frames, or nothing below is about frames.
    expect(carBytes).toBeGreaterThan(10 * FRAME);
    for (const marker of ["Kunde 1 AG", "Wolkenfabrik"]) {
      expect(Buffer.from(bytes).includes(Buffer.from(marker))).toBe(false);
    }
    // A build from before reads the version and says what to do, not noise.
    expect(() => readEnvelope(body)).toThrow(/sealed in frames/);
  });

  test("carries its manifest first, so a reader knows whose it is before the rest", async () => {
    const { bytes } = await build();
    const opened = await openAppBackup(bytes, { key, app: "invoice" });
    const [first] = opened.blocks.keys();
    expect(opened.manifest).toMatchObject({ kind: "app-backup", app: "invoice" });
    expect(CID.parse(first).code).toBe(0x71);
    expect(opened.blocks.get(fileCid.toString()).bytes).toEqual(file);
  });

  test("opens whole with its key, and not with another, without one, or with another header", async () => {
    const { bytes } = await build();
    await expect(openAppBackup(bytes, { key: otherKey })).rejects.toMatchObject({ reason: "wrong-key" });
    await expect(openAppBackup(bytes, { decrypt: legacy.decrypt })).rejects.toThrow(/sealed in frames/);
    // The header is in the frames' key: changed, the file does not open at all.
    const swapped = bytes.slice();
    swapped[9] ^= 0xff;
    await expect(openAppBackup(swapped, { key })).rejects.toMatchObject({ reason: "wrong-key" });
  });

  test("takes a key or the caller's encrypt, not both", async () => {
    await expect(build({ encrypt: legacy.encrypt })).rejects.toThrow(/not both/);
  });
});

describe("the header from the first bytes", () => {
  test("is read without a key before the body is asked for", async () => {
    const { bytes } = await build();
    let pulled = 0;
    const source = (async function* () {
      for await (const piece of pieces(bytes, 16)) {
        pulled++;
        yield piece;
      }
    })();
    const { version, header, body } = await readAppBackupHeaderStream(source);
    expect(version).toBe(1);
    expect(new TextDecoder().decode(header)).toBe(new TextDecoder().decode(HEADER));
    // The preamble and the header, and not a piece more.
    expect(pulled).toBe(Math.ceil((9 + HEADER.length) / 16));
    const rest = [];
    for await (const chunk of body) rest.push(...chunk);
    expect(rest).toEqual([...readAppBackupHeader(bytes).body]);
  });

  test("refuses what is not one, and what ends inside its header", async () => {
    await expect(readAppBackupHeaderStream(pieces(text("belegeB1 and so on")))).rejects.toThrow(/not an application backup/);
    const { bytes } = await build();
    await expect(readAppBackupHeaderStream(pieces(bytes.subarray(0, 20)))).rejects.toThrow(/cut short/);
    const huge = bytes.slice(0, 9);
    new DataView(huge.buffer).setUint32(5, 0xffffffff);
    await expect(readAppBackupHeaderStream(pieces(huge))).rejects.toThrow(/at most/);
  });
});

describe("restoring as it arrives", () => {
  test("puts the books back into a node that never saw them, block by block", async () => {
    const { bytes, blocks } = await build();
    const bob = await fresh("bob");
    const { orbitdb, puts } = watched(bob);
    const progress = [];
    const seenHeader = [];
    const restored = await restoreAppBackupStream({
      orbitdb,
      source: pieces(bytes),
      key,
      app: "invoice",
      addresses,
      open,
      onHeader: (header) => void seenHeader.push(new TextDecoder().decode(header)),
      onProgress: (p) => progress.push(p),
    });
    expect(restored.streamed).toBe(true);
    expect(restored.blocks).toBe(blocks);
    expect(puts.length).toBe(blocks);
    expect(restored.manifest.app).toBe("invoice");
    expect(restored.databases.map((d) => d.collection)).toEqual(["invoices", "settings"]);
    expect(restored.databases.every((d) => d.joined > 0)).toBe(true);
    expect(seenHeader).toEqual([new TextDecoder().decode(HEADER)]);

    // Frames opened, blocks stored, databases joined: one callback, in that order.
    const stages = progress.map((p) => p.stage);
    expect(new Set(stages)).toEqual(new Set(["opened", "stored", "database"]));
    expect(stages.lastIndexOf("opened")).toBeLessThan(stages.indexOf("database"));
    expect(stages.lastIndexOf("stored")).toBeLessThan(stages.indexOf("database"));
    // Blocks went into the blockstore while frames were still arriving.
    expect(stages.indexOf("stored")).toBeLessThan(stages.lastIndexOf("opened"));
    expect(progress.filter((p) => p.stage === "stored").at(-1).blocks).toBe(blocks);

    const invoices = await bob.orbitdb.open(addresses.invoices, { type: "documents", ...open });
    expect((await invoices.all()).length).toBe(12);
    const settings = await bob.orbitdb.open(addresses.settings, { type: "keyvalue", ...open });
    expect(await settings.get("issuer")).toBe("Wolkenfabrik Hosting UG");
    expect(await bob.helia.blockstore.has(fileCid)).toBe(true);
    expect(bob.libp2p.getConnections()).toHaveLength(0);
  });

  test("the key may come from the header: a keyring is read first", async () => {
    const { bytes } = await build();
    const carol = await fresh("carol");
    const restored = await restoreAppBackupStream({
      orbitdb: carol.orbitdb,
      source: pieces(bytes),
      addresses,
      open,
      onHeader: (header) => (JSON.parse(new TextDecoder().decode(header)).vault ? { key } : undefined),
    });
    expect(restored.databases.every((d) => d.joined > 0)).toBe(true);
  });

  test("a wrong key is known before a single block is stored or a database opened", async () => {
    const { bytes } = await build();
    const dave = await fresh("dave");
    const { orbitdb, puts, opens } = watched(dave);
    const error = await restoreAppBackupStream({ orbitdb, source: pieces(bytes), key: otherKey, addresses, open }).catch((e) => e);
    expect(error).toBeInstanceOf(FrameError);
    expect(error.reason).toBe("wrong-key");
    expect(puts).toEqual([]);
    expect(opens).toEqual([]);
  });

  test("a backup of other books, or of another application, is refused at its manifest: nothing stored", async () => {
    const { bytes } = await build();
    const dave = await fresh("erin");
    const { orbitdb, puts, opens } = watched(dave);
    await expect(
      restoreAppBackupStream({ orbitdb, source: pieces(bytes), key, addresses: { invoices: addresses.invoices }, open }),
    ).rejects.toThrow(/databases these books do not have/);
    await expect(
      restoreAppBackupStream({ orbitdb, source: pieces(bytes), key, app: "belege", addresses, open }),
    ).rejects.toThrow(/backup of invoice, not of belege/);
    expect(puts).toEqual([]);
    expect(opens).toEqual([]);
  });

  test.each([
    ["cut short", (bytes) => bytes.subarray(0, bytes.length - 700)],
    [
      "damaged near its end",
      (bytes) => {
        const damaged = bytes.slice();
        damaged[damaged.length - 600] ^= 1;
        return damaged;
      },
    ],
    [
      "without one of its frames",
      (bytes) => {
        const at = 9 + HEADER.length + 57 + 6 * (FRAME + 16);
        const out = new Uint8Array(bytes.length - (FRAME + 16));
        out.set(bytes.subarray(0, at), 0);
        out.set(bytes.subarray(at + FRAME + 16), at);
        return out;
      },
    ],
  ])("a file %s names the frame, and no database is opened", async (_, damage) => {
    const { bytes } = await build();
    const side = await fresh(`frank-${_.replace(/\W+/g, "-")}`);
    const { orbitdb, puts, opens } = watched(side);
    const error = await restoreAppBackupStream({ orbitdb, source: pieces(damage(bytes)), key, addresses, open }).catch((e) => e);
    expect(error).toBeInstanceOf(FrameError);
    expect(error.reason).toBe("frame");
    expect(Number.isInteger(error.frame)).toBe(true);
    expect(error.message).toContain(`Frame ${error.frame} `);
    // What opened before the damage is in the blockstore, sealed blocks nothing
    // points at; the books were never touched.
    expect(puts.length).toBeGreaterThan(0);
    expect(opens).toEqual([]);
  });

  test("a blockstore that is full ends it at the block it refused", async () => {
    const { bytes } = await build();
    const side = await fresh("grace");
    let taken = 0;
    const orbitdb = new Proxy(side.orbitdb, {
      get: (target, name) =>
        name === "ipfs"
          ? {
              blockstore: {
                put: async () => {
                  if (++taken > 3) throw new Error("QuotaExceededError");
                },
              },
            }
          : target[name],
    });
    const error = await restoreAppBackupStream({ orbitdb, source: pieces(bytes), key, addresses, open }).catch((e) => e);
    expect(error.name).toBe("BlocksNotStoredError");
    expect(error.stored).toBe(3);
    expect(error.message).toMatch(/QuotaExceededError/);
  });
});

describe("the backup of before, sealed in one piece", () => {
  test("still opens and restores as it did", async () => {
    const { bytes } = await build({ key: undefined, frameSize: undefined, encrypt: legacy.encrypt });
    expect(isFramed(readAppBackupHeader(bytes).body)).toBe(false);
    const opened = await openAppBackup(bytes, { decrypt: legacy.decrypt, app: "invoice" });
    const heidi = await fresh("heidi");
    const restored = await restoreAppBackup({ orbitdb: heidi.orbitdb, opened, addresses, open });
    expect(restored.databases.every((d) => d.joined > 0)).toBe(true);
  });

  test("and through the streamed restore too, held whole because it cannot be opened otherwise", async () => {
    const { bytes } = await build({ key: undefined, frameSize: undefined, encrypt: legacy.encrypt });
    const ivan = await fresh("ivan");
    const progress = [];
    const restored = await restoreAppBackupStream({
      orbitdb: ivan.orbitdb,
      source: pieces(bytes),
      key,
      decrypt: legacy.decrypt,
      app: "invoice",
      addresses,
      open,
      onProgress: (p) => progress.push(p.stage),
    });
    expect(restored.streamed).toBe(false);
    expect(restored.databases.map((d) => d.collection)).toEqual(["invoices", "settings"]);
    expect(new Set(progress)).toEqual(new Set(["database"]));
    const invoices = await ivan.orbitdb.open(addresses.invoices, { type: "documents", ...open });
    expect((await invoices.all()).length).toBe(12);

    await expect(
      restoreAppBackupStream({ orbitdb: ivan.orbitdb, source: pieces(bytes), key, addresses, open }),
    ).rejects.toThrow(/sealed in one piece/);
  });
});

describe("a CAR as it arrives", () => {
  test("its roots first, then each block, checked against its own CID", async () => {
    const { bytes } = await build();
    const opened = await openAppBackup(bytes, { key });
    const [root] = opened.blocks.keys();
    const car = await createCARFromBlocks(opened.blocks, root);
    const stream = await openCARStream(pieces(car, 100));
    expect(stream.roots.map(String)).toEqual([root]);
    const names = [];
    for await (const block of stream.blocks()) names.push(block.cid.toString());
    expect(names).toEqual([...(await readBlocksFromCAR(car)).keys()]);

    // A block whose bytes are not its CID's: the reader of a stream refuses it too.
    const forged = car.slice();
    forged[forged.length - 10] ^= 1;
    const refused = await openCARStream(pieces(forged, 100));
    await expect(
      (async () => {
        for await (const block of refused.blocks()) void block;
      })(),
    ).rejects.toThrow(/does not hash to its own CID/);
  });

  test("stored block by block, then joined from the blockstore: several CARs into one", async () => {
    const { bytes } = await build();
    const opened = await openAppBackup(bytes, { key });
    const [root] = opened.blocks.keys();
    // The same blocks as two CARs, as a base and an increment are two files.
    const all = [...opened.blocks];
    const half = Math.ceil(all.length / 2);
    const one = await createCARFromBlocks(new Map(all.slice(0, half)), root);
    const two = await createCARFromBlocks(new Map(all.slice(half)), all[half][0]);

    const judy = await fresh("judy");
    const seen = [];
    const stored = await storeBlocksFromCAR(judy.helia.blockstore, pieces(one), {
      onBlock: (block, { roots, index }) => void seen.push([index, roots.some((r) => r.equals(block.cid))]),
    });
    expect(seen[0]).toEqual([0, true]);
    expect(stored.blocks).toBe(half);
    const progress = [];
    await storeBlocksFromCAR(judy.helia.blockstore, pieces(two), { into: stored, onProgress: (p) => progress.push(p.blocks) });
    expect(stored.blocks).toBe(all.length);
    expect(stored.names.size).toBe(all.length);
    expect(progress.at(-1)).toBe(all.length);
    expect(stored.roots.length).toBe(2);
    // These databases are not encrypted: their entries say whose they are.
    expect(stored.entries.get(addresses.invoices).length).toBe(12);

    const restored = await restoreFromStoredBlocks(judy.orbitdb, stored, opened.manifest.metadata, { open, requireHeads: true });
    expect(restored.blocks).toBe(all.length);
    expect(restored.missingHeads).toEqual([]);
    expect(restored.databases.every((d) => d.joined > 0)).toBe(true);
    const invoices = await judy.orbitdb.open(addresses.invoices, { type: "documents", ...open });
    expect((await invoices.all()).length).toBe(12);
  });

  test("blocks opened whole go into the same result as a streamed CAR", async () => {
    const { bytes } = await build();
    const opened = await openAppBackup(bytes, { key });
    const all = [...opened.blocks];
    const half = Math.ceil(all.length / 2);
    const liam = await fresh("liam");
    const stored = await storeBlocksFromCAR(
      liam.helia.blockstore,
      await createCARFromBlocks(new Map(all.slice(0, half)), all[0][0]),
    );
    await storeBlocks(
      liam.helia.blockstore,
      all.slice(half).map(([name, block]) => ({ cid: CID.parse(name), bytes: block.bytes })),
      { into: stored },
    );
    expect(stored.names.size).toBe(all.length);
    const restored = await restoreFromStoredBlocks(liam.orbitdb, stored, opened.manifest.metadata, { open, requireHeads: true });
    expect(restored.databases.every((d) => d.joined > 0)).toBe(true);
  });

  test("metadata that names a manifest the CAR lacks, or no heads, is refused before anything is opened", async () => {
    const { bytes } = await build();
    const opened = await openAppBackup(bytes, { key });
    const all = [...opened.blocks];
    const manifestOf = CID.parse(opened.manifest.metadata.databases[0].manifestCID);
    const without = new Map(all.filter(([name]) => !CID.parse(name).equals(manifestOf)));
    const kate = await fresh("kate");
    const stored = await storeBlocksFromCAR(kate.helia.blockstore, await createCARFromBlocks(without, all[0][0]));
    await expect(restoreFromStoredBlocks(kate.orbitdb, stored, opened.manifest.metadata, { open })).rejects.toThrow(
      /does not contain the manifest/,
    );
    const headless = {
      ...opened.manifest.metadata,
      databases: opened.manifest.metadata.databases.map(({ heads, ...d }) => (void heads, d)),
    };
    await expect(restoreFromStoredBlocks(kate.orbitdb, stored, headless, { open })).rejects.toThrow(/states each database's heads/);
  });
});
