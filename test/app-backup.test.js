/**
 * @fileoverview An application's backup in one sealed file, and back (#147).
 *
 * Real OrbitDB and Helia, offline, as restore-from-blocks.test.js runs them:
 * three databases and a block of the application's own go into one file with a
 * header that is read without a key; the file opens only with the right key,
 * only for the right application and only with the header it was made with;
 * and it puts the books back into a node that never saw them — merging, never
 * replacing, and never into books it does not belong to.
 */

import { jest, describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { IPFSAccessController } from "@orbitdb/core";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import {
  APP_BACKUP_MAGIC,
  buildAppBackup,
  isAppBackup,
  openAppBackup,
  readAppBackupHeader,
  restoreAppBackup,
} from "../lib/app-backup.js";
import { createHeliaOrbitDB, cleanupOrbitDBDirectories } from "../lib/utils.js";

jest.setTimeout(180000);

const OFFLINE = { useBootstrap: false, useDHT: false, autoDial: false };
const open = { AccessController: IPFSAccessController({ write: ["*"] }) };

/** AES-GCM with a key of its own, shaped like the package's encrypt/decrypt contract. */
async function aesGcm() {
  const key = await globalThis.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return {
    encrypt: async (plaintext) => {
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
      return { ciphertext, iv };
    },
    decrypt: async (ciphertext, iv) =>
      new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext)),
  };
}

const text = (s) => new TextEncoder().encode(s);
const contains = (haystack, needle) => Buffer.from(haystack).includes(Buffer.from(needle));

let alice;
let bob;
let carol;
let dbs;
let key;
let other;
let file;
let fileCid;
const HEADER = text(JSON.stringify({ vault: "one sealed slot per passkey would be here" }));

beforeAll(async () => {
  alice = await createHeliaOrbitDB("-appbackup-alice", OFFLINE);
  bob = await createHeliaOrbitDB("-appbackup-bob", OFFLINE);
  carol = await createHeliaOrbitDB("-appbackup-carol", OFFLINE);

  const invoices = await alice.orbitdb.open("appbackup-invoices", { type: "documents", ...open });
  await invoices.put({ _id: "2026-00001-001", customer: "Erster Kunde AG" });
  const settings = await alice.orbitdb.open("appbackup-settings", { type: "keyvalue", ...open });
  await settings.put("issuer", "Wolkenfabrik Hosting UG");
  const events = await alice.orbitdb.open("appbackup-events", { type: "events", ...open });
  await events.add("issued 2026-00001-001");
  dbs = { invoices, settings, events };

  // A block of the application's own, as belege's receipt files are.
  file = text("a receipt file, sealed by the application");
  fileCid = CID.createV1(raw.code, await sha256.digest(file));

  key = await aesGcm();
  other = await aesGcm();
});

afterAll(async () => {
  for (const db of Object.values(dbs ?? {})) await db?.close?.();
  for (const side of [alice, bob, carol]) {
    await side?.orbitdb?.stop?.();
    await side?.helia?.stop?.();
  }
  await cleanupOrbitDBDirectories();
});

async function build(overrides = {}) {
  return buildAppBackup({
    app: "invoice",
    databases: dbs,
    encrypt: key.encrypt,
    blocks: new Map([[fileCid.toString(), { cid: fileCid, bytes: file }]]),
    header: HEADER,
    appVersion: "1.2.3",
    extra: { files: [fileCid.toString()] },
    now: () => new Date("2026-10-03T12:00:00Z"),
    ...overrides,
  });
}

describe("the file", () => {
  test("starts with OSBA, carries its header in the clear and nothing else", async () => {
    const progress = [];
    const { bytes, manifest, blocks } = await build({ onProgress: (p) => progress.push(p) });

    expect(isAppBackup(bytes)).toBe(true);
    expect([...bytes.subarray(0, 4)]).toEqual([...APP_BACKUP_MAGIC]);
    const { header, version } = readAppBackupHeader(bytes);
    expect(version).toBe(1);
    expect(new TextDecoder().decode(header)).toBe(new TextDecoder().decode(HEADER));

    // The books are sealed: nothing of them is readable in the file.
    for (const marker of ["Erster Kunde AG", "Wolkenfabrik", "issued 2026", "a receipt file"]) {
      expect(contains(bytes, text(marker))).toBe(false);
    }
    expect(manifest).toMatchObject({ kind: "app-backup", v: 1, app: "invoice", appVersion: "1.2.3" });
    expect(manifest.createdAt).toBe("2026-10-03T12:00:00.000Z");
    expect(manifest.header).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.metadata.databases.map((d) => d.collection)).toEqual(["invoices", "settings", "events"]);
    expect(blocks).toBeGreaterThan(3);
    expect(progress.map((p) => p.stage)).toEqual(["database", "database", "database", "sealing"]);
    expect(progress.slice(0, 3).map((p) => p.name)).toEqual(["invoices", "settings", "events"]);
  });

  test("opens with the right key: verified blocks, the manifest, the application's own block", async () => {
    const { bytes } = await build();
    const opened = await openAppBackup(bytes, { decrypt: key.decrypt, app: "invoice" });
    expect(opened.manifest.extra).toEqual({ files: [fileCid.toString()] });
    expect(opened.blocks.get(fileCid.toString()).bytes).toEqual(file);
    // OrbitDB writes manifest CIDs in base58 (zdpu…), the CAR reader keys in
    // base32 (bafy…): the same CIDs, compared as CIDs.
    const has = (cid) => [...opened.blocks.keys()].some((name) => CID.parse(name).equals(CID.parse(cid)));
    for (const d of opened.manifest.metadata.databases) expect(has(d.manifestCID)).toBe(true);
  });

  test("does not open with another key, for another application, or with another header", async () => {
    const { bytes } = await build();
    // AES-GCM refuses the wrong key itself; its error comes through for the caller to name.
    await expect(openAppBackup(bytes, { decrypt: other.decrypt })).rejects.toThrow();
    await expect(openAppBackup(bytes, { decrypt: key.decrypt, app: "belege" })).rejects.toThrow(
      /backup of invoice, not of belege/,
    );

    // Same length, one byte changed: the header is outside the seal, the manifest inside names it.
    const swapped = bytes.slice();
    swapped[9] ^= 0xff;
    await expect(openAppBackup(swapped, { decrypt: key.decrypt })).rejects.toThrow(/header is not the one/);
  });

  test("a file without a header opens, and one given a header afterwards does not", async () => {
    const { bytes, manifest } = await build({ header: undefined });
    expect(manifest).not.toHaveProperty("header");
    expect(readAppBackupHeader(bytes).header).toHaveLength(0);
    await expect(openAppBackup(bytes, { decrypt: key.decrypt })).resolves.toMatchObject({ manifest: { app: "invoice" } });

    // Splice a header in front of the same envelope.
    const { body } = readAppBackupHeader(bytes);
    const forged = new Uint8Array(9 + 3 + body.length);
    forged.set(APP_BACKUP_MAGIC, 0);
    forged[4] = 1;
    new DataView(forged.buffer).setUint32(5, 3);
    forged.set([1, 2, 3], 9);
    forged.set(body, 12);
    await expect(openAppBackup(forged, { decrypt: key.decrypt })).rejects.toThrow(/header is not the one/);
  });

  test("refuses what is not one, what is cut short, and a format this build does not read", async () => {
    const { bytes } = await build();
    expect(() => readAppBackupHeader(text("belegeB1 and so on"))).toThrow(/not an application backup/);
    expect(() => readAppBackupHeader(bytes.subarray(0, 12))).toThrow(/cut short/);
    const future = bytes.slice();
    future[4] = 2;
    expect(() => readAppBackupHeader(future)).toThrow(/format 2, and this build reads 1/);
    await expect(buildAppBackup({ databases: dbs, encrypt: key.encrypt })).rejects.toThrow(/`app`/);
    await expect(buildAppBackup({ app: "invoice", databases: dbs })).rejects.toThrow(/holds no keys/);
  });
});

describe("restoring", () => {
  test("puts the books back into a node that never saw them, the application's own block with them", async () => {
    const { bytes } = await build();
    const opened = await openAppBackup(bytes, { decrypt: key.decrypt, app: "invoice" });
    const addresses = Object.fromEntries(Object.entries(dbs).map(([name, db]) => [name, db.address]));

    const progress = [];
    const restored = await restoreAppBackup({
      orbitdb: bob.orbitdb,
      opened,
      addresses,
      open,
      onProgress: (p) => progress.push(p),
    });
    expect(restored.databases.map((d) => d.collection)).toEqual(["invoices", "settings", "events"]);
    expect(restored.databases.every((d) => d.joined > 0)).toBe(true);
    expect(progress.map((p) => p.name)).toEqual(["invoices", "settings", "events"]);

    const invoices = await bob.orbitdb.open(addresses.invoices, { type: "documents", ...open });
    expect((await invoices.all()).map((e) => e.value)).toEqual([{ _id: "2026-00001-001", customer: "Erster Kunde AG" }]);
    const settings = await bob.orbitdb.open(addresses.settings, { type: "keyvalue", ...open });
    expect(await settings.get("issuer")).toBe("Wolkenfabrik Hosting UG");
    expect(await bob.helia.blockstore.has(fileCid)).toBe(true);
    expect(bob.libp2p.getConnections()).toHaveLength(0);
  });

  test("merges: what is here stays, what the backup holds is added", async () => {
    const addresses = Object.fromEntries(Object.entries(dbs).map(([name, db]) => [name, db.address]));
    const opened = await openAppBackup((await build()).bytes, { decrypt: key.decrypt });

    // Carol has the same books, with an invoice the backup does not know. Opened
    // by name with the same options, it is the same address — offline, a node
    // cannot open an address whose manifest it has never seen.
    const invoices = await carol.orbitdb.open("appbackup-invoices", { type: "documents", ...open });
    expect(invoices.address).toBe(addresses.invoices);
    await invoices.put({ _id: "2026-00002-001", customer: "Zweiter Kunde GmbH" });
    await invoices.close();

    await restoreAppBackup({ orbitdb: carol.orbitdb, opened, addresses, open });
    const after = await carol.orbitdb.open(addresses.invoices, { type: "documents", ...open });
    expect((await after.all()).map((e) => e.value._id).sort()).toEqual(["2026-00001-001", "2026-00002-001"]);
  });

  test("never into books the backup does not belong to", async () => {
    const opened = await openAppBackup((await build()).bytes, { decrypt: key.decrypt });
    await expect(
      restoreAppBackup({
        orbitdb: bob.orbitdb,
        opened,
        addresses: { invoices: dbs.invoices.address, settings: dbs.settings.address },
        open,
      }),
    ).rejects.toThrow(/databases these books do not have/);
  });
});
