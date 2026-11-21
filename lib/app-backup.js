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
 * - **The envelope** is the package's own (`OSBE`) around the CAR. Given a
 *   `key`, it is the envelope in frames (version 2, ./backends/frames.js): the
 *   file can then be restored as it arrives ({@link restoreAppBackupStream}),
 *   in the memory of one frame and one block, and the header is bound into
 *   the frames' key. Given the caller's `encrypt`, it is the envelope in one
 *   piece (version 1, ./backends/encryption.js), which can only be opened
 *   whole. The package keeps no keys, here as everywhere.
 * - **The CAR's root** is a dag-cbor manifest: `kind` and `v` say what this is,
 *   `app` whose it is, and `metadata` is `bundleDatabases`'s, naming every
 *   database with its heads. `extra` is the application's own (belege lists its
 *   receipt files there).
 *
 * A backup is built in memory, as the rest of the package does, and an upload
 * wants its whole body; it is the restore that has to fit a phone.
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
import { readBlocksFromCAR, restoreFromBlocks, restoreFromStoredBlocks, storeBlocksFromCAR } from "./restore-cid.js";
import { wrapEnvelope, readEnvelope } from "./backends/encryption.js";
import { ByteQueue, collectBytes, envelopeVersion, isFramed, openFramed, openFrames, sealFramed } from "./backends/frames.js";

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
 * @param {Uint8Array | CryptoKey} [params.key] - seal in frames with this key
 *   (32 bytes, or a `CryptoKey` for HKDF): the form to prefer, the only one a
 *   restore can stream
 * @param {number} [params.frameSize] - with `key`: plaintext bytes in a frame
 * @param {(plaintext: Uint8Array) => Promise<{ ciphertext: Uint8Array, iv: Uint8Array }>} [params.encrypt] -
 *   instead of `key`: the caller's, with the caller's key, in one piece
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
  key,
  frameSize,
  blocks: own,
  header,
  appVersion,
  extra,
  now = () => new Date(),
  onProgress,
}) {
  if (typeof app !== "string" || !app) throw new Error("buildAppBackup needs the application's name as `app`");
  if (key === undefined && typeof encrypt !== "function") {
    throw new Error("buildAppBackup needs a `key` (sealed in frames) or an `encrypt` function: the package holds no keys");
  }
  if (key !== undefined && encrypt !== undefined) throw new Error("buildAppBackup takes a `key` or `encrypt`, not both");
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
  // The manifest first: a restore that reads the file as it arrives knows
  // whose backup this is before it stores the rest.
  const ordered = new Map([[rootCid.toString(), { cid: rootCid, bytes: root }]]);
  for (const [name, block] of blocks) if (!ordered.has(name)) ordered.set(name, block);

  const car = await createCARFromBlocks(ordered, rootCid.toString());
  onProgress?.({ stage: "sealing", bytes: car.length });
  const head = header ?? new Uint8Array(0);
  let envelope;
  if (key !== undefined) {
    envelope = await sealFramed(car, { key, context: head, ...(frameSize ? { frameSize } : {}) });
  } else {
    const { ciphertext, iv } = await encrypt(car);
    envelope = wrapEnvelope(ciphertext, iv);
  }

  const bytes = new Uint8Array(PREAMBLE + head.length + envelope.length);
  bytes.set(APP_BACKUP_MAGIC, 0);
  bytes[APP_BACKUP_MAGIC.length] = APP_BACKUP_VERSION;
  new DataView(bytes.buffer).setUint32(APP_BACKUP_MAGIC.length + 1, head.length);
  bytes.set(head, PREAMBLE);
  bytes.set(envelope, PREAMBLE + head.length);
  return { bytes, manifest, blocks: ordered.size, carBytes: car.length };
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
 * @param {(ciphertext: Uint8Array, iv: Uint8Array) => Promise<Uint8Array>} [options.decrypt] -
 *   for a backup sealed in one piece
 * @param {Uint8Array | CryptoKey} [options.key] - for a backup sealed in frames
 * @param {string} [options.app] - refuse a backup of another application
 * @returns {Promise<{ header: Uint8Array, manifest: AppBackupManifest, blocks: Map<string, { cid: any, bytes: Uint8Array }> }>}
 */
export async function openAppBackup(bytes, { decrypt, key, app } = {}) {
  const { header, body } = readAppBackupHeader(bytes);
  let car;
  if (isFramed(body)) {
    if (key === undefined) throw new Error("This backup is sealed in frames: openAppBackup needs its `key`");
    car = await openFramed(body, { key, context: header });
  } else {
    if (typeof decrypt !== "function") throw new Error("openAppBackup needs a `decrypt` function");
    const { ciphertext, iv } = readEnvelope(body);
    car = await decrypt(ciphertext, iv);
  }
  const blocks = await readBlocksFromCAR(car, { verify: true });

  let manifest;
  for (const [name, { bytes: block }] of blocks) {
    if (CID.parse(name).code !== dagCbor.code) continue;
    manifest = manifestIn(block);
    if (manifest) break;
  }
  if (!manifest) throw new Error("This backup holds no manifest.");
  await assertManifest(manifest, header, app);
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
  const byAddress = collectionsByAddress(addresses);
  assertTheseBooks(opened?.manifest, byAddress);
  return putBack(byAddress, onProgress, (options) =>
    restoreFromBlocks(orbitdb, opened.blocks, opened.manifest.metadata, { open, ...options }),
  );
}

/** These books' database addresses, each with its collection when they came by name. */
function collectionsByAddress(addresses) {
  return Array.isArray(addresses)
    ? Object.fromEntries(addresses.map((address) => [String(address), undefined]))
    : Object.fromEntries(Object.entries(addresses ?? {}).map(([collection, address]) => [String(address), collection]));
}

/** Every database the backup names is one of these books, or it is refused. */
function assertTheseBooks(manifest, byAddress) {
  const metadata = manifest?.metadata;
  if (!metadata?.databases?.length) throw new Error("This backup names no databases.");
  for (const d of metadata.databases) {
    if (!(String(d.address) in byAddress)) {
      throw new Error("This backup holds databases these books do not have.");
    }
  }
}

/** The join, with a head that could not be joined as a failure and the answer in the application's words. */
async function putBack(byAddress, onProgress, restore) {
  const warnings = [];
  const restored = await restore({
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

/**
 * The header of a backup that arrives in pieces, without a key, and the rest
 * of the stream behind it: what a keyring needs before anything can be opened,
 * read from the first bytes and not from the whole file.
 *
 * @param {AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Uint8Array} source
 * @returns {Promise<{ version: number, header: Uint8Array, body: AsyncGenerator<Uint8Array> }>}
 *   `body` is the envelope; it must be read, or returned, for the source to be let go
 */
export async function readAppBackupHeaderStream(source) {
  const chunks = (
    source instanceof Uint8Array
      ? (async function* () {
          yield source;
        })()
      : source
  )[Symbol.asyncIterator]?.() ?? source[Symbol.iterator]();
  const queue = new ByteQueue();
  let ended = false;
  const fill = async (n) => {
    while (!ended && queue.length < n) {
      const { done, value } = await chunks.next();
      if (done) ended = true;
      else queue.push(value);
    }
    return queue.length >= n;
  };
  try {
    if (!(await fill(PREAMBLE))) throw new Error("This is not an application backup.");
    const preamble = queue.take(PREAMBLE);
    if (!isAppBackup(preamble)) throw new Error("This is not an application backup.");
    const version = preamble[APP_BACKUP_MAGIC.length];
    if (version !== APP_BACKUP_VERSION) {
      throw new Error(
        `This backup was written in format ${version}, and this build reads ${APP_BACKUP_VERSION}. ` +
          "Upgrade @le-space/orbitdb-storage-bridge to open it.",
      );
    }
    const length = new DataView(preamble.buffer, preamble.byteOffset, preamble.byteLength).getUint32(
      APP_BACKUP_MAGIC.length + 1,
    );
    if (length > MAX_HEADER_BYTES) throw new Error(`This backup names a header of ${length} bytes; a header has at most ${MAX_HEADER_BYTES}.`);
    if (!(await fill(length))) throw new Error("This backup is cut short.");
    // Its own copy: it outlives the chunk it arrived in.
    const header = new Uint8Array(queue.take(length));
    return {
      version,
      header,
      body: (async function* () {
        try {
          while (queue.length) yield queue.take(queue.chunks[0].length);
          while (!ended) {
            const { done, value } = await chunks.next();
            if (done) ended = true;
            else if (value?.length) yield value;
          }
        } finally {
          await chunks.return?.();
        }
      })(),
    };
  } catch (error) {
    await chunks.return?.();
    throw error;
  }
}

/** The longest header a streamed reader holds: a keyring, not a payload. */
export const MAX_HEADER_BYTES = 16 * 1024 * 1024;

/**
 * @typedef {{ stage: "opened", frames: number, bytes: number }
 *   | { stage: "stored", blocks: number, bytes: number }
 *   | AppRestoreProgress} AppRestoreStreamProgress
 */

/**
 * Restore a backup as it arrives (#187): {@link openAppBackup} and
 * {@link restoreAppBackup} in one pass, for a file too large to hold. Each
 * frame is opened as it comes, each block checked and put into the blockstore
 * and let go, so the memory this needs is a frame's and a block's, whatever
 * the backup's size.
 *
 * The same refusals as there, at the earliest moment each can be known: a
 * wrong key before the first frame; another application's backup, or one of
 * other books, at the manifest, which a backup made here carries first, so
 * before any block is stored. **The databases are joined only after the last
 * frame opened**: a file that is cut short, or damaged anywhere, throws with
 * the books untouched. The blocks it stored until then stay in the blockstore,
 * sealed and pointed at by nothing.
 *
 * A backup sealed in one piece (with `encrypt`) cannot be opened as it
 * arrives. It is restored all the same when `decrypt` is given, held whole as
 * {@link openAppBackup} holds it.
 *
 * @param {object} params
 * @param {any} params.orbitdb
 * @param {AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Uint8Array} params.source -
 *   the file, e.g. a backend's `getBlobStream`
 * @param {Uint8Array | CryptoKey} [params.key] - opens a backup sealed in frames
 * @param {(ciphertext: Uint8Array, iv: Uint8Array) => Promise<Uint8Array>} [params.decrypt] -
 *   opens a backup sealed in one piece
 * @param {string} [params.app] - refuse a backup of another application
 * @param {Record<string, string> | string[]} params.addresses - as {@link restoreAppBackup}
 * @param {Record<string, any>} [params.open]
 * @param {(header: Uint8Array) => Promise<{ key?: Uint8Array | CryptoKey, decrypt?: Function } | void> | { key?: Uint8Array | CryptoKey, decrypt?: Function } | void} [params.onHeader] -
 *   sees the header before anything is opened, and may answer with the key it
 *   leads to: how a keyring in the header is used
 * @param {(progress: AppRestoreStreamProgress) => void} [params.onProgress] -
 *   frames opened, blocks stored, databases joined; bytes fetched are the
 *   source's to report (`getBlobStream`'s `onProgress`)
 * @returns {Promise<{ header: Uint8Array, manifest: AppBackupManifest, blocks: number, streamed: boolean,
 *   databases: { address: string, collection?: string, joined: number, entries: number | null }[] }>}
 */
export async function restoreAppBackupStream({
  orbitdb,
  source,
  key,
  decrypt,
  app,
  addresses,
  open,
  onHeader,
  onProgress,
}) {
  if (!orbitdb?.ipfs?.blockstore) throw new Error("An OrbitDB instance is required");
  const byAddress = collectionsByAddress(addresses);
  const { header, body } = await readAppBackupHeaderStream(source);
  const chunks = body[Symbol.asyncIterator]();
  try {
    const found = (await onHeader?.(header)) ?? {};
    key = found.key ?? key;
    decrypt = found.decrypt ?? decrypt;

    // The envelope's version is in its first five bytes.
    const start = new ByteQueue();
    let ended = false;
    while (!ended && start.length < 5) {
      const { done, value } = await chunks.next();
      if (done) ended = true;
      else start.push(value);
    }
    const first = start.take(start.length);
    const rest = (async function* () {
      if (first.length) yield first;
      if (!ended) yield* { [Symbol.asyncIterator]: () => chunks };
    })();

    if (envelopeVersion(first) !== 2) {
      // In one piece: there is no opening it before all of it is here.
      const opened = await openEnvelope(await collectBytes(rest), header, { decrypt, app });
      const restored = await restoreAppBackup({ orbitdb, opened, addresses, open, onProgress });
      return { header, manifest: opened.manifest, blocks: opened.blocks.size, streamed: false, ...restored };
    }
    if (key === undefined) throw new Error("This backup is sealed in frames: restoring it needs its `key`");

    let manifest;
    const stored = await storeBlocksFromCAR(orbitdb.ipfs.blockstore, openFrames(rest, { key, context: header, onProgress }), {
      onProgress,
      onBlock: async ({ cid, bytes }, { roots }) => {
        if (manifest || !roots.some((root) => root.equals(cid))) return;
        const value = manifestIn(bytes);
        if (!value) return;
        await assertManifest(value, header, app);
        assertTheseBooks(value, byAddress);
        manifest = value;
      },
    });
    if (!manifest) throw new Error("This backup holds no manifest.");
    const restored = await putBack(byAddress, onProgress, (options) =>
      restoreFromStoredBlocks(orbitdb, stored, manifest.metadata, { open, ...options }),
    );
    return { header, manifest, blocks: stored.blocks, streamed: true, ...restored };
  } finally {
    await chunks.return?.();
  }
}

/** A block's value, when it is an application backup's manifest. */
function manifestIn(bytes) {
  let value;
  try {
    value = dagCbor.decode(bytes);
  } catch {
    return null;
  }
  return value?.kind === APP_BACKUP_KIND && value?.v === APP_BACKUP_VERSION ? value : null;
}

/** The manifest is of this application, and names the header the file has. */
async function assertManifest(manifest, header, app) {
  if (app && manifest.app !== app) throw new Error(`This is a backup of ${manifest.app}, not of ${app}.`);
  // The header is outside the seal; the manifest inside it says which header belongs.
  const expected = manifest.header ?? null;
  const actual = header.length ? await sha256Hex(header) : null;
  if (expected !== actual) throw new Error("This backup's header is not the one it was made with.");
}

/** An envelope in one piece, opened: {@link openAppBackup} behind the header. */
async function openEnvelope(body, header, { decrypt, app }) {
  if (typeof decrypt !== "function") {
    throw new Error("This backup is sealed in one piece: restoring it needs a `decrypt` function");
  }
  const { ciphertext, iv } = readEnvelope(body);
  const car = await decrypt(ciphertext, iv);
  const blocks = await readBlocksFromCAR(car, { verify: true });
  let manifest;
  for (const [name, { bytes: block }] of blocks) {
    if (CID.parse(name).code !== dagCbor.code) continue;
    manifest = manifestIn(block);
    if (manifest) break;
  }
  if (!manifest) throw new Error("This backup holds no manifest.");
  await assertManifest(manifest, header, app);
  return { header, manifest, blocks };
}
