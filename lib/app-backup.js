/**
 * @fileoverview An application's backup in one sealed file (#147).
 *
 * Two applications, Le-Space/belege and Le-Space/invoice, back up the same way:
 * every OrbitDB database they keep, and blocks of their own (belege's receipt
 * files), go into one CAR whose root is a manifest; the CAR is sealed with the
 * application's key; one upload, one STORE. This module is that file,
 * generalised from belege's `archive.js` (Le-Space/belege#77), so that the
 * applications stop inventing their own.
 *
 * ## The file
 *
 *     "OSBA" | version | header length (4 bytes, big-endian) | header | envelope
 *
 * - **The header** is the caller's, and is read without a key
 *   ({@link readAppBackupHeader}). It is room for a keyring: invoice puts its
 *   vault there, one sealed slot per passkey, so that any registered passkey
 *   finds the key to the rest. This module does not interpret it. Its SHA-256
 *   is in the manifest, so a header swapped after the backup was made is
 *   refused once the body is open.
 * - **The envelope** is the package's own (`OSBE`, see ./backends/encryption.js)
 *   around the CAR, encrypted by the caller's `encrypt`. The package holds no
 *   keys, here as everywhere.
 * - **The CAR's root** is a dag-cbor manifest: `kind` and `v` say what this is,
 *   `app` whose it is, and `metadata` is `bundleDatabases`'s, naming every
 *   database with its heads. `extra` is the application's own (belege lists its
 *   receipt files there).
 *
 * Everything is built in memory, as the rest of the package does; a backup is
 * as large as the books it holds.
 *
 * @requires ./extract-blocks.js - bundleDatabases
 * @requires ./backup-car.js - createCARFromBlocks
 * @requires ./restore-cid.js - the verifying CAR reader, restoreFromBlocks
 */

import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { bundleDatabases } from "./extract-blocks.js";
import { createCARFromBlocks } from "./backup-car.js";
import { readBlocksFromCAR, restoreFromBlocks } from "./restore-cid.js";
import { wrapEnvelope, readEnvelope } from "./backends/encryption.js";

/** `OSBA` — orbitdb-storage-bridge, application backup. */
export const APP_BACKUP_MAGIC = new Uint8Array([0x4f, 0x53, 0x42, 0x41]);

/** Bumped when the file changes in a way readers must notice. */
export const APP_BACKUP_VERSION = 1;

/** What the manifest at the CAR's root calls itself. */
export const APP_BACKUP_KIND = "app-backup";

const PREAMBLE = APP_BACKUP_MAGIC.length + 1 + 4;

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(bytes) {
  return hex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)));
}

/**
 * @typedef {object} AppBackupManifest
 * @property {"app-backup"} kind
 * @property {number} v - {@link APP_BACKUP_VERSION}
 * @property {string} app - whose backup this is, e.g. `"invoice"`
 * @property {string} createdAt - ISO
 * @property {string} [appVersion]
 * @property {any} metadata - `bundleDatabases`'s: `databases` with each one's
 *   `address`, `name`, `type`, `manifestCID`, `entryCount`, `heads`, and
 *   `collection` when the databases were given by name
 * @property {string} [header] - hex SHA-256 of the file's header, when it has one
 * @property {any} [extra] - the application's own, as it passed it
 */

/**
 * @typedef {{ stage: "database", index: number, total: number, name: string, entries: number }
 *   | { stage: "sealing", bytes: number }} AppBackupProgress
 */

/**
 * Build a backup file.
 *
 * @param {object} params
 * @param {string} params.app - whose backup this is; {@link openAppBackup} can insist on it
 * @param {Object[]|Object<string, Object>} params.databases - open OrbitDB
 *   databases. Given by name, the names go into the metadata as `collection`.
 * @param {(plaintext: Uint8Array) => Promise<{ ciphertext: Uint8Array, iv: Uint8Array }>} params.encrypt -
 *   the caller's, with the caller's key
 * @param {Map<string, { bytes: Uint8Array }>} [params.blocks] - blocks of the
 *   application's own, by CID string: they travel in the CAR and come back into
 *   the blockstore on restore
 * @param {Uint8Array} [params.header] - read without a key, e.g. a keyring
 * @param {string} [params.appVersion]
 * @param {any} [params.extra] - anything dag-cbor can encode
 * @param {() => Date} [params.now]
 * @param {(progress: AppBackupProgress) => void} [params.onProgress]
 * @returns {Promise<{ bytes: Uint8Array, manifest: AppBackupManifest, blocks: number, carBytes: number }>}
 */
export async function buildAppBackup({
  app,
  databases,
  encrypt,
  blocks: own,
  header,
  appVersion,
  extra,
  now = () => new Date(),
  onProgress,
}) {
  if (typeof app !== "string" || !app) throw new Error("buildAppBackup needs the application's name as `app`");
  if (typeof encrypt !== "function") throw new Error("buildAppBackup needs an `encrypt` function: the package holds no keys");
  if (header !== undefined && !(header instanceof Uint8Array)) throw new Error("A backup's header is bytes");
  if (own !== undefined && !(own instanceof Map)) throw new Error("An application's own blocks come as a Map, by CID string");

  const at = now();
  const names = Array.isArray(databases) ? null : Object.keys(databases ?? {});
  const { blocks, metadata } = await bundleDatabases(databases, {
    timestamp: at.getTime(),
    onProgress: (p) =>
      onProgress?.({
        stage: "database",
        index: p.index,
        total: p.total,
        name: names?.[p.index] ?? p.name,
        entries: p.entries,
      }),
  });
  if (names) metadata.databases.forEach((d, i) => (d.collection = names[i]));
  for (const [name, block] of own ?? []) if (!blocks.has(name)) blocks.set(name, block);

  /** @type {AppBackupManifest} */
  const manifest = {
    kind: APP_BACKUP_KIND,
    v: APP_BACKUP_VERSION,
    app,
    createdAt: at.toISOString(),
    ...(appVersion ? { appVersion } : {}),
    metadata,
    ...(header?.length ? { header: await sha256Hex(header) } : {}),
    ...(extra !== undefined ? { extra } : {}),
  };
  const root = dagCbor.encode(manifest);
  const rootCid = CID.createV1(dagCbor.code, await sha256.digest(root));
  blocks.set(rootCid.toString(), { cid: rootCid, bytes: root });

  const car = await createCARFromBlocks(blocks, rootCid.toString());
  onProgress?.({ stage: "sealing", bytes: car.length });
  const { ciphertext, iv } = await encrypt(car);
  const envelope = wrapEnvelope(ciphertext, iv);

  const head = header ?? new Uint8Array(0);
  const bytes = new Uint8Array(PREAMBLE + head.length + envelope.length);
  bytes.set(APP_BACKUP_MAGIC, 0);
  bytes[APP_BACKUP_MAGIC.length] = APP_BACKUP_VERSION;
  new DataView(bytes.buffer).setUint32(APP_BACKUP_MAGIC.length + 1, head.length);
  bytes.set(head, PREAMBLE);
  bytes.set(envelope, PREAMBLE + head.length);
  return { bytes, manifest, blocks: blocks.size, carBytes: car.length };
}

/** Is this an application backup this module wrote, of any version? */
export function isAppBackup(bytes) {
  return (
    bytes instanceof Uint8Array &&
    bytes.length >= PREAMBLE &&
    APP_BACKUP_MAGIC.every((byte, index) => bytes[index] === byte)
  );
}

/**
 * The header, without a key: what a keyring needs before anything can be opened.
 *
 * @param {Uint8Array} bytes
 * @returns {{ version: number, header: Uint8Array, body: Uint8Array }}
 */
export function readAppBackupHeader(bytes) {
  if (!isAppBackup(bytes)) throw new Error("This is not an application backup.");
  const version = bytes[APP_BACKUP_MAGIC.length];
  if (version !== APP_BACKUP_VERSION) {
    throw new Error(
      `This backup was written in format ${version}, and this build reads ${APP_BACKUP_VERSION}. ` +
        "Upgrade @le-space/orbitdb-storage-bridge to open it.",
    );
  }
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(APP_BACKUP_MAGIC.length + 1);
  if (PREAMBLE + length > bytes.length) throw new Error("This backup is cut short.");
  return {
    version,
    header: bytes.subarray(PREAMBLE, PREAMBLE + length),
    body: bytes.subarray(PREAMBLE + length),
  };
}

/**
 * Open a backup file: the envelope decrypted, every block checked against its
 * own CID, the manifest found among them, and the header checked against it.
 *
 * A wrong key fails in `decrypt` itself (AES-GCM refuses it), and its error
 * comes through unchanged, for the caller to name.
 *
 * @param {Uint8Array} bytes
 * @param {object} options
 * @param {(ciphertext: Uint8Array, iv: Uint8Array) => Promise<Uint8Array>} options.decrypt
 * @param {string} [options.app] - refuse a backup of another application
 * @returns {Promise<{ header: Uint8Array, manifest: AppBackupManifest, blocks: Map<string, { cid: any, bytes: Uint8Array }> }>}
 */
export async function openAppBackup(bytes, { decrypt, app } = {}) {
  if (typeof decrypt !== "function") throw new Error("openAppBackup needs a `decrypt` function");
  const { header, body } = readAppBackupHeader(bytes);
  const { ciphertext, iv } = readEnvelope(body);
  const car = await decrypt(ciphertext, iv);
  const blocks = await readBlocksFromCAR(car, { verify: true });

  let manifest;
  for (const [name, { bytes: block }] of blocks) {
    if (CID.parse(name).code !== dagCbor.code) continue;
    let value;
    try {
      value = dagCbor.decode(block);
    } catch {
      continue;
    }
    if (value?.kind === APP_BACKUP_KIND && value?.v === APP_BACKUP_VERSION) {
      manifest = value;
      break;
    }
  }
  if (!manifest) throw new Error("This backup holds no manifest.");
  if (app && manifest.app !== app) throw new Error(`This is a backup of ${manifest.app}, not of ${app}.`);
  // The header is outside the seal; the manifest inside it says which header belongs.
  const expected = manifest.header ?? null;
  const actual = header.length ? await sha256Hex(header) : null;
  if (expected !== actual) throw new Error("This backup's header is not the one it was made with.");
  return { header, manifest, blocks };
}

/**
 * @typedef {{ stage: "database", index: number, total: number, name: string, joined: number }} AppRestoreProgress
 */

/**
 * Put an opened backup back into books that are open here.
 *
 * Every database the backup names must be one of these books, by address:
 * restoring merges, and merging another's books into these is never wanted.
 * The databases go back through {@link restoreFromBlocks}: every block into the
 * blockstore (the application's own with them), each database reopened and its
 * heads joined. Joining merges — what is here stays, what the backup holds is
 * added, nothing is deleted. A head that cannot be joined fails the restore
 * with the reason, where `restoreFromBlocks` alone only warns.
 *
 * The open databases are closed and reopened behind the caller's back; reload
 * the application's handles afterwards.
 *
 * @param {object} params
 * @param {any} params.orbitdb
 * @param {{ manifest: AppBackupManifest, blocks: Map<string, any> }} params.opened - from {@link openAppBackup}
 * @param {Record<string, string> | string[]} params.addresses - these books'
 *   database addresses, by collection or as a list
 * @param {Record<string, any>} [params.open] - what `orbitdb.open` needs for them (`encryption`, `AccessController`, …)
 * @param {(progress: AppRestoreProgress) => void} [params.onProgress]
 * @returns {Promise<{ databases: { address: string, collection?: string, joined: number, entries: number | null }[] }>}
 */
export async function restoreAppBackup({ orbitdb, opened, addresses, open, onProgress }) {
  const metadata = opened?.manifest?.metadata;
  if (!metadata?.databases?.length) throw new Error("This backup names no databases.");
  const byAddress = Array.isArray(addresses)
    ? Object.fromEntries(addresses.map((address) => [String(address), undefined]))
    : Object.fromEntries(Object.entries(addresses ?? {}).map(([collection, address]) => [String(address), collection]));
  for (const d of metadata.databases) {
    if (!(String(d.address) in byAddress)) {
      throw new Error("This backup holds databases these books do not have.");
    }
  }

  const warnings = [];
  const restored = await restoreFromBlocks(orbitdb, opened.blocks, metadata, {
    open,
    log: { info() {}, debug() {}, warn: (message) => warnings.push(String(message)) },
    onProgress: (p) =>
      onProgress?.({
        stage: "database",
        index: p.index,
        total: p.total,
        name: byAddress[p.address] ?? p.address,
        joined: p.joined,
      }),
  });
  const failed = warnings.find((w) => /could not join head/.test(w));
  if (failed) throw new Error(`The backup could not be put back: ${failed.replace(/^\W+/, "")}`);
  return {
    databases: restored.databases.map((d) => ({
      address: d.address,
      ...(byAddress[d.address] ? { collection: byAddress[d.address] } : {}),
      joined: d.joined,
      entries: d.entries ?? null,
    })),
  };
}
