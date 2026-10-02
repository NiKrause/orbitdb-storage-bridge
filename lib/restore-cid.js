/**
 * Restore an OrbitDB database from a single CID — no Storacha client.
 *
 * `restoreFromSpaceCAR` can already do this: hand it a `metadataCID` and it
 * resolves the blocks CAR out of the metadata and fetches both from public
 * gateways, with no credentials on the restoring side. The problem was never
 * the capability, it was the import — `backup-car.js` reaches into
 * `orbitdb-storacha-bridge.js`, which pulls in `@storacha/client` at module
 * level, so a peer that only ever *reads* paid for the whole backup SDK.
 *
 * Measured against a real consumer (funkpost's `mesh-todo`, 561 kB gzipped):
 * importing `restoreFromSpaceCAR` added **617 kB gzipped**; what the steps
 * below actually need adds about **11 kB**, because a consumer of this package
 * already ships `multiformats` and `@ipld/dag-cbor`, leaving `@ipld/car`.
 *
 * So this module imports no client, no space, no proof, no Helia — and no
 * logger, which is not a detail: the package's logger reaches `@libp2p/logger`,
 * and pulling a logging framework in behind a progress line would undo most of
 * the saving. Both the fetching and the logging are **injectable** instead: the
 * default fetch is `fetch` against public gateways, the default log is silence,
 * and a caller that wants either of the package's own versions passes it.
 *
 * ## Why a peer that only restores is a real shape
 *
 * Backing up needs an account. Reading a backup does not — a CID is a name that
 * anyone can resolve. Alice keeps the space; Bob has a link. Over a courier
 * where a byte is rationed this is the difference between announcing a whole
 * database and announcing where one is: a CID fits in a single LoRa frame.
 *
 * @module restore-cid
 */

import { CarReader } from "@ipld/car";
import { CID } from "multiformats/cid";
import { base58btc } from "multiformats/bases/base58";
import * as Block from "multiformats/block";
import * as dagCbor from "@ipld/dag-cbor";
import { sha256, sha512 } from "multiformats/hashes/sha2";
import { isValidMetadata } from "./backup-metadata.js";
// Re-exported below, so `restore-cid`'s surface is unchanged by the move.
import { DEFAULT_GATEWAYS, SILENT, fetchFromGateways } from "./gateway-fetch.js";

export { DEFAULT_GATEWAYS, SILENT, fetchFromGateways };

const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * One spelling of a CID, so two of them can be compared.
 *
 * The same block is called `zdpuAw…` by OrbitDB, which addresses in base58btc,
 * and `bafyrei…` inside a CAR, which uses the CID's own base32. Both are the
 * same 32 bytes wearing different clothes, and comparing the strings says they
 * are different — a mistake that reads as "the block is missing" and is
 * therefore very easy to believe.
 */
const canonical = (value) => {
  try {
    return CID.parse(String(value)).toV1().toString();
  } catch {
    return null;
  }
};

/** dag-cbor. Only these blocks can be OrbitDB log entries. */
const DAG_CBOR = 0x71;

/** By multihash code, so a block can be checked against the CID that names it. */
const HASHERS = new Map([
  [sha256.code, sha256],
  [sha512.code, sha512],
]);

/**
 * Every block in a CAR, by CID string — each one checked against its own name.
 *
 * **`CarReader` does not do this**, and the omission is easy to miss because it
 * looks like it must: it hands back whatever CID the file claims for whatever
 * bytes sit next to it, unverified. A CAR can therefore carry a block labelled
 * with one CID and containing something else entirely, and a restore would put
 * the attacker's bytes into the blockstore under a name the application trusts.
 *
 * That risk used to be bounded by where the bytes came from — your own space,
 * on a service you had an account with. This module deliberately removed that
 * boundary: it fetches from public gateways and takes an injected fetch, so the
 * bytes can come from anywhere. Verification is what makes that safe, and it is
 * the property worth having rather than a mitigation: **once every block is
 * checked against its CID, where it came from stops mattering.** A hostile
 * mirror, a stale gateway, a file on a USB stick — none of them can forge a
 * block, only fail to provide one.
 *
 * @param {Uint8Array} carBytes
 * @param {Object} [options]
 * @param {boolean} [options.verify=true] Only turn this off for bytes you
 *   produced yourself and have not let out of your sight.
 * @returns {Promise<Map<string, { bytes: Uint8Array }>>}
 */
export async function readBlocksFromCAR(carBytes, { verify = true } = {}) {
  const reader = await CarReader.fromBytes(carBytes);
  const blocks = new Map();

  for await (const block of reader.blocks()) {
    const name = block.cid.toString();

    if (verify) {
      const hasher = HASHERS.get(block.cid.multihash.code);
      // Refused rather than waved through: a hash we cannot compute is a block
      // we cannot vouch for, and silently accepting it would defeat the point.
      if (!hasher) {
        throw new Error(
          `Block ${name} uses multihash 0x${block.cid.multihash.code.toString(16)}, which this reader cannot verify`,
        );
      }
      const digest = await hasher.digest(block.bytes);
      if (!sameBytes(digest.digest, block.cid.multihash.digest)) {
        throw new Error(`Block ${name} does not hash to its own CID — the CAR has been tampered with`);
      }
    }

    blocks.set(name, { bytes: block.bytes });
  }

  return blocks;
}

/**
 * The heads of a hash-linked log: entries nothing else points back to.
 *
 * Derived from the blocks rather than carried in the metadata, because the
 * blocks are the truth and a stated head can be stale. A block counts as a log
 * entry only if it is dag-cbor *and* carries a signature, key and identity —
 * the manifest and the access controller are dag-cbor too.
 */
async function headsIn(blocks) {
  const entries = [];
  const pointedAt = new Set();

  for (const [cidString, { bytes }] of blocks) {
    let cid;
    try {
      cid = CID.parse(cidString);
    } catch {
      continue;
    }
    if (cid.code !== DAG_CBOR) continue;

    try {
      const { value } = await Block.decode({ cid, bytes, codec: dagCbor, hasher: sha256 });
      if (!value?.sig || !value?.key || !value?.identity) continue;
      entries.push({ hash: cid.toV1().toString(base58btc), value });
      if (Array.isArray(value.next)) for (const next of value.next) pointedAt.add(next);
    } catch {
      /* not a block we can read; the CAR may hold more than this log */
    }
  }

  return entries.filter((entry) => !pointedAt.has(entry.hash));
}

/**
 * Restore from the CID of a CAR backup's metadata: every database it names
 * (`restoreFromBlocks` does the work once the blocks are fetched).
 *
 * Everything hangs off that one CID: the metadata names the CAR, the CAR holds
 * the blocks, and the blocks carry their own addresses. Nothing here talks to
 * Storacha, so the caller needs no space, key or proof — only a way to fetch
 * bytes, which by default is `fetch` against public gateways.
 *
 * **The returned `database` replaces any handle the caller already held on this
 * address.** The log has to be reopened to read the blocks put underneath it,
 * and `orbitdb.open` hands out one instance per address — so the instance that
 * gets closed here is the caller's own, and writing through it afterwards fails
 * on an aborted signal.
 *
 * @param {Object} orbitdb an OrbitDB instance to restore into
 * @param {Object} options
 * @param {string} options.metadataCID the pointer — what `backupDatabaseCAR`
 *   returns as `backupFiles.metadataCID`
 * @param {string[]} [options.gateways]
 * @param {number} [options.timeout] per request, in ms
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.verify=true] Check every block against its own
 *   CID, and that the CAR really holds the manifest this backup names. Leaving
 *   it on is what makes an untrusted source acceptable.
 * @param {{ info: Function, warn: Function, debug: Function }} [options.log]
 *   where to report progress; silent unless given. Pass the package's own
 *   `logger` for the verbose behaviour `restoreFromSpaceCAR` has.
 * @param {(cid: string, options: Object) => Promise<Uint8Array>} [options.fetchBytes]
 *   how to resolve a CID. Injected rather than imported so that a caller with
 *   its own IPFS node can use it without every caller bundling one.
 * @param {Object} [options.open] options for `orbitdb.open`, merged over the
 *   type the backup names. A node without pubsub needs `{ sync: false }` here:
 *   OrbitDB's Sync subscribes on open, and on a libp2p built without a pubsub
 *   service that throws before the database is ever handed back.
 * @returns {Promise<{ address: string, database: Object, blocks: number,
 *   entries: number, heads: number, joined: number, databases: Object[] }>}
 *   the first database's at the top, as a one-database backup always had it;
 *   `databases` lists them all
 */
export async function restoreFromCID(orbitdb, options = {}) {
  const { metadataCID, fetchBytes = fetchFromGateways, log = SILENT, verify = true, open = {}, ...rest } = options;

  if (!orbitdb?.ipfs?.blockstore) throw new Error("An OrbitDB instance is required");
  if (!metadataCID) throw new Error("A metadataCID is required");

  log.info(`🔄 Restoring from ${metadataCID}`);

  // 1 · the metadata names everything else
  const metadataBytes = await fetchBytes(metadataCID, { ...rest, log });
  let metadata;
  try {
    metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
  } catch (error) {
    throw new Error(`Backup metadata at ${metadataCID} is not JSON: ${error.message}`, { cause: error });
  }
  if (!isValidMetadata(metadata)) throw new Error("Invalid backup metadata");

  // Everything the metadata must name, checked before anything is downloaded —
  // a CAR is the large fetch here, and finding out afterwards that there is no
  // address to open it into wastes the whole transfer.
  const carCID = metadata.carCID;
  if (!carCID) throw new Error("Backup metadata names no CAR file");
  assertRestorable(metadata);

  // 2 · the CAR holds the blocks, and each one is checked against its own CID
  const blocks = await readBlocksFromCAR(await fetchBytes(carCID, { ...rest, log }), { verify });
  log.info(`   ✅ ${blocks.size} blocks`);

  // 3 · every database the metadata names
  const restored = await restoreFromBlocks(orbitdb, blocks, metadata, { log, verify, open });
  const [first] = restored.databases;

  // The one-database answer this always gave, and the whole list beside it.
  return {
    address: first.address,
    database: first.database,
    blocks: restored.blocks,
    entries: metadata.totalEntries ?? first.entries,
    heads: first.heads,
    joined: first.joined,
    databases: restored.databases,
  };
}

/**
 * Refuse metadata that names nothing a restore could open, and say which kind
 * it is. `isValidMetadata` also accepts the older `{ root, path }` shape, which
 * predates CAR backups and has no address to open.
 */
function assertRestorable(metadata) {
  const dbs = metadata.databases ?? [];
  if (dbs.length === 0) throw new Error("Backup metadata names no database");
  if (!dbs.every((db) => db?.address)) {
    throw new Error("This is a pre-CAR backup; restoreFromCID needs a CAR backup");
  }
}

/**
 * Restore every database a backup names, from blocks already in hand.
 *
 * `restoreFromCID` fetches and then calls this. An application that holds the
 * blocks some other way — a backup it sealed itself and has just opened, a file
 * on a USB stick, several small CARs written as it went — calls it directly.
 * The blocks are checked against the metadata, never trusted for it: each
 * database's manifest must be among them.
 *
 * Per database: the blocks go into the blockstore (once, for all of them) and
 * into that database's own log storage (its dag-cbor blocks only — a receipt
 * file's raw chunks are no log's business); the database is reopened so the
 * log reads what was put underneath it; and its heads are joined. The heads
 * are the ones the metadata states, or — for metadata that states none — the
 * entries of this log nothing else points back to.
 *
 * **Each returned `database` replaces any handle the caller held on that
 * address**, for the reason `restoreFromCID` gives.
 *
 * @param {Object} orbitdb an OrbitDB instance to restore into
 * @param {Map<string, { bytes: Uint8Array }>} blocks by CID string, in any base —
 *   what `readBlocksFromCAR` returns
 * @param {Object} metadata as `bundleDatabases` or `backupDatabaseCAR` write it
 * @param {Object} [options]
 * @param {boolean} [options.verify=true] each database's manifest must be among the blocks
 * @param {{ info: Function, warn: Function, debug: Function }} [options.log]
 * @param {Object} [options.open] options for `orbitdb.open`, merged over the type
 *   the backup names (a node without pubsub needs `{ sync: false }`)
 * @param {(progress: { stage: "database", index: number, total: number,
 *   address: string, joined: number, heads: number }) => void} [options.onProgress]
 * @returns {Promise<{ blocks: number, databases: { address: string, name?: string,
 *   database: Object, entries: number|null, heads: number, joined: number }[] }>}
 */
export async function restoreFromBlocks(orbitdb, blocks, metadata, options = {}) {
  const { log = SILENT, verify = true, open = {}, onProgress } = options;
  if (!orbitdb?.ipfs?.blockstore) throw new Error("An OrbitDB instance is required");
  if (!(blocks instanceof Map)) throw new Error("blocks must be a Map");
  if (!isValidMetadata(metadata)) throw new Error("Invalid backup metadata");
  assertRestorable(metadata);

  // The blocks verify individually; this is what ties them to *this* backup.
  // Without it a CAR full of perfectly valid blocks from some other database
  // would restore happily, because every block would be honest about itself.
  const present = new Set([...blocks.keys()].map(canonical));
  if (verify) {
    for (const db of metadata.databases) {
      const manifestCID = db.manifestCID ?? metadata.manifestCID;
      if (!manifestCID) continue;
      const wanted = canonical(manifestCID);
      if (!wanted || !present.has(wanted)) {
        throw new Error(`The CAR does not contain the manifest ${manifestCID} that this backup names`);
      }
    }
  }

  // Into the blockstore, where Helia looks — once, whatever the databases.
  let stored = 0;
  for (const [cidString, { bytes }] of blocks) {
    try {
      await orbitdb.ipfs.blockstore.put(CID.parse(cidString), bytes);
      stored++;
    } catch (error) {
      log.warn(`   ⚠️ could not store ${cidString.slice(0, 12)}…: ${error.message}`);
    }
  }

  const found = metadata.databases.some((db) => !Array.isArray(db.heads)) ? await headsIn(blocks) : [];
  const byCanonical = new Map([...blocks].map(([name, block]) => [canonical(name), block]));

  const databases = [];
  for (const [index, dbInfo] of metadata.databases.entries()) {
    const opened = await orbitdb.open(dbInfo.address, { type: dbInfo.type, ...open });
    // OrbitDB's log reads from its own store and addresses blocks in base58btc
    // rather than the CAR's base32. A restore that fills only the blockstore
    // opens a database that is empty in a way nothing reports.
    for (const [cidString, { bytes }] of blocks) {
      try {
        const cid = CID.parse(cidString);
        if (cid.code !== DAG_CBOR) continue;
        await opened.log.storage.put(cid.toV1().toString(base58btc), bytes);
      } catch (error) {
        log.warn(`   ⚠️ could not copy ${cidString.slice(0, 12)}… to log storage: ${error.message}`);
      }
    }

    // Reopened so the log reads what we just put underneath it.
    await opened.close();
    const database = await orbitdb.open(dbInfo.address, { type: dbInfo.type, ...open });

    // Tell the log where its history ends.
    const heads = Array.isArray(dbInfo.heads)
      ? (await Promise.all(dbInfo.heads.map((hash) => headFrom(byCanonical, hash)))).filter(Boolean)
      : found.filter((head) => head.value.id === dbInfo.address || metadata.databases.length === 1);
    let joined = 0;
    for (const head of heads) {
      try {
        // The log decodes its own entry: an encrypted database's entry is not
        // the raw dag-cbor fields, and joining those throws (an `undefined`
        // the IPLD data model refuses). The raw fields stay as the fallback for
        // a log storage that does not have the block.
        const entry = await database.log.get(head.hash).catch(() => undefined);
        const { v, id, key, sig, next, refs, clock, payload, identity } = head.value;
        if (await database.log.joinEntry(entry ?? { hash: head.hash, v, id, key, sig, next, refs, clock, payload, identity })) {
          joined++;
        }
      } catch (error) {
        log.warn(`   ⚠️ could not join head ${head.hash.slice(0, 12)}…: ${error.message}`);
      }
    }

    log.info(`✅ Restored ${dbInfo.address} — ${joined}/${heads.length} heads`);
    onProgress?.({
      stage: "database",
      index,
      total: metadata.databases.length,
      address: dbInfo.address,
      joined,
      heads: heads.length,
    });
    databases.push({
      address: dbInfo.address,
      name: dbInfo.name,
      database,
      entries: dbInfo.entryCount ?? null,
      heads: heads.length,
      joined,
    });
  }

  return { blocks: stored, databases };
}

/** A stated head, decoded from the blocks; null when the blocks lack it. */
async function headFrom(byCanonical, hash) {
  const name = canonical(hash);
  const block = name ? byCanonical.get(name) : undefined;
  if (!block) return null;
  const cid = CID.parse(name);
  const { value } = await Block.decode({ cid, bytes: block.bytes, codec: dagCbor, hasher: sha256 });
  return { hash: cid.toV1().toString(base58btc), value };
}

export default { restoreFromCID, restoreFromBlocks, fetchFromGateways, readBlocksFromCAR, DEFAULT_GATEWAYS, SILENT };
