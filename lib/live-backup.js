/**
 * @fileoverview Incremental live backup: what was written since the last
 * increment, shipped as one small CAR (#144).
 *
 * A full backup (`bundleDatabases`, `buildAppBackup`) is the baseline, and it
 * stays one. This module adds what happens *between* two of them: a block
 * should be durable somewhere else soon after it is written, without anyone
 * clicking "back up" and without another peer being online.
 *
 * ## Write-behind, never write-through
 *
 * A local write never waits for the network. The watcher keeps, per database,
 * the heads it last shipped; a flush walks from the current heads back over
 * `next` until it meets an entry it has already shipped, and everything it
 * passed on the way is the increment. Entries that arrived by replication from
 * another device are reachable from the heads like any other, so they ship
 * too — otherwise each device would back up only its own writes.
 *
 * The walk needs to know what was shipped, and the previous heads alone do not
 * say it: a branch another writer forked from an old entry leads back past
 * them. So the set of shipped hashes is kept in memory and, after a restart,
 * rebuilt once from the persisted heads by walking the log. What has to be
 * persisted is therefore tiny — a sequence number and a few hashes per
 * database — and a crash between "written" and "shipped" loses nothing: the
 * next flush finds the entry where it left it.
 *
 * ## One upload, one STORE
 *
 * An increment is one CAR whose root is a dag-cbor manifest
 * (`{ kind: "increment", v: 1, sequence, base, previous, metadata }`), so a
 * single blob is self-describing. Every increment carries each database's
 * manifest and access controller (a few hundred bytes) and the identity of
 * every writer it has entries from, so a chain of increments restores on its
 * own, with no base, if it is complete from the beginning; and so
 * `restoreFromBlocks` can verify each one the way it verifies a backup.
 *
 * The CAR goes through any `StorageBackend`'s `putBlob`. A backend that says
 * `retained: false` — Aleph, where an upload is ingest and keeping is a
 * STORE — is then asked to keep it with `pinCid`. Sealing is the caller's,
 * through `withEncryption` around the backend: nothing here changes.
 *
 * ## When the backend is unreachable
 *
 * The flush fails, the state stays as it was, and the next flush ships
 * everything that is still pending — the increment just grows. `status()`
 * says how many updates are waiting, when the last increment went out and
 * what the last failure was, so an application can show "last backed up …".
 *
 * @requires ./backup-car.js - createCARFromBlocks
 * @requires ./restore-cid.js - readBlocksFromCAR, restoreFromBlocks
 */

import * as dagCbor from "@ipld/dag-cbor";
import * as Block from "multiformats/block";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { base58btc } from "multiformats/bases/base58";
import { createCARFromBlocks } from "./backup-car.js";
import { readBlocksFromCAR, restoreFromBlocks } from "./restore-cid.js";

/** What the manifest at an increment's root calls itself. */
export const INCREMENT_KIND = "increment";

/** Bumped when the manifest changes in a way readers must notice. */
export const INCREMENT_VERSION = 1;

/** The persisted state's format. */
export const LIVE_BACKUP_STATE_VERSION = 1;

const DAG_CBOR = dagCbor.code;

/**
 * @typedef {object} LiveBackupState
 * @property {number} v - {@link LIVE_BACKUP_STATE_VERSION}
 * @property {number} sequence - of the last increment shipped; 0 before the first
 * @property {string|null} base - the full backup the increments build on, as the caller named it
 * @property {string|null} previous - the backend's id of the last increment
 * @property {Object<string, { heads: string[] }>} databases - by address: the heads last shipped
 */

/**
 * @typedef {object} IncrementManifest
 * @property {"increment"} kind
 * @property {number} v
 * @property {number} sequence - 1 for the first increment after the base
 * @property {string|null} base - the full backup this builds on, or null
 * @property {string|null} previous - the id of the increment before this one
 * @property {string} createdAt - ISO
 * @property {object} metadata - the shape `restoreFromBlocks` reads: `databases`
 *   with each one's `address`, `name`, `type`, `manifestCID`, `heads`, the
 *   `since` heads it continues from and `entries`, how many it holds
 */

const manifestCIDOf = (database) => database.address.split("/").pop();

/** Blocks keyed the way OrbitDB names them, deduplicated by that name. */
const addBlock = (blocks, name, bytes) => {
  if (!bytes || blocks.has(name)) return;
  blocks.set(name, { cid: CID.parse(name), bytes });
};

/**
 * A database's manifest and access controller: what makes a CAR of entries a
 * backup of *this* database rather than a bag of valid blocks.
 */
async function skeletonBlocks(database, blocks) {
  const manifestCID = manifestCIDOf(database);
  const manifestBytes = await database.log.storage
    .get(manifestCID)
    .catch(() => null);
  addBlock(blocks, manifestCID, manifestBytes);
  if (!manifestBytes) return;
  try {
    const { value } = await Block.decode({
      cid: CID.parse(manifestCID),
      bytes: manifestBytes,
      codec: dagCbor,
      hasher: sha256,
    });
    const accessController = value?.accessController?.replace("/ipfs/", "");
    if (accessController) {
      addBlock(
        blocks,
        accessController,
        await database.log.storage.get(accessController).catch(() => null),
      );
    }
  } catch {
    // A manifest that does not decode has no access controller to find.
  }
}

/** The identity block an entry's signature refers to, from wherever this node has it. */
async function identityBytes(database, hash) {
  const own = database.identity ?? database.log.identity;
  if (own?.hash === hash && own.bytes) return own.bytes;
  const identities = database.log.identities;
  if (identities && typeof identities.getIdentity === "function") {
    const identity = await identities.getIdentity(hash).catch(() => null);
    if (identity?.bytes) return identity.bytes;
  }
  return database.log.storage.get(hash).catch(() => null);
}

/**
 * Every hash reachable from these heads: what a restarted watcher counts as
 * already shipped.
 */
async function reachable(database, heads) {
  const seen = new Set();
  const stack = [...heads];
  while (stack.length) {
    const hash = stack.pop();
    if (seen.has(hash)) continue;
    seen.add(hash);
    const entry = await database.log.get(hash).catch(() => null);
    if (entry?.next) stack.push(...entry.next);
  }
  return seen;
}

/**
 * Walk from the current heads down to what was shipped, and collect what is new.
 *
 * @returns {Promise<{ entries: object[], heads: string[] }>} the new entries,
 *   newest first, and the heads the walk started from
 */
async function newEntries(database, shipped) {
  const heads = await database.log.heads();
  const entries = [];
  const seen = new Set();
  const stack = [...heads];
  while (stack.length) {
    const entry = stack.pop();
    if (!entry || seen.has(entry.hash) || shipped.has(entry.hash)) continue;
    seen.add(entry.hash);
    entries.push(entry);
    for (const hash of entry.next ?? []) {
      if (!seen.has(hash) && !shipped.has(hash))
        stack.push(await database.log.get(hash).catch(() => null));
    }
  }
  return { entries, heads: heads.map((head) => head.hash) };
}

/**
 * Collect one increment across several databases, without shipping it.
 *
 * Exposed for callers that ship by other means; {@link createLiveBackup} is
 * the usual way in.
 *
 * @param {Map<string, { database: object, shipped: Set<string>, collection?: string }>} watched - by address
 * @param {object} options
 * @param {number} options.sequence - the increment's number
 * @param {string|null} [options.base]
 * @param {string|null} [options.previous]
 * @param {Map<string, { bytes: Uint8Array }>} [options.blocks] - blocks of the application's own to carry along
 * @param {() => Date} [options.now]
 * @returns {Promise<null | { blocks: Map<string, { cid: CID, bytes: Uint8Array }>, manifest: IncrementManifest,
 *   root: string, shipped: Map<string, { heads: string[], hashes: string[] }>, entries: number }>}
 *   null when nothing is new
 */
export async function collectIncrement(
  watched,
  {
    sequence,
    base = null,
    previous = null,
    blocks: own,
    now = () => new Date(),
  },
) {
  const blocks = new Map();
  const described = [];
  const shippedNow = new Map();
  let total = 0;

  for (const [address, { database, shipped, collection }] of watched) {
    const { entries, heads } = await newEntries(database, shipped);
    if (entries.length === 0) continue;
    await skeletonBlocks(database, blocks);
    const identities = new Set();
    for (const entry of entries) {
      addBlock(
        blocks,
        entry.hash,
        await database.log.storage.get(entry.hash).catch(() => null),
      );
      if (entry.identity) identities.add(entry.identity);
    }
    for (const hash of identities)
      addBlock(blocks, hash, await identityBytes(database, hash));
    total += entries.length;
    described.push({
      address,
      name: database.name,
      type: database.type,
      manifestCID: manifestCIDOf(database),
      heads,
      since: [...(shipped.heads ?? [])],
      entries: entries.length,
      ...(collection ? { collection } : {}),
    });
    shippedNow.set(address, {
      heads,
      hashes: entries.map((entry) => entry.hash),
    });
  }

  for (const [name, block] of own ?? [])
    if (!blocks.has(name)) blocks.set(name, block);
  if (total === 0 && (own?.size ?? 0) === 0) return null;

  const at = now();
  /** @type {IncrementManifest} */
  const manifest = {
    kind: INCREMENT_KIND,
    v: INCREMENT_VERSION,
    sequence,
    base,
    previous,
    createdAt: at.toISOString(),
    metadata: {
      version: "1.0",
      timestamp: at.getTime(),
      databaseCount: described.length,
      totalBlocks: blocks.size,
      totalEntries: total,
      ...(described[0] ? { manifestCID: described[0].manifestCID } : {}),
      databases: described,
    },
  };
  const rootBytes = dagCbor.encode(manifest);
  const rootCid = CID.createV1(DAG_CBOR, await sha256.digest(rootBytes));
  blocks.set(rootCid.toString(), { cid: rootCid, bytes: rootBytes });
  return {
    blocks,
    manifest,
    root: rootCid.toString(),
    shipped: shippedNow,
    entries: total,
  };
}

/**
 * Read an increment back: every block checked against its CID, the manifest
 * found among them.
 *
 * @param {Uint8Array} carBytes
 * @returns {Promise<{ manifest: IncrementManifest, blocks: Map<string, { bytes: Uint8Array }> }>}
 */
export async function readIncrement(carBytes) {
  const blocks = await readBlocksFromCAR(carBytes, { verify: true });
  for (const [name, { bytes }] of blocks) {
    if (CID.parse(name).code !== DAG_CBOR) continue;
    let value;
    try {
      value = dagCbor.decode(bytes);
    } catch {
      continue;
    }
    if (value?.kind === INCREMENT_KIND) {
      if (value.v !== INCREMENT_VERSION) {
        throw new Error(
          `This increment was written in format ${value.v}, and this build reads ${INCREMENT_VERSION}. ` +
            "Upgrade @le-space/orbitdb-storage-bridge to restore it.",
        );
      }
      return { manifest: value, blocks };
    }
  }
  throw new Error("This CAR holds no increment manifest.");
}

const metadataOf = (source) => source?.metadata ?? source?.manifest?.metadata;

/**
 * Fold a base backup and its increments into one block Map and one metadata:
 * every block of every source, and for each database the heads of the newest
 * source that names it.
 *
 * Sources are `{ metadata | manifest, blocks }`: what `bundleDatabases`,
 * `openAppBackup` and {@link readIncrement} return. Increments are ordered by
 * their `sequence`; the base, if given, comes first.
 *
 * @param {object} params
 * @param {{ metadata?: object, manifest?: object, blocks: Map }} [params.base]
 * @param {{ manifest: IncrementManifest, blocks: Map }[]} params.increments
 * @returns {{ blocks: Map, metadata: object, sequences: number[] }}
 */
export function mergeIncrements({ base, increments = [] }) {
  const ordered = [...increments].sort(
    (a, b) => (a.manifest?.sequence ?? 0) - (b.manifest?.sequence ?? 0),
  );
  const sources = base ? [base, ...ordered] : ordered;
  if (sources.length === 0)
    throw new Error("mergeIncrements needs a base or at least one increment");

  const blocks = new Map();
  const databases = new Map();
  let timestamp = 0;
  for (const source of sources) {
    for (const [name, block] of source.blocks ?? [])
      if (!blocks.has(name)) blocks.set(name, block);
    const metadata = metadataOf(source);
    if (!metadata?.databases) continue;
    timestamp = Math.max(timestamp, Number(metadata.timestamp) || 0);
    for (const d of metadata.databases) {
      const known = databases.get(String(d.address)) ?? {};
      databases.set(String(d.address), {
        ...known,
        address: String(d.address),
        ...(d.name ? { name: d.name } : {}),
        ...(d.type ? { type: d.type } : {}),
        ...(d.manifestCID ? { manifestCID: d.manifestCID } : {}),
        ...(d.collection ? { collection: d.collection } : {}),
        // Later sources are newer: their heads supersede.
        ...(Array.isArray(d.heads) && d.heads.length ? { heads: d.heads } : {}),
        ...(typeof d.entryCount === "number"
          ? { entryCount: d.entryCount }
          : {}),
      });
    }
  }
  const described = [...databases.values()];
  return {
    blocks,
    metadata: {
      version: "1.0",
      timestamp,
      databaseCount: described.length,
      totalBlocks: blocks.size,
      ...(described[0]?.manifestCID
        ? { manifestCID: described[0].manifestCID }
        : {}),
      databases: described,
    },
    sequences: ordered.map((i) => i.manifest?.sequence ?? 0),
  };
}

/**
 * Put a base backup and its increments back into a node, through
 * `restoreFromBlocks`: the union of their blocks, and each database joined at
 * the heads of the newest increment that names it.
 *
 * @param {object} orbitdb
 * @param {object} params
 * @param {{ metadata?: object, manifest?: object, blocks: Map }} [params.base]
 * @param {{ manifest: IncrementManifest, blocks: Map }[]} params.increments
 * @param {object} [params.open] - options for `orbitdb.open` (`encryption`, `AccessController`, …)
 * @param {object} [params.log]
 * @param {Function} [params.onProgress]
 * @returns {Promise<{ blocks: number, databases: object[], sequences: number[] }>}
 */
export async function restoreFromIncrements(
  orbitdb,
  { base, increments = [], open, log, onProgress } = {},
) {
  const { blocks, metadata, sequences } = mergeIncrements({ base, increments });
  const restored = await restoreFromBlocks(orbitdb, blocks, metadata, {
    open,
    log,
    onProgress,
  });
  return { ...restored, sequences };
}

/**
 * Join a base and its increments into a database that is open *now*, without
 * closing it: the blocks go into the log's storage, and each head the newest
 * source names is joined on the open instance.
 *
 * `restoreFromIncrements` reopens the database, as `restoreFromBlocks` does,
 * which leaves an application holding a closed instance. An application whose
 * books are open — a todo list on screen, belege's books — wants the entries
 * to appear in what it already holds. Joining merges: what is here stays.
 *
 * @param {object} database - an open OrbitDB database
 * @param {object} params
 * @param {{ metadata?: object, manifest?: object, blocks: Map }} [params.base]
 * @param {{ manifest: IncrementManifest, blocks: Map }[]} params.increments
 * @returns {Promise<{ joined: number, heads: number, blocks: number }>}
 */
export async function joinIncrements(database, { base, increments = [] } = {}) {
  const { blocks, metadata } = mergeIncrements({ base, increments });
  const address = String(database.address);
  const described = metadata.databases.find(
    (d) => String(d.address) === address,
  );
  if (!described)
    throw new Error("These increments hold nothing for this database.");

  for (const [name, { bytes }] of blocks) {
    const cid = CID.parse(name);
    // OrbitDB names its blocks in base58btc; a CAR in base32. The log reads
    // its own names, and identities are looked up by theirs, so each block
    // goes in under the name its reader will ask for.
    const stored =
      cid.code === DAG_CBOR ? cid.toV1().toString(base58btc) : name;
    await database.log.storage.put(stored, bytes);
  }

  let joined = 0;
  for (const hash of described.heads ?? []) {
    const name = CID.parse(hash).toV1().toString(base58btc);
    const entry = await database.log.get(name).catch(() => null);
    if (entry && (await database.log.joinEntry(entry))) joined++;
  }
  return { joined, heads: (described.heads ?? []).length, blocks: blocks.size };
}

/** A state with nothing shipped yet. */
export const emptyLiveBackupState = () => ({
  v: LIVE_BACKUP_STATE_VERSION,
  sequence: 0,
  base: null,
  previous: null,
  databases: {},
});

/**
 * Keep the databases backed up, increment by increment.
 *
 * @param {object} params
 * @param {object[]|Object<string, object>} [params.databases] - open OrbitDB
 *   databases, as a list or by name; more can be added with `watch()`
 * @param {import("./backends/types.js").StorageBackend} params.backend - where
 *   increments go; wrap it with `withEncryption` to seal them
 * @param {number} [params.every] - ms between flushes while something is
 *   pending; 0 or undefined for none (flush by `after`, or by hand)
 * @param {number} [params.after] - flush once this many updates are pending
 * @param {number} [params.settle=250] - ms to wait after an update before an
 *   `after`-triggered flush, so a burst of writes becomes one increment
 * @param {{ load: () => Promise<LiveBackupState|null|undefined>, save: (state: LiveBackupState) => Promise<void> }} [params.state] -
 *   where the few bytes that survive a restart live; in memory when omitted
 * @param {() => Promise<Map<string, { bytes: Uint8Array }>>|Map} [params.blocks] - blocks of the
 *   application's own to carry in the next increment (receipt files, …)
 * @param {boolean} [params.keep=true] - ask a backend whose handle says
 *   `retained: false` to keep the increment (`pinCid`)
 * @param {(sequence: number, at: Date) => string} [params.name] - the blob's name
 * @param {(shipped: { sequence: number, handle: object, kept?: object, entries: number, blocks: number, bytes: number, at: Date }) => void} [params.onShipped]
 * @param {(error: Error) => void} [params.onError]
 * @param {() => Date} [params.now]
 * @returns {{ watch: Function, unwatch: Function, start: Function, stop: Function,
 *   flush: () => Promise<object|null>, rebase: Function, status: () => object }}
 */
export function createLiveBackup({
  databases,
  backend,
  every = 0,
  after = 0,
  settle = 250,
  state: store,
  blocks: ownBlocks,
  keep = true,
  name = (sequence, at) =>
    `increment-${String(sequence).padStart(6, "0")}-${at.toISOString().replace(/[:.]/g, "-")}.car`,
  onShipped,
  onError,
  now = () => new Date(),
} = {}) {
  if (!backend || typeof backend.putBlob !== "function") {
    throw new Error("createLiveBackup needs a storage backend with putBlob()");
  }

  /** @type {Map<string, { database: object, shipped: Set<string>, collection?: string, off: Function, loaded: boolean }>} */
  const watched = new Map();
  /** @type {LiveBackupState} */
  let state = emptyLiveBackupState();
  let loaded = !store;
  let running = false;
  let pending = 0;
  let inflight = null;
  let again = false;
  let timer = null;
  let settling = null;
  let lastShipped = null;
  let lastError = null;
  let failures = 0;

  const schedule = () => {
    if (!running || !every || timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (pending > 0) flush().catch(() => {});
      schedule();
    }, every);
    timer.unref?.();
  };

  const onUpdate = () => {
    pending++;
    if (!running || !after || pending < after) return;
    if (settling) return;
    settling = setTimeout(() => {
      settling = null;
      flush().catch(() => {});
    }, settle);
    settling.unref?.();
  };

  const watch = (database, collection) => {
    const address = String(database.address);
    if (watched.has(address)) return;
    const handler = () => onUpdate();
    database.events?.on?.("update", handler);
    watched.set(address, {
      database,
      collection,
      shipped: new Set(),
      loaded: false,
      off: () => database.events?.off?.("update", handler),
    });
  };

  const unwatch = (database) => {
    const address = String(database?.address ?? database);
    watched.get(address)?.off();
    watched.delete(address);
  };

  if (Array.isArray(databases)) databases.forEach((d) => watch(d));
  else
    for (const [collection, d] of Object.entries(databases ?? {}))
      watch(d, collection);

  const load = async () => {
    if (!loaded) {
      const saved = await store.load();
      if (saved && saved.v === LIVE_BACKUP_STATE_VERSION)
        state = { ...emptyLiveBackupState(), ...saved };
      loaded = true;
    }
    for (const [address, w] of watched) {
      if (w.loaded) continue;
      const heads = state.databases[address]?.heads ?? [];
      w.shipped = await reachable(w.database, heads);
      w.shipped.heads = heads;
      w.loaded = true;
    }
  };

  const save = async () => {
    // Plain JSON, so a copy is a copy and the caller may keep or serialise it.
    if (store) await store.save(JSON.parse(JSON.stringify(state)));
  };

  const ship = async () => {
    await load();
    const own = typeof ownBlocks === "function" ? await ownBlocks() : ownBlocks;
    const collected = await collectIncrement(watched, {
      sequence: state.sequence + 1,
      base: state.base,
      previous: state.previous,
      blocks: own,
      now,
    });
    const countedPending = pending;
    if (!collected) {
      pending = 0;
      return null;
    }
    const at = now();
    const car = await createCARFromBlocks(collected.blocks, collected.root);
    const handle = await backend.putBlob(car, {
      name: name(collected.manifest.sequence, at),
      contentType: "application/vnd.ipld.car",
    });
    let kept;
    if (
      keep &&
      handle?.retained === false &&
      typeof backend.pinCid === "function"
    ) {
      kept = await backend.pinCid(handle.id, { name: handle.name });
    }

    // Only now, with the bytes out of the house, does the state move.
    state.sequence = collected.manifest.sequence;
    state.previous = String(handle.id ?? handle.cid ?? "");
    for (const [address, { heads, hashes }] of collected.shipped) {
      const w = watched.get(address);
      hashes.forEach((hash) => w.shipped.add(hash));
      w.shipped.heads = heads;
      state.databases[address] = { heads };
    }
    pending = Math.max(0, pending - countedPending);
    await save();

    const shipped = {
      sequence: state.sequence,
      handle,
      ...(kept ? { kept } : {}),
      entries: collected.entries,
      blocks: collected.blocks.size,
      bytes: car.length,
      at,
    };
    lastShipped = shipped;
    lastError = null;
    onShipped?.(shipped);
    return shipped;
  };

  /** Ship what is pending; one flush at a time, and a request during one runs after it. */
  const flush = async () => {
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = (async () => {
      try {
        return await ship();
      } catch (error) {
        failures++;
        lastError = error;
        onError?.(error);
        throw error;
      } finally {
        inflight = null;
        if (again) {
          again = false;
          flush().catch(() => {});
        }
      }
    })();
    return inflight;
  };

  /**
   * A full backup was just made: everything now in the databases counts as
   * shipped, and the increments start again from it.
   *
   * @param {{ base: string|null }} params - what the caller calls the backup (its id, CID, …)
   */
  const rebase = async ({ base }) => {
    await load();
    state = { ...emptyLiveBackupState(), base: base ?? null };
    for (const [address, w] of watched) {
      const heads = (await w.database.log.heads()).map((head) => head.hash);
      w.shipped = await reachable(w.database, heads);
      w.shipped.heads = heads;
      state.databases[address] = { heads };
    }
    pending = 0;
    await save();
  };

  const start = async () => {
    if (running) return;
    running = true;
    await load();
    schedule();
  };

  const stop = async ({ flush: last = false } = {}) => {
    running = false;
    if (timer) clearTimeout(timer);
    if (settling) clearTimeout(settling);
    timer = settling = null;
    if (last) await flush();
  };

  const status = () => ({
    running,
    sequence: state.sequence,
    base: state.base,
    previous: state.previous,
    pending,
    watched: watched.size,
    lastShipped,
    lastError,
    failures,
  });

  return { watch, unwatch, start, stop, flush, rebase, status };
}

export default createLiveBackup;
