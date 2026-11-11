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
 * (`{ kind: "increment", v: 1, sequence, base, previous, createdAt, metadata }`),
 * so a single blob is self-describing. Every increment carries each database's
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
 * ## A store that answers "pending" and refuses later
 *
 * Aleph takes a STORE with "pending" and may reject it minutes later – a file
 * its nodes could not fetch, credit that ran out. An increment shipped under
 * such an answer has moved the chain on, and nothing would ship its content
 * again. So the chain also remembers how far the store has *confirmed* it
 * (`kept`) and the increments shipped since (`unconfirmed`); `reconcile()`
 * asks about those again and, when one turns out refused or unknown, goes
 * back to `kept`: the next flush ships everything since, under the next
 * number after the last one kept, so a restore finds no gap. The bookkeeping
 * is `advanceConfirmation` / `reconcileConfirmation`, exported for an
 * application that keeps its own chain state.
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
import {
  readBlocksFromCAR,
  restoreFromBlocks,
  entryDatabaseId,
  standalone,
} from "./restore-cid.js";

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
 * @property {{ sequence: number, previous: string|null, databases: object }|null} [kept] - the last
 *   point the store confirmed; null before any
 * @property {Array<{ sequence: number, previous: string|null, databases: object, cid: string }>} [unconfirmed] -
 *   increments shipped since that the store has not confirmed, oldest first
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
      // Every source's heads, not only the newest's: a join is a merge, a
      // stale head costs nothing, and a branch only the older source saw —
      // two devices shipping in parallel, or a store that renumbered — is
      // kept instead of dropped.
      const heads = [
        ...new Set([
          ...(known.heads ?? []),
          ...(Array.isArray(d.heads) ? d.heads : []),
        ]),
      ];
      databases.set(String(d.address), {
        ...known,
        address: String(d.address),
        ...(d.name ? { name: d.name } : {}),
        ...(d.type ? { type: d.type } : {}),
        ...(d.manifestCID ? { manifestCID: d.manifestCID } : {}),
        ...(d.collection ? { collection: d.collection } : {}),
        ...(heads.length ? { heads } : {}),
        ...(typeof d.entryCount === "number"
          ? { entryCount: d.entryCount }
          : {}),
      });
    }
  }
  const described = [...databases.values()];
  const sequences = ordered.map((i) => i.manifest?.sequence ?? 0);
  // A chain with a hole restores the heads of the newer part onto entries
  // nobody has: the join then searches the network for each missing block,
  // thirty seconds at a time. Named here, so a caller can refuse up front.
  const gaps = [];
  const duplicates = [];
  for (let i = 1; i < sequences.length; i++) {
    if (sequences[i] === sequences[i - 1]) duplicates.push(sequences[i]);
    for (let missing = sequences[i - 1] + 1; missing < sequences[i]; missing++)
      gaps.push(missing);
  }
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
    sequences,
    gaps,
    duplicates,
  };
}

/** Refuse a chain with holes, unless the caller said it knows. */
function assertContiguous({ gaps, duplicates }, allowGaps) {
  if (allowGaps) return;
  if (gaps.length) {
    throw new Error(
      `The increments have a gap: sequence ${gaps.join(", ")} missing. Fetch them, or pass allowGaps: true to join what is there.`,
    );
  }
  if (duplicates.length) {
    throw new Error(
      `Two increments carry the same sequence ${[...new Set(duplicates)].join(", ")}: the chain was written twice, or renumbered. Pass allowGaps: true to join them all.`,
    );
  }
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
 * @param {boolean} [params.allowGaps=false] - join a chain with missing or
 *   duplicate sequence numbers instead of refusing it
 * @returns {Promise<{ blocks: number, databases: object[], sequences: number[], gaps: number[], duplicates: number[] }>}
 *   `gaps` and `duplicates`: the sequence numbers `mergeIncrements` found missing
 *   or twice — both empty unless `allowGaps` let such a chain through.
 */
export async function restoreFromIncrements(
  orbitdb,
  { base, increments = [], open, log, onProgress, allowGaps = false } = {},
) {
  const merged = mergeIncrements({ base, increments });
  assertContiguous(merged, allowGaps);
  const { blocks, metadata, sequences } = merged;
  const restored = await restoreFromBlocks(orbitdb, blocks, metadata, {
    open,
    log,
    onProgress,
  });
  return {
    ...restored,
    sequences,
    gaps: merged.gaps,
    duplicates: merged.duplicates,
  };
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
 * @param {{ put: (cid: CID, bytes: Uint8Array) => Promise<unknown> }} [params.blockstore] -
 *   where the application's own (non-dag-cbor) blocks go, e.g. `orbitdb.ipfs.blockstore`;
 *   without it they are counted in `skippedRaw` and left out
 * @param {boolean} [params.allowGaps=false]
 * @returns {Promise<{ joined: number, heads: number, blocks: number, gaps: number[], duplicates: number[], skippedRaw?: number }>}
 *   `gaps`: sequence numbers missing from the chain; `duplicates`: sequence
 *   numbers carried by more than one increment (two devices numbering on
 *   their own) — both empty unless the join was told `allowGaps`
 */
export async function joinIncrements(
  database,
  { base, increments = [], blockstore, allowGaps = false } = {},
) {
  const merged = mergeIncrements({ base, increments });
  assertContiguous(merged, allowGaps);
  const { blocks, metadata } = merged;
  const address = String(database.address);
  const described = metadata.databases.find(
    (d) => String(d.address) === address,
  );
  if (!described)
    throw new Error("These increments hold nothing for this database.");

  let skippedRaw = 0;
  let skippedForeign = 0;
  for (const [name, { bytes }] of blocks) {
    const cid = CID.parse(name);
    if (cid.code !== DAG_CBOR) {
      // The application's own blocks (receipt files): not the log's, and the
      // log's storage refuses their base32 names. They go where Helia looks,
      // when the caller says where that is.
      if (blockstore) await blockstore.put(cid, bytes);
      else skippedRaw++;
      continue;
    }
    // An entry belongs to the database it names. A chain merged for several
    // databases carries all of their entries, and writing every one into every
    // database multiplies the writes by the database count — in a browser each
    // is an IndexedDB transaction (#152). Blocks that are not entries — the
    // manifest, the access controller, an identity — have no database of their
    // own and are looked up by their own name here, so they still go in.
    const belongsTo = entryDatabaseId(bytes);
    if (belongsTo !== null && belongsTo !== address) {
      skippedForeign++;
      continue;
    }
    // OrbitDB names its blocks in base58btc; a CAR in base32. The log reads
    // its own names, and identities are looked up by theirs, so each block
    // goes in under the name its reader will ask for.
    await database.log.storage.put(
      cid.toV1().toString(base58btc),
      standalone(bytes),
    );
  }

  let joined = 0;
  for (const hash of described.heads ?? []) {
    const name = CID.parse(hash).toV1().toString(base58btc);
    const entry = await database.log.get(name).catch(() => null);
    if (entry && (await database.log.joinEntry(entry))) joined++;
  }
  return {
    joined,
    heads: (described.heads ?? []).length,
    blocks: blocks.size,
    // What the chain looked like, for a caller that joined it with allowGaps.
    gaps: merged.gaps,
    duplicates: merged.duplicates,
    ...(skippedRaw ? { skippedRaw } : {}),
    ...(skippedForeign ? { skippedForeign } : {}),
  };
}

/**
 * How long an increment may be unknown to the store before that counts as
 * refused: Aleph answers 404 for a message that has not reached the node yet.
 */
export const UNKNOWN_GRACE_MS = 10 * 60_000;

/** Statuses that mean the store does not keep a blob. */
export const NOT_KEPT = Object.freeze(["rejected", "unknown", "forgotten"]);

/**
 * How far a store has confirmed a chain, and what was shipped since.
 *
 * A *point* is whatever the caller needs to go back to – `sequence`,
 * `previous` and its own fields (the heads shipped by then, a count of
 * files, …). It is kept as given, never read here beyond `sequence`.
 *
 * @typedef {object} Confirmation
 * @property {object|null} kept - the last point the store confirmed
 * @property {Array<object & { cid: string }>} pending - points shipped since, oldest first
 */

/**
 * The confirmation after an increment was shipped.
 *
 * `processed` with nothing open before it moves `kept` to this point; any
 * other answer puts the point aside as pending, with the blob's id to ask
 * about later.
 *
 * @param {Confirmation|null|undefined} confirmation
 * @param {object} point - where the chain stands with this increment
 * @param {string} cid - the increment's id in the store
 * @param {string} [status="processed"] - the store's answer
 * @returns {Confirmation}
 */
export function advanceConfirmation(
  confirmation,
  point,
  cid,
  status = "processed",
) {
  const pending = confirmation?.pending ?? [];
  if (status === "processed" && pending.length === 0) {
    return { kept: point, pending: [] };
  }
  return {
    kept: confirmation?.kept ?? null,
    pending: [...pending, { ...point, cid }],
  };
}

/**
 * The confirmation by what the store says now.
 *
 * Walks the pending points oldest first: a `processed` one moves `kept` on; a
 * refused, unknown or forgotten one ends it – everything pending is dropped
 * and `rewind` is the point to go back to (`null`: before anything was
 * confirmed, the caller's own start). A point the store has not decided on
 * stops the walk. `gap` says an increment *after* a refused one is kept: a
 * restore cannot cross that, and only a new full backup mends it.
 *
 * @param {Confirmation} confirmation
 * @param {(cid: string) => string|undefined} statusOf - the store's word on a blob, if known
 * @returns {{ kept: object|null, pending: object[], changed: boolean, rewound: boolean, rewind: object|null, gap: boolean }}
 */
export function reconcileConfirmation(confirmation, statusOf) {
  let kept = confirmation?.kept ?? null;
  const pending = [...(confirmation?.pending ?? [])];
  let changed = false;
  while (pending.length) {
    const status = statusOf(pending[0].cid);
    if (status === "processed") {
      const point = { ...pending.shift() };
      delete point.cid;
      kept = point;
      changed = true;
      continue;
    }
    if (status && NOT_KEPT.includes(status)) {
      const gap = pending
        .slice(1)
        .some((point) => statusOf(point.cid) === "processed");
      return {
        kept,
        pending: [],
        changed: true,
        rewound: true,
        rewind: kept,
        gap,
      };
    }
    break;
  }
  return { kept, pending, changed, rewound: false, rewind: null, gap: false };
}

/** A state with nothing shipped yet. */
export const emptyLiveBackupState = () => ({
  v: LIVE_BACKUP_STATE_VERSION,
  sequence: 0,
  base: null,
  previous: null,
  databases: {},
  kept: null,
  unconfirmed: [],
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
 *   `retained: false` to keep the increment (`pinCid`). A handle that already
 *   carries the store's answer (`status`, as an Aleph upload with a signing
 *   pin does: the STORE went with the file) is not pinned a second time; its
 *   answer is the one followed and recorded
 * @param {(sequence: number, at: Date) => string} [params.name] - the blob's name
 * @param {(shipped: { sequence: number, handle: object, kept?: object, entries: number, blocks: number, bytes: number, at: Date }) => void} [params.onShipped]
 * @param {(error: Error) => void} [params.onError]
 * @param {(kept: object, handle: object) => Promise<object>} [params.confirm] -
 *   follow a backend's answer before the increment counts as shipped: Aleph
 *   answers `pending` first and may reject later (no credit, no grant). Given
 *   `(kept, handle)`, return the settled answer; `status: "rejected"` fails the
 *   flush and the state stays, so the next one ships it all again.
 * @param {() => Date} [params.now]
 * @returns {{ watch: Function, unwatch: Function, start: Function, stop: Function, close: Function,
 *   flush: () => Promise<object|null>, rebase: Function, reconcile: Function, status: () => object }}
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
  confirm: confirmKept,
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
  /** A reconcile applying its answers: a flush waits for it, or it would ship from a state about to move. */
  let reconciling = null;
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

  /** A flush soon, once the writes of this moment have settled. */
  const scheduleFlush = () => {
    if (!running || settling) return;
    settling = setTimeout(() => {
      settling = null;
      flush().catch(() => {});
    }, settle);
    settling.unref?.();
  };

  const onUpdate = () => {
    pending++;
    if (after && pending >= after) scheduleFlush();
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

  /** Stop, and let go of the databases: no listener keeps counting after this. */
  const close = async ({ flush: last = false } = {}) => {
    await stop({ flush: last });
    for (const w of watched.values()) w.off();
    watched.clear();
  };

  if (Array.isArray(databases)) databases.forEach((d) => watch(d));
  else
    for (const [collection, d] of Object.entries(databases ?? {}))
      watch(d, collection);

  const load = async () => {
    if (!loaded) {
      const saved = await store.load();
      if (saved) {
        // A state this build does not read must not be dropped: starting at 1
        // again would ship everything twice under sequence numbers the chain
        // already has.
        if (saved.v !== LIVE_BACKUP_STATE_VERSION) {
          throw new Error(
            `The live backup's state is version ${saved.v}, and this build reads ${LIVE_BACKUP_STATE_VERSION}. Upgrade @le-space/orbitdb-storage-bridge, or clear the state and rebase.`,
          );
        }
        state = { ...emptyLiveBackupState(), ...saved };
      }
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
    if (reconciling) await reconciling.catch(() => {});
    await load();
    // Counted before the walk: OrbitDB appends before it emits `update`, so
    // every update counted here is in the log the walk is about to read, and
    // one that fires during the walk stays pending for the next flush.
    const countedPending = pending;
    const own = typeof ownBlocks === "function" ? await ownBlocks() : ownBlocks;
    const collected = await collectIncrement(watched, {
      sequence: state.sequence + 1,
      base: state.base,
      previous: state.previous,
      blocks: own,
      now,
    });
    if (!collected) {
      pending = Math.max(0, pending - countedPending);
      return null;
    }
    const at = now();
    const car = await createCARFromBlocks(collected.blocks, collected.root);
    const handle = await backend.putBlob(car, {
      name: name(collected.manifest.sequence, at),
      contentType: "application/vnd.ipld.car",
    });
    let kept;
    if (typeof handle?.status === "string") {
      // The upload carried its own keep request (a signed Aleph upload): a
      // second one through pinCid would be paid twice, and would take the
      // path whose STOREs the nodes could not fetch (2026-11).
      kept = {
        id: handle.id,
        backend: handle.backend,
        retained: handle.retained === true,
        status: handle.status,
        ...(handle.itemHash ? { itemHash: handle.itemHash } : {}),
      };
    } else if (
      keep &&
      handle?.retained === false &&
      typeof backend.pinCid === "function"
    ) {
      kept = await backend.pinCid(handle.id, { name: handle.name });
    }
    if (kept) {
      if (confirmKept && kept.status !== "processed")
        kept = await confirmKept(kept, handle);
      if (kept?.status === "rejected") {
        throw new Error(
          `The store refused to keep increment ${collected.manifest.sequence}${kept.errorCode != null ? ` (${kept.errorCode})` : ""}: it was uploaded but is not kept.`,
        );
      }
    }

    // Only now, with the bytes out of the house, does the state move — and
    // all of it at once, so a database unwatched during the upload cannot
    // leave it half moved.
    const moved = [];
    for (const [address, { heads, hashes }] of collected.shipped) {
      const w = watched.get(address);
      if (w) moved.push({ address, w, heads, hashes });
    }
    state.sequence = collected.manifest.sequence;
    state.previous = String(handle.id ?? handle.cid ?? "");
    for (const { address, w, heads, hashes } of moved) {
      hashes.forEach((hash) => w.shipped.add(hash));
      w.shipped.heads = heads;
      state.databases[address] = { heads };
    }
    // How far the store has confirmed the chain: a pending answer is put
    // aside, so `reconcile()` can go back if it is refused later.
    const confirmation = advanceConfirmation(
      { kept: state.kept, pending: state.unconfirmed },
      {
        sequence: state.sequence,
        previous: state.previous,
        databases: JSON.parse(JSON.stringify(state.databases)),
        // When it went out: a store that does not know a message yet
        // (Aleph's 404 before it has propagated) is not a refusal.
        shippedAt: at.toISOString(),
      },
      state.previous,
      kept?.status ?? "processed",
    );
    state.kept = confirmation.kept;
    state.unconfirmed = confirmation.pending;
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
          if (running) flush().catch(() => {});
        }
      }
    })();
    return inflight;
  };

  /**
   * Everything now in the databases counts as shipped.
   *
   * With `base`, a full backup was just made: the increments start again at 1
   * from it. Without, the content arrived by other means — a restore joined
   * into the open databases — and must not be sent out again, while the
   * numbering carries on from where it was.
   *
   * @param {{ base?: string|null }} [params] - what the caller calls the full backup (its id, CID, …)
   */
  const rebase = async ({ base } = {}) => {
    // Not under a flush: ship() would write the pre-rebase state back.
    if (inflight) await inflight.catch(() => {});
    await load();
    if (base !== undefined)
      state = { ...emptyLiveBackupState(), base: base ?? null };
    for (const [address, w] of watched) {
      const heads = (await w.database.log.heads()).map((head) => head.hash);
      w.shipped = await reachable(w.database, heads);
      w.shipped.heads = heads;
      state.databases[address] = { heads };
    }
    // A full backup is where the chain is kept from.
    if (base !== undefined) {
      state.kept = {
        sequence: 0,
        previous: null,
        databases: JSON.parse(JSON.stringify(state.databases)),
      };
      state.unconfirmed = [];
    }
    pending = 0;
    await save();
  };

  /**
   * Ask the store again about the increments it had not confirmed, and go
   * back to the last confirmed point when one was refused.
   *
   * @param {(cid: string, point: object) => Promise<string|undefined>|string|undefined} statusOf -
   *   the store's word on an increment by its id: `processed`, `pending`,
   *   `rejected`, `unknown`, `forgotten` (for Aleph: `messageStatus` on the
   *   STORE's item hash, which the caller kept from `onShipped`)
   * @returns {Promise<{ changed: boolean, rewound: boolean, gap: boolean, sequence: number }>}
   *   `gap`: an increment after a refused one is kept – make a full backup and `rebase({ base })`
   */
  const reconcile = async (statusOf) => {
    if (inflight) await inflight.catch(() => {});
    await load();
    // The answers first, which takes network time; a flush may run meanwhile.
    const answers = new Map();
    const asked = Date.now();
    for (const point of state.unconfirmed ?? []) {
      let answer = await statusOf(point.cid, point);
      // Not known yet is not refused while the message may still be on its way.
      const age = point.shippedAt ? asked - Date.parse(point.shippedAt) : Infinity;
      if (answer === "unknown" && age < UNKNOWN_GRACE_MS) answer = undefined;
      answers.set(point.cid, answer);
    }
    // Then applied to the state as it is now, with no flush running and none
    // starting until it is done: a point shipped meanwhile has no answer, so
    // the walk stops before it – or, when an earlier one was refused, it goes
    // back with the rest.
    if (inflight) await inflight.catch(() => {});
    let release;
    let wentBack = false;
    reconciling = new Promise((resolve) => (release = resolve));
    try {
      const now_ = reconcileConfirmation(
        { kept: state.kept ?? null, pending: state.unconfirmed ?? [] },
        (cid) => answers.get(cid),
      );
      if (!now_.changed)
        return {
          changed: false,
          rewound: false,
          gap: false,
          sequence: state.sequence,
        };
      state.kept = now_.kept;
      state.unconfirmed = now_.pending;
      if (now_.rewound) {
        const back = now_.rewind ?? {
          sequence: 0,
          previous: null,
          databases: {},
        };
        state.sequence = back.sequence;
        state.previous = back.previous;
        state.databases = JSON.parse(JSON.stringify(back.databases ?? {}));
        for (const [address, w] of watched) {
          const heads = state.databases[address]?.heads ?? [];
          w.shipped = await reachable(w.database, heads);
          w.shipped.heads = heads;
        }
        // Nothing announces what has to go again: count it, so a flush ships it.
        pending = Math.max(pending, 1);
        wentBack = true;
      }
      await save();
      return {
        changed: true,
        rewound: now_.rewound,
        gap: now_.gap,
        sequence: state.sequence,
      };
    } finally {
      reconciling = null;
      release();
      // Only once the flush can see the state it is to ship from.
      if (wentBack && running && (after || every)) scheduleFlush();
    }
  };

  const start = async () => {
    if (running) return;
    running = true;
    await load();
    schedule();
    // What was written before the watcher came — after a restart, or before
    // the archive was switched on — is as unshipped as anything, and nothing
    // would announce it. So one flush soon, which ships nothing if there is
    // nothing.
    if (after || every) scheduleFlush();
  };

  const stop = async ({ flush: last = false } = {}) => {
    running = false;
    if (timer) clearTimeout(timer);
    if (settling) clearTimeout(settling);
    timer = settling = null;
    // A flush asked for during one runs after it; the caller gets its own.
    if (last) {
      if (inflight) await inflight.catch(() => {});
      await flush();
    }
  };

  const status = () => ({
    running,
    sequence: state.sequence,
    base: state.base,
    previous: state.previous,
    pending,
    unconfirmed: (state.unconfirmed ?? []).length,
    keptSequence: state.kept?.sequence ?? null,
    watched: watched.size,
    lastShipped,
    lastError,
    failures,
  });

  return {
    watch,
    unwatch,
    start,
    stop,
    close,
    flush,
    rebase,
    reconcile,
    status,
  };
}

export default createLiveBackup;
