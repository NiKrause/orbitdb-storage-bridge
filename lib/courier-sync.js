/**
 * Courier Sync — transport-neutral OrbitDB replication over any byte courier.
 *
 * The load-bearing fact this module builds on is the one this bridge proves
 * with Storacha: OrbitDB replication is "obtain the blocks, join the heads".
 * The courier is interchangeable — Storacha, a LoRa mesh, a QR relay, a file.
 * Design thread: https://github.com/NiKrause/funkpost/issues/1
 * Seam requirements: https://github.com/NiKrause/orbitdb-storage-bridge/issues/50
 *
 * The courier contract (the seam):
 *   courier.send(bytes: Uint8Array): Promise<void>
 *     May be slow on purpose — it resolves when the courier has delivered or
 *     scheduled the message within whatever budget it has (a duty-cycled radio
 *     legally may not hurry). The sync layer treats that as backpressure.
 *   courier.onPayload(cb: (bytes: Uint8Array) => void): () => void
 *     Delivery may be lossy, reordered and duplicated; the protocol tolerates
 *     all three. Returns an unsubscribe function.
 *
 * Wire messages (dag-cbor encoded, one per courier payload):
 *   { v, tag, p, t: "announce", heads: [hash] }
 *   { v, tag, p, t: "want", cids: [hash], have: [hash] }
 *   { v, tag, p, t: "blocks", heads: [hash], blocks: [{ hash, bytes }] }
 *   { v, tag, p, t: "hello" }   is anybody keeping this database out there?
 *   { v, tag, p, t: "here" }    the answer
 * `tag` is a short hash of the database address, so couriers can be shared
 * between databases without cross-talk while the address itself stays off
 * the air (the mesh reads everything).
 *
 * `p` is a four-byte sender id, and it is what makes *presence* possible: a
 * carrier can tell you a radio is in range, which is not the question. The
 * question is whether another program is keeping the same database, and only
 * that program can answer it. Every message carries the id, so ordinary
 * traffic already answers it for free; `hello` exists for the silence in
 * between, when nothing has been written for a while and somebody wants to
 * know before spending airtime on a whole delta.
 *
 * The id is per instance and says nothing about who you are — the tag already
 * names the conversation, and a mesh reads everything. A peer on an older
 * version sends no id and answers no `hello`: its traffic still counts as
 * "somebody is out there" (`lastHeardAgoMs`), it just cannot be counted as a
 * peer. Answers go out immediately and without jitter on purpose; the radio
 * underneath already has a MAC, and backing off twice is worse than once.
 */

/* global CompressionStream, DecompressionStream */
import { CID } from "multiformats/cid";
import { base58btc } from "multiformats/bases/base58";
import { sha256 } from "multiformats/hashes/sha2";
import * as dagCbor from "@ipld/dag-cbor";

export const COURIER_SYNC_VERSION = 1;

const TAG_LENGTH = 8;

// Four bytes of sender id: enough that two peers in one conversation collide
// with probability ~1 in 4 billion, small enough to ride on every message.
const PEER_ID_LENGTH = 4;
// How long a peer stays "present" after its last word. A mesh is slow and a
// budget is rationed, so silence for two minutes is ordinary, not absence.
const PEER_TIMEOUT_MS = 120_000;

// How long to wait for a courier to say a message went out. Deliberately far
// beyond any honest delivery: it is not a deadline, it is the way out of a
// carrier that has stopped answering altogether.
const SEND_TIMEOUT_MS = 300_000;
// How many messages may wait for a carrier that cannot keep up.
const MAX_OUTBOX = 32;

// Wire framing: one prefix byte in front of the dag-cbor message — 0 = raw,
// 1 = gzip. The first-contact bootstrap (manifest + access controller +
// identity + entries) is a couple of kilobytes of dag-cbor full of CIDs and
// signatures, which deflates by roughly half; on a slow, lossy carrier like a
// LoRa mesh that is the difference between a bootstrap that clears the ARQ's
// rounds and one that does not. Small messages (announce, want) skip it.
const GZIP_PREFIX = 1;
const RAW_PREFIX = 0;
const GZIP_THRESHOLD = 256;

const prefixBytes = (flag, body) => {
  const out = new Uint8Array(body.length + 1);
  out[0] = flag;
  out.set(body, 1);
  return out;
};

async function gzipBytes(input) {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(input);
  writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

async function gunzipBytes(input) {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(input);
  writer.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

/** dag-cbor bytes → framed wire bytes (compressed when it helps). */
async function frameMessage(raw) {
  if (typeof CompressionStream === "undefined" || raw.length < GZIP_THRESHOLD) {
    return prefixBytes(RAW_PREFIX, raw);
  }
  try {
    const z = await gzipBytes(raw);
    // Only ship the compressed form if it is actually smaller.
    if (z.length + 1 < raw.length) return prefixBytes(GZIP_PREFIX, z);
  } catch {
    /* fall through to raw */
  }
  return prefixBytes(RAW_PREFIX, raw);
}

/** framed wire bytes → dag-cbor bytes (throws on foreign/garbage input). */
async function unframeMessage(framed) {
  if (!(framed instanceof Uint8Array) || framed.length === 0) {
    throw new Error("empty frame");
  }
  const body = framed.subarray(1);
  if (framed[0] === GZIP_PREFIX) return gunzipBytes(body);
  if (framed[0] === RAW_PREFIX) return body;
  throw new Error("unknown frame prefix"); // not ours
}

/**
 * Short identifier for a database address: first bytes of its sha256.
 * @param {string} address OrbitDB address (/orbitdb/zdpu...)
 * @returns {Promise<Uint8Array>}
 */
export async function databaseTag(address) {
  const digest = await sha256.digest(new TextEncoder().encode(address));
  return digest.digest.slice(0, TAG_LENGTH);
}

function sameTag(a, b) {
  if (!(a instanceof Uint8Array) || a.length !== TAG_LENGTH) return false;
  return a.every((byte, i) => byte === b[i]);
}

/**
 * A sender id for one sync instance: four random bytes, not an identity.
 * @returns {Uint8Array}
 */
function randomPeerId() {
  return globalThis.crypto.getRandomValues(new Uint8Array(PEER_ID_LENGTH));
}

const hex = (bytes) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

function manifestCidOf(address) {
  return address.split("/").pop();
}

function isOplogEntry(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    value.sig &&
    value.payload !== undefined &&
    Array.isArray(value.next),
  );
}

/**
 * What the peer can be assumed to hold, given the heads it named.
 *
 * The heads alone are not a stop set. An OrbitDB entry's `refs` are skip-list
 * back-references that point *past* its parent, so a walk that stops only at
 * the named hashes follows a ref around them and carries on to the root: a peer
 * missing one entry was sent the whole log, measured at 12 blocks and 8742 B
 * where 2 blocks and 1533 B were owed (funkpost's two phones over LoRa, #127).
 * At half a kilobyte a minute that is the difference between a list that syncs
 * and one that cannot.
 *
 * A head is a claim about everything below it, so the closure below those heads
 * is what the peer holds. It is walked over blocks *we* hold; where we cannot
 * follow, that ancestry stays unknown and so stays out of the stop set, which
 * errs towards sending — the direction that costs bytes rather than
 * correctness.
 *
 * Reading the whole ancestry locally to avoid transmitting it is a good trade
 * on any carrier: the reads are a blockstore away, the bytes are airtime.
 */
async function reachableFrom(db, roots) {
  const held = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const hash = queue.shift();
    if (held.has(hash)) continue;
    held.add(hash);
    // The index first, and only then the blocks. `IPFSBlockStorage.get` on a
    // miss waits out a network timeout — measured at 20 s against a Helia node
    // with no peers, which is every phone in the field — and the peer's heads
    // are precisely where misses live: their newest entry is the one we have
    // not got. `has` reads the log's index and answers at once.
    //
    // The rule is already written down twenty lines below, in the closure
    // check, and this walk broke it: 0.14.0 built correct deltas and took
    // twenty seconds to do it, which stalled the exchange past every timeout
    // around it (funkpost#170). The suite could not see it, because its nodes
    // are built offline and a miss there fails instantly.
    if (!(await db.log.has(hash))) continue; // theirs, not ours: stop here
    const bytes = await db.log.storage.get(hash).catch(() => null);
    if (!bytes) continue; // not ours to follow; their ancestry ends here for us
    let value;
    try {
      value = dagCbor.decode(bytes);
    } catch {
      continue;
    }
    if (!isOplogEntry(value)) continue;
    for (const parent of [...value.next, ...(value.refs || [])]) {
      if (!held.has(parent)) queue.push(parent);
    }
  }
  return held;
}

/**
 * Compute the delta a peer with `theirHeads` is missing: entry blocks from our
 * heads down to their heads, the identity blocks those entries reference, and
 * — on first contact (empty `theirHeads`) — the manifest and access controller
 * blocks a fresh peer needs before it can even open the database.
 *
 * Blocks are returned parents-before-children so a receiver can verify the
 * chain without ever reaching for a network that is not there.
 *
 * When the logs have diverged below `theirHeads`, the delta may include blocks
 * the peer already has; applying is idempotent, so that costs bytes, not
 * correctness. (A frontier/bloom exchange can shrink this later.)
 *
 * @param {Object} params
 * @param {Object} params.db An open OrbitDB database
 * @param {Array<string>} [params.theirHeads] Head hashes the peer announced
 * @returns {Promise<{heads: Array<string>, blocks: Array<{hash: string, bytes: Uint8Array}>}>}
 */
export async function createDelta({ db, theirHeads = [] }) {
  const heads = await db.log.heads();
  const headHashes = heads.map((entry) => entry.hash);

  // The peer stands exactly where we do: nothing is owed, and the ancestry
  // need not be read to find that out. This is the steady state between two
  // quiet peers, so it is worth answering before the walk below.
  const named = new Set(theirHeads);
  if (headHashes.length > 0 && headHashes.every((hash) => named.has(hash))) {
    return { heads: headHashes, blocks: [] };
  }

  const stop = await reachableFrom(db, theirHeads);

  const seen = new Set();
  const identityHashes = new Set();
  const entryBlocks = [];
  const queue = headHashes.filter((hash) => !stop.has(hash));

  while (queue.length > 0) {
    const hash = queue.shift();
    if (seen.has(hash) || stop.has(hash)) continue;
    seen.add(hash);

    const bytes = await db.log.storage.get(hash);
    if (!bytes) continue;
    entryBlocks.push({ hash, bytes });

    const value = dagCbor.decode(bytes);
    if (!isOplogEntry(value)) continue;
    if (value.identity) identityHashes.add(value.identity);
    for (const parent of [...value.next, ...(value.refs || [])]) {
      if (!seen.has(parent) && !stop.has(parent)) queue.push(parent);
    }
  }

  const staticBlocks = [];

  // Identity blocks travel with the entries that reference them — a writer the
  // peer has never seen costs one extra block, a known writer costs a
  // duplicate put, which is free.
  //
  // Our own identity carries its block; the log's storage may never have held
  // it. `Identities()` without `ipfs` — what an app with its own identity
  // provider builds, a passkey or a DID — keeps identities in memory, and a
  // Helia blockstore asked for one searches a network that, on the far side of
  // a courier, is not there. The delta would then go out without the block the
  // receiver needs to verify these very entries.
  const ownIdentity = db.identity ?? db.log.identity;
  for (const identityHash of identityHashes) {
    const bytes =
      ownIdentity?.hash === identityHash && ownIdentity.bytes
        ? ownIdentity.bytes
        : await db.log.storage.get(identityHash);
    if (bytes) staticBlocks.push({ hash: identityHash, bytes });
  }

  // First contact additionally needs the manifest and the access controller,
  // or the peer cannot open the address at all.
  if (theirHeads.length === 0) {
    const manifestCid = manifestCidOf(db.address);
    const manifestBytes = await db.log.storage.get(manifestCid);
    if (manifestBytes) {
      staticBlocks.push({ hash: manifestCid, bytes: manifestBytes });
      const manifest = dagCbor.decode(manifestBytes);
      if (manifest && manifest.accessController) {
        const accessCid = manifest.accessController.replace("/ipfs/", "");
        const accessBytes = await db.log.storage.get(accessCid);
        if (accessBytes)
          staticBlocks.push({ hash: accessCid, bytes: accessBytes });
      }
    }
  }

  // Parents before children: entryBlocks were collected heads-first, so the
  // reversed order is oldest-first; static blocks go before everything.
  return {
    heads: headHashes,
    blocks: [...staticBlocks, ...entryBlocks.reverse()],
  };
}

/**
 * Apply a delta to a local blockstore and join its heads into the log.
 *
 * All blocks are put first; then, before any join, the entry chain is checked
 * for closure — every `next`/`refs` reference must be present in the delta or
 * already in the log. `joinEntry` would otherwise reach into block storage for
 * the missing parent and time out against a network that is not there.
 *
 * @param {Object} params
 * @param {Object} params.db An open OrbitDB database
 * @param {{heads: Array<string>, blocks: Array<{hash: string, bytes: Uint8Array}>}} params.delta
 * @returns {Promise<{complete: boolean, joined: number, missing: Array<string>,
 *   entries: Array<Object>, heads: number, outcome: Object}>} `heads` is how
 *   many were offered and `outcome` says what became of each — see `noJoins`.
 */
export async function applyDelta({ db, delta }) {
  return applyDeltaToStores({
    blockstore: dbBlockstore(db),
    log: db.log,
    events: db.events,
    delta,
  });
}

function dbBlockstore(db) {
  // Database instances do not expose their Helia handle; the log's entry
  // storage is Composed(LRU, IPFSBlockStorage) and writing through it lands in
  // the same blockstore `joinEntry` reads from.
  return {
    put: async (hash, bytes) => {
      await db.log.storage.put(hash, bytes);
    },
  };
}

/**
 * Why a head did not join.
 *
 * The join loop below has exactly five exits, and from outside four of them
 * look the same: no join, and — since "synced" only fires when something
 * joined — no event at all. That silence is what left a day of field logs
 * unreadable. Two phones over LoRa received five complete deltas and joined
 * nothing all day, and the log could not say whether the courier was working
 * or broken, because the two findings that matter produce identical silence:
 *
 *   held    the entry was already in the log. Another route brought it first;
 *           the courier delivered something nobody needed, which is wasteful
 *           but correct.
 *   absent  the sender named a head and did not send it. A defect in the
 *           delta it built, and the database does not move.
 *
 * Opposite repairs, one symptom. `malformed` and `refused` should not happen
 * at all; they are counted separately rather than folded into `absent` so
 * that "should not happen" stays falsifiable in a field log.
 *
 * Reported for every delivery through the "applied" event, including the
 * deliveries that came to nothing — those are the interesting ones.
 */
const noJoins = () => ({
  joined: 0,
  held: 0,
  absent: 0,
  malformed: 0,
  refused: 0,
});

async function applyDeltaToStores({ blockstore, log, events, delta }) {
  const heads = delta.heads || [];
  const inDelta = new Map();
  for (const block of delta.blocks || []) {
    inDelta.set(block.hash, block.bytes);
    await blockstore.put(block.hash, block.bytes);
  }

  // Closure check before joining anything. Only the delta itself and the
  // log's own index are consulted — never raw block storage, whose `get`
  // waits out a 30-second network timeout on a miss, against a network that
  // is not there. Anything received in an earlier partial delivery is still
  // in the delta, because the caller keeps blocks parked until completeness.
  const missing = [];
  for (const [, bytes] of inDelta) {
    const value = dagCbor.decode(bytes);
    if (!isOplogEntry(value)) continue;
    for (const parent of [...value.next, ...(value.refs || [])]) {
      if (inDelta.has(parent)) continue;
      if (await log.has(parent)) continue;
      missing.push(parent);
    }
  }
  if (missing.length > 0) {
    return {
      complete: false,
      joined: 0,
      missing,
      entries: [],
      heads: heads.length,
      outcome: noJoins(),
    };
  }

  const outcome = noJoins();
  const entries = [];
  for (const hash of heads) {
    if (await log.has(hash)) {
      outcome.held++;
      continue;
    }
    const bytes = inDelta.get(hash);
    if (!bytes) {
      outcome.absent++;
      continue;
    }
    const value = dagCbor.decode(bytes);
    if (!isOplogEntry(value)) {
      outcome.malformed++;
      continue;
    }
    const entry = { ...value, hash };
    if (!(await log.joinEntry(entry))) {
      outcome.refused++;
      continue;
    }
    outcome.joined++;
    entries.push(entry);
  }

  // Database.applyOperation emits 'update' when the pubsub Sync delivers an
  // entry; a courier delivery is the same event from the application's side.
  if (events && outcome.joined > 0) {
    for (const entry of entries) events.emit("update", entry);
  }

  return {
    complete: true,
    joined: outcome.joined,
    missing: [],
    entries,
    heads: heads.length,
    outcome,
  };
}

/**
 * Attach a database to a courier and keep the two ends converged.
 *
 * Can start without an open database: given `orbitdb` and `address`, the first
 * complete delta (which carries the manifest on first contact) opens the
 * database locally with `sync: false` — replication then runs entirely over
 * the courier, no libp2p involved. `db` stays null until that delta is joined:
 * an application writes as soon as it has a database, and a write racing the
 * bootstrap join can drop out of the log's heads and never be sent.
 *
 * @param {Object} params
 * @param {Object} [params.db] An open database (own-writes side)
 * @param {Object} [params.orbitdb] OrbitDB instance, required when `db` is not given
 * @param {string} [params.address] Database address, required when `db` is not given
 * @param {Object} params.courier The byte courier (see module docs)
 * @param {Object} [params.dbOptions] Extra options for the lazy `orbitdb.open`
 * @param {boolean} [params.announceOnLocalUpdate=true] Announce as soon as a
 *   local write lands. Default keeps the eager behaviour. Set false where the
 *   courier is expensive — a duty-cycled radio, say — and the application would
 *   rather batch several writes and call `announce()` once, deliberately.
 * @param {Uint8Array} [params.peerId] Four-byte sender id. Random per instance
 *   by default, which is what presence wants: it identifies this program on
 *   this carrier for as long as it runs, and nothing beyond that.
 * @param {number} [params.peerTimeoutMs=120000] How long a peer counts as
 *   present after its last word.
 * @param {number} [params.sendTimeoutMs=300000] How long to wait for the
 *   courier to confirm one message. Not a delivery deadline — a duty-cycled
 *   radio is slow by law — but a way out of a carrier that neither delivers
 *   nor fails. 0 waits for ever.
 * @param {number} [params.maxOutbox=32] How many messages may wait for a
 *   carrier that cannot keep up before the oldest is dropped.
 * @returns {Promise<Object>} sync handle: { start, stop, announce, hello,
 *   presence, forgetPeers, db(), events }
 *
 * Events, via `sync.on(name, cb)`:
 *   "message" { direction, type, bytes }  one message on or off the carrier
 *   "synced"  { joined, entries }         the database moved
 *   "applied" { complete, heads, missing, joined, held, absent, malformed,
 *               refused }                 what a `blocks` delivery came to,
 *                                         fired even when it came to nothing
 *   "error"   Error                       a delivery that threw
 */
export async function createCourierSync({
  db = null,
  orbitdb = null,
  address = null,
  courier,
  dbOptions = {},
  rejoinIntervalMs = 15000,
  announceOnLocalUpdate = true,
  peerId = randomPeerId(),
  peerTimeoutMs = PEER_TIMEOUT_MS,
  sendTimeoutMs = SEND_TIMEOUT_MS,
  maxOutbox = MAX_OUTBOX,
}) {
  if (
    !courier ||
    typeof courier.send !== "function" ||
    typeof courier.onPayload !== "function"
  ) {
    throw new Error("A courier with send() and onPayload() is required");
  }
  if (!(peerId instanceof Uint8Array) || peerId.length !== PEER_ID_LENGTH) {
    throw new Error(`peerId must be ${PEER_ID_LENGTH} bytes`);
  }
  const databaseAddress = address || (db && db.address);
  if (!databaseAddress) {
    throw new Error("Either an open db or a database address is required");
  }
  if (!db && !orbitdb) {
    throw new Error(
      "An orbitdb instance is required to open the database on first contact",
    );
  }

  const tag = await databaseTag(databaseAddress);
  const pendingBlocks = new Map(); // hash -> bytes, parked until the database can open
  const peers = new Map(); // sender id (hex) -> when we last heard it
  let lastHeardAt = null; // any traffic for this database, identified or not
  const listeners = { synced: [], applied: [], message: [], error: [] };
  let database = db;
  // Opened on first contact but not handed out: the bootstrap is not in it yet.
  // The protocol works on it all the same, so repair stays incremental.
  let opening = null;
  let unsubscribe = null;
  let offUpdate = null;
  let queue = Promise.resolve();
  let started = false;
  let applying = false;
  let rejoinTimer = null;

  const stopRejoin = () => {
    if (rejoinTimer) {
      clearInterval(rejoinTimer);
      rejoinTimer = null;
    }
  };

  const emit = (event, payload) => {
    for (const cb of listeners[event] || []) {
      try {
        cb(payload);
      } catch {
        // listeners must not break the protocol
      }
    }
  };

  /** One message, actually on its way — framed, counted, handed to the courier. */
  const transmit = async (message) => {
    const raw = dagCbor.encode({
      v: COURIER_SYNC_VERSION,
      tag,
      p: peerId,
      ...message,
    });
    const framed = await frameMessage(raw);
    // Report the wire size — what actually crosses the air and pays airtime.
    emit("message", {
      direction: "out",
      type: message.t,
      bytes: framed.length,
    });
    if (sendTimeoutMs <= 0) return courier.send(framed);
    // A courier that neither delivers nor fails would hold the outbox for
    // good. This is not a delivery deadline — a duty-cycled radio is slow by
    // law, and the bound is far outside any honest delivery — it is the way
    // out of a carrier that has simply stopped answering.
    let timer;
    try {
      await Promise.race([
        courier.send(framed),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `the courier neither delivered nor failed a ${message.t} within ${sendTimeoutMs} ms`,
                ),
              ),
            sendTimeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * The outbox: outgoing messages wait here, in order, and the receive path
   * never waits with them.
   *
   * `courier.send` resolves on *delivery* — an end-to-end ARQ over a carrier
   * that is slow by law. Awaiting it while handling an incoming message made
   * one slow peer stall replication with every other peer: on hardware, a
   * joiner asked fourteen times and got one answer, because the first reply
   * was still in flight and every later message sat behind it in the same
   * chain (funkpost#83). So handlers hand a message to this queue and go back
   * to listening.
   *
   * A reply that has not gone out yet is *superseded* by a newer reply of the
   * same kind to the same peer: the peer asked again, so the newer answer is
   * the one it still needs, and the older one would spend airtime on what it
   * already has. Peers on a version without a sender id cannot be told apart,
   * so nothing of theirs is ever superseded.
   */
  const outbox = [];
  let pumping = null; // the run that is emptying the outbox, while there is one

  const pump = () => {
    if (pumping) return pumping;
    pumping = (async () => {
      try {
        while (outbox.length > 0) {
          const item = outbox.shift();
          try {
            await transmit(item.message);
            item.resolve();
          } catch (error) {
            item.reject(error);
          }
        }
      } finally {
        pumping = null;
      }
    })();
    return pumping;
  };

  /** Resolves when nothing is waiting to go out and nothing is on its way. */
  const outboxQuiet = async () => {
    while (pumping) await pumping.catch(() => {});
  };

  /**
   * Queue a message. Resolves when it has been delivered, so the caller of
   * `announce()` still learns when the radio is done — handlers, which must
   * not wait, use `post()`.
   */
  const send = (message, { to = null } = {}) =>
    new Promise((resolve, reject) => {
      if (to != null) {
        const stale = outbox.findIndex(
          (item) => item.to === to && item.message.t === message.t,
        );
        if (stale >= 0) outbox.splice(stale, 1)[0].resolve();
      }
      if (outbox.length >= maxOutbox) {
        // A carrier that cannot keep up must not make us grow without limit.
        // The oldest waiting message goes: everything here is re-derivable,
        // and a peer that still wants it asks again.
        emit(
          "error",
          new Error(`outbox full (${maxOutbox}) — dropping the oldest message`),
        );
        outbox.shift()?.resolve();
      }
      outbox.push({ message, to, resolve, reject });
      pump();
    });

  /** Start a message on its way without waiting for it to arrive. */
  const post = (message, options) => {
    send(message, options).catch((error) => emit("error", error));
  };

  /**
   * Somebody said something for this database.
   *
   * A message without an id is an older peer: it still proves the air is not
   * empty, which is why `lastHeardAt` moves either way, but it cannot be
   * counted. Our own id comes back when a mesh repeats us, and that proves
   * nothing at all.
   */
  const noteHeard = (id) => {
    const identified = id instanceof Uint8Array && id.length === PEER_ID_LENGTH;
    if (identified && hex(id) === hex(peerId)) return; // a mesh repeating us
    lastHeardAt = Date.now();
    if (identified) peers.set(hex(id), lastHeardAt);
  };

  /** Who sent this, as far as the wire says — null on a peer without an id. */
  const senderOf = (message) =>
    message?.p instanceof Uint8Array && message.p.length === PEER_ID_LENGTH
      ? hex(message.p)
      : null;

  /**
   * Answer a peer asking whether anyone keeps this database. Answering means
   * exactly that — listening on this tag — and nothing about having the log:
   * a peer still bootstrapping is as present as one in step, and the asker
   * finds out which by talking to it.
   */
  const handleHello = (message) => {
    post({ t: "here" }, { to: senderOf(message) });
  };

  /** The database the protocol works on — handed out or not. */
  const local = () => database || opening;

  const ourHeadHashes = async (target = local()) =>
    target ? (await target.log.heads()).map((entry) => entry.hash) : [];

  const announce = async () => {
    if (!local()) {
      // Nothing local yet — not even the manifest. An announce of empty heads
      // cannot get one from a peer whose log is also empty, so first contact
      // is an explicit bootstrap request: a want with an empty frontier makes
      // the peer send its static blocks even when it has no entries at all.
      await send({ t: "want", cids: [], have: [] });
      return;
    }
    await send({ t: "announce", heads: await ourHeadHashes() });
  };

  /**
   * Announce without waiting for delivery — for callers that sit on the
   * receive queue, where waiting for the radio is the head-of-line block this
   * design exists to avoid. `announce()` itself still resolves on delivery,
   * because an application that presses "send" wants to know when it is out.
   */
  const announceSoon = () => {
    announce().catch((error) => emit("error", error));
  };

  /** The database to join a first-contact delta into, opened once the manifest is here. */
  const openIfPossible = async () => {
    if (opening || !orbitdb) return opening;
    const manifestCid = manifestCidOf(databaseAddress);
    if (!pendingBlocks.has(manifestCid)) return null;
    // The blocks must be in the blockstore BEFORE the open: resolving the
    // manifest (and later the access controller) reads through IPFS block
    // storage, and a miss there waits out a 30-second timeout against a
    // network that is not there.
    for (const [hash, bytes] of pendingBlocks) {
      await orbitdb.ipfs.blockstore.put(CID.parse(hash, base58btc), bytes);
    }
    opening = await orbitdb.open(databaseAddress, {
      sync: false,
      ...dbOptions,
    });
    stopRejoin(); // the manifest is here — repair from now on is incremental
    return opening;
  };

  const watchLocalUpdates = () => {
    // Opted out: the application announces when it decides to, not when a write
    // happens. Incoming announces are still answered, so a peer asking for
    // blocks is served — going quiet must not mean going deaf.
    if (!announceOnLocalUpdate) return;
    if (!database || offUpdate) return;
    const onUpdate = () => {
      if (applying) return; // courier-applied entries already end in an announce
      queue = queue
        .then(() => announceSoon())
        .catch((error) => emit("error", error));
    };
    database.events.on("update", onUpdate);
    offUpdate = () => database.events.off("update", onUpdate);
  };

  const handleAnnounce = async (message) => {
    const theirHeads = message.heads || [];
    const target = local();
    if (!target) {
      // Nothing local yet: ask for everything below their heads.
      if (theirHeads.length > 0)
        post(
          { t: "want", cids: theirHeads, have: [] },
          { to: senderOf(message) },
        );
      return;
    }
    const ours = await ourHeadHashes();
    const theirSet = new Set(theirHeads);
    const theyLack = ours.filter((hash) => !theirSet.has(hash));
    const weLack = [];
    for (const hash of theirHeads) {
      if (!(await target.log.has(hash))) weLack.push(hash);
    }
    if (theyLack.length > 0) {
      const delta = await createDelta({ db: target, theirHeads });
      post(
        { t: "blocks", heads: delta.heads, blocks: delta.blocks },
        { to: senderOf(message) },
      );
    }
    if (weLack.length > 0) {
      post({ t: "want", cids: weLack, have: ours }, { to: senderOf(message) });
    }
  };

  const handleWant = async (message) => {
    const target = local();
    if (!target) return;
    const delta = await createDelta({
      db: target,
      theirHeads: message.have || [],
    });
    // Repair mode: a peer may ask for specific blocks (missing parents) that
    // sit below both frontiers; include them explicitly if we hold them.
    const included = new Set(delta.blocks.map((block) => block.hash));
    for (const hash of message.cids || []) {
      if (included.has(hash)) continue;
      const bytes = await target.log.storage.get(hash).catch(() => null);
      if (bytes) delta.blocks.unshift({ hash, bytes });
    }
    post(
      { t: "blocks", heads: delta.heads, blocks: delta.blocks },
      { to: senderOf(message) },
    );
  };

  const handleBlocks = async (message) => {
    for (const block of message.blocks || [])
      pendingBlocks.set(block.hash, block.bytes);
    const target = local() || (await openIfPossible());
    if (!target) return;

    const delta = {
      heads: message.heads || [],
      blocks: Array.from(pendingBlocks, ([hash, bytes]) => ({ hash, bytes })),
    };
    applying = true;
    let result;
    try {
      result = await applyDelta({ db: target, delta });
    } finally {
      applying = false;
    }
    // What the delivery came to, always — including when it came to nothing.
    // A delta that moves the database is a "synced"; a delta that moves
    // nothing is either a courier doing no harm or a courier doing no good,
    // and this is the only line that tells them apart.
    emit("applied", {
      complete: result.complete,
      heads: result.heads,
      missing: result.missing.length,
      ...result.outcome,
    });
    if (!result.complete) {
      post(
        {
          t: "want",
          cids: result.missing,
          have: await ourHeadHashes(target),
        },
        { to: senderOf(message) },
      );
      return;
    }
    pendingBlocks.clear();
    if (!database) {
      // First contact is complete: only now is the database the application's.
      // Handed out in the same synchronous step that emits "synced", so no
      // turn of the event loop sees one without the other.
      database = target;
      opening = null;
      watchLocalUpdates();
    }
    if (result.joined > 0) {
      emit("synced", { joined: result.joined, entries: result.entries });
    }
    // Tells the peer where we now stand — their diff turns empty and the
    // exchange goes quiet; doubles as an end-to-end acknowledgement.
    await announce();
  };

  const handlePayload = (bytes) => {
    queue = queue
      .then(async () => {
        let message;
        try {
          message = dagCbor.decode(await unframeMessage(bytes));
        } catch {
          return; // not ours (foreign traffic, garbage, or a bad frame)
        }
        if (
          !message ||
          message.v !== COURIER_SYNC_VERSION ||
          !sameTag(message.tag, tag)
        )
          return;
        emit("message", {
          direction: "in",
          type: message.t,
          bytes: bytes.length,
        });
        noteHeard(message.p);
        if (message.t === "hello") return handleHello(message);
        if (message.t === "here") return; // the id in it was the whole message
        if (message.t === "announce") return handleAnnounce(message);
        if (message.t === "want") return handleWant(message);
        if (message.t === "blocks") return handleBlocks(message);
      })
      .catch((error) => emit("error", error));
  };

  return {
    get db() {
      return database;
    },
    address: databaseAddress,
    on(event, cb) {
      (listeners[event] = listeners[event] || []).push(cb);
      return () => listeners[event].splice(listeners[event].indexOf(cb), 1);
    },
    async start() {
      if (started) return;
      started = true;
      unsubscribe = courier.onPayload(handlePayload);
      watchLocalUpdates();
      await announce();
      // A joiner that has not bootstrapped keeps re-asking on its own until
      // the database opens — so a bootstrap the lossy channel dropped heals
      // without the user pressing "join" again. Cleared the moment the
      // database opens (openIfPossible) or on stop().
      if (!database && orbitdb && rejoinIntervalMs > 0) {
        rejoinTimer = setInterval(() => {
          if (local() || !started) {
            stopRejoin();
            return;
          }
          queue = queue
            .then(() => announceSoon())
            .catch((error) => emit("error", error));
        }, rejoinIntervalMs);
      }
    },
    /** Re-announce — recovery poke after suspected loss. */
    announce: () => announce(),
    /** This instance's sender id, as it appears on the wire. */
    peerId: hex(peerId),
    /**
     * Ask whether anybody out there keeps this database, and let them answer.
     *
     * Two small messages, and the only way to tell an app apart from a radio:
     * a carrier reports the radios in range, which says nothing about whether
     * a program on the other end is listening for *this* database. Call it
     * before spending airtime on a delta nobody is waiting for; read the
     * answer from `presence()` a moment later, since an answer has to travel.
     *
     * Requires `start()` — a sync that is not subscribed hears no answers.
     */
    hello: () => send({ t: "hello" }),
    /**
     * Who has been heard lately, and when the air last carried anything at
     * all for this database.
     *
     * Not a connection count: this carrier has no connections. It is the
     * honest form of the question — these peers said something recently.
     *
     * @returns {{peers: Array<{id: string, agoMs: number}>, lastHeardAgoMs: number|null}}
     */
    presence() {
      const at = Date.now();
      for (const [id, seen] of peers) {
        if (at - seen > peerTimeoutMs) peers.delete(id);
      }
      return {
        peers: [...peers.entries()].map(([id, seen]) => ({
          id,
          agoMs: at - seen,
        })),
        lastHeardAgoMs: lastHeardAt == null ? null : at - lastHeardAt,
      };
    },
    /**
     * Forget everyone heard so far.
     *
     * For when the carrier itself changes underneath — a radio switched to
     * another channel reaches other people, and peers heard on the old one
     * are not evidence about the new one.
     */
    forgetPeers() {
      peers.clear();
      lastHeardAt = null;
    },
    /**
     * Wait until in-flight message handling settles (mainly for tests).
     *
     * Both directions: the receive queue, and whatever it handed to the
     * outbox. Since handlers no longer wait for the radio, a settled receive
     * queue on its own would mean "decided", not "sent".
     */
    async idle() {
      await queue;
      await outboxQuiet();
      await queue;
    },
    async stop() {
      started = false;
      stopRejoin();
      if (unsubscribe) unsubscribe();
      if (offUpdate) offUpdate();
      unsubscribe = null;
      offUpdate = null;
      await queue.catch(() => {});
    },
  };
}
