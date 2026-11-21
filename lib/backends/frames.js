/**
 * @fileoverview The envelope in frames (`OSBE` version 2), so a sealed file can
 * be opened as it arrives (#187).
 *
 * Version 1 (./encryption.js) seals the whole blob under one AES-GCM nonce:
 * nothing can be read before the last byte is there, and opening holds the
 * ciphertext and the plaintext at once. A backup of several hundred MB is more
 * than a phone's browser tab may use. Version 2 seals the same bytes in frames
 * of a fixed size, each one opened by itself, so a reader holds one frame.
 *
 * ## The file
 *
 * ```
 * "OSBE" | 2 | frame size | salt | key check | frame 0 | frame 1 | … | last frame
 *   4      1      4 (BE)     32       16
 * ```
 *
 * - **A key per file.** `HKDF-SHA256(key, salt, info)` with `info` =
 *   `"OSBE v2"` ‖ frame size ‖ SHA-256(context). The caller's key seals many
 *   files; the key that seals frames seals one, so a counter is a nonce that
 *   cannot repeat under it. `context` is the caller's (an application backup
 *   passes its header): a file opened with another context does not open.
 * - **The nonce** of a frame is its index (11 bytes, big-endian) and a mark:
 *   `0` a frame with more behind it, `1` the last frame, `2` the key check.
 * - **The additional data** of a frame is the 41 bytes in front of the key
 *   check, the index (8 bytes) and the mark. The index is bound twice, the
 *   header once: a frame of another file, or of another place in this one,
 *   does not open.
 * - **The key check** is the tag of an empty plaintext. A wrong key is known
 *   there, before a frame is opened, and a frame that does not open later is
 *   damage and never the key.
 * - **Frames** hold `frame size` bytes of plaintext and a 16-byte tag; only
 *   the last may hold fewer (none at all only in an empty file). There are no
 *   lengths in the file: the reader cuts at the frame size and opens what is
 *   left at the end as the last frame.
 *
 * ## What a reader may rely on
 *
 * Every chunk {@link openFrames} yields is authentic and in its place. A frame
 * is opened as "not the last" only once a byte behind it has arrived, and the
 * last one only once the source has ended, so a file cut short, at a frame's
 * edge or inside one, fails at the frame where it was cut, and so does one
 * with anything appended. **What it cannot say before the end is that the end
 * will come**: a reader that acts on chunks as they arrive (blocks into a
 * blockstore) must keep what cannot be taken back (joining heads) for after
 * the iteration finished without an error.
 *
 * ## The key
 *
 * Version 1 takes the caller's `encrypt` and `decrypt`. Frames cannot: the
 * nonce and the additional data are the format's to choose, not the caller's.
 * So this takes the key itself, 32 bytes or a `CryptoKey` for HKDF, for the
 * length of the call. It derives from it, and keeps nothing.
 *
 * @module backends/frames
 */

import { BackendError } from "./types.js";
import { ENVELOPE_MAGIC } from "./encryption.js";

/** The envelope version this module writes and reads. */
export const FRAMED_VERSION = 2;

/** Plaintext bytes in a frame, unless the writer says otherwise. */
export const DEFAULT_FRAME_SIZE = 1024 * 1024;

/** The largest frame a reader allocates for: a header may not ask for more. */
export const MAX_FRAME_SIZE = 16 * 1024 * 1024;

const SALT_BYTES = 32;
const TAG_BYTES = 16;
/** magic ‖ version ‖ frame size ‖ salt. */
export const FRAMED_HEADER_BYTES = ENVELOPE_MAGIC.length + 1 + 4 + SALT_BYTES;
/** What stands in front of the first frame. */
export const FRAMED_PREAMBLE_BYTES = FRAMED_HEADER_BYTES + TAG_BYTES;

const MORE = 0;
const LAST = 1;
const KEY_CHECK = 2;

const INFO_PREFIX = new TextEncoder().encode("OSBE v2");

/**
 * A sealed file that could not be opened, with the reason as `reason` and, for
 * a frame, its index as `frame`.
 *
 * - `wrong-key`: the key check failed. Another key, or another context.
 * - `frame`: frame `frame` does not open. It was altered, moved, belongs to
 *   another file, or the file ends where it should not.
 * - `cut-short`: the file ends before frame `frame` is complete.
 * - `header`: not a framed envelope this build reads.
 */
export class FrameError extends BackendError {
  /**
   * @param {"wrong-key"|"frame"|"cut-short"|"header"} reason
   * @param {string} message
   * @param {{ frame?: number, cause?: unknown }} [details]
   */
  constructor(reason, message, { frame, cause } = {}) {
    super("INVALID_BACKEND", message);
    this.name = "FrameError";
    if (cause !== undefined) this.cause = cause;
    this.reason = reason;
    if (frame !== undefined) this.frame = frame;
  }
}

/** The envelope version these bytes start with, or null when they are none. */
export function envelopeVersion(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length < ENVELOPE_MAGIC.length + 1
  )
    return null;
  if (!ENVELOPE_MAGIC.every((byte, index) => bytes[index] === byte))
    return null;
  return bytes[ENVELOPE_MAGIC.length];
}

/** Do these bytes start a framed envelope? */
export function isFramed(bytes) {
  return envelopeVersion(bytes) === FRAMED_VERSION;
}

/**
 * Bytes as they come, taken out in pieces of a chosen length, without copying
 * what is already there each time more arrives.
 */
export class ByteQueue {
  constructor() {
    /** @type {Uint8Array[]} */
    this.chunks = [];
    this.length = 0;
  }

  /** @param {Uint8Array} chunk */
  push(chunk) {
    if (!chunk?.length) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  /**
   * The first `n` bytes, removed from the queue.
   *
   * @param {number} n
   * @returns {Uint8Array}
   */
  take(n) {
    if (n > this.length) throw new RangeError("ByteQueue: not that many bytes");
    const first = this.chunks[0];
    // The common case with large chunks: no copy at all.
    if (first && first.length >= n) {
      this.length -= n;
      if (first.length === n) {
        this.chunks.shift();
        return first;
      }
      this.chunks[0] = first.subarray(n);
      return first.subarray(0, n);
    }
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const chunk = this.chunks[0];
      const want = n - at;
      if (chunk.length <= want) {
        out.set(chunk, at);
        at += chunk.length;
        this.chunks.shift();
      } else {
        out.set(chunk.subarray(0, want), at);
        this.chunks[0] = chunk.subarray(want);
        at += want;
      }
    }
    this.length -= n;
    return out;
  }
}

/** @param {Uint8Array | AsyncIterable<Uint8Array> | Iterable<Uint8Array>} source */
async function* chunksOf(source) {
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  yield* source;
}

async function hkdfKey(key) {
  if (key instanceof Uint8Array) {
    if (key.length !== 32) {
      throw new BackendError(
        "INVALID_BACKEND",
        `A framed envelope is sealed with a 32-byte key; this one has ${key.length}`,
      );
    }
    return globalThis.crypto.subtle.importKey("raw", key, "HKDF", false, [
      "deriveKey",
    ]);
  }
  if (key && typeof key === "object" && key.algorithm?.name === "HKDF")
    return key;
  throw new BackendError(
    "INVALID_BACKEND",
    "A framed envelope needs its key: 32 bytes, or a CryptoKey for HKDF. This package holds no keys of its own",
  );
}

/**
 * The key that seals this one file's frames.
 *
 * @param {Uint8Array | CryptoKey} key
 * @param {Uint8Array} salt
 * @param {number} frameSize
 * @param {Uint8Array | undefined} context
 */
async function fileKey(key, salt, frameSize, context) {
  const about = new Uint8Array(
    await globalThis.crypto.subtle.digest(
      "SHA-256",
      context ?? new Uint8Array(0),
    ),
  );
  const info = new Uint8Array(INFO_PREFIX.length + 4 + about.length);
  info.set(INFO_PREFIX, 0);
  new DataView(info.buffer).setUint32(INFO_PREFIX.length, frameSize);
  info.set(about, INFO_PREFIX.length + 4);
  return globalThis.crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info },
    await hkdfKey(key),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Index (11 bytes, big-endian) ‖ mark. @param {number} index @param {number} mark */
function nonceOf(index, mark) {
  const nonce = new Uint8Array(12);
  // The upper 3 bytes stay zero: an index is a count of frames a file can hold.
  new DataView(nonce.buffer).setBigUint64(3, BigInt(index));
  nonce[11] = mark;
  return nonce;
}

/** Header ‖ index (8 bytes) ‖ mark. */
function aadOf(header, index, mark) {
  const aad = new Uint8Array(header.length + 9);
  aad.set(header, 0);
  new DataView(aad.buffer).setBigUint64(header.length, BigInt(index));
  aad[header.length + 8] = mark;
  return aad;
}

const algorithm = (header, index, mark) => ({
  name: "AES-GCM",
  iv: nonceOf(index, mark),
  additionalData: aadOf(header, index, mark),
  tagLength: TAG_BYTES * 8,
});

function assertFrameSize(frameSize) {
  if (
    !Number.isInteger(frameSize) ||
    frameSize < 1 ||
    frameSize > MAX_FRAME_SIZE
  ) {
    throw new BackendError(
      "INVALID_BACKEND",
      `A frame holds between 1 and ${MAX_FRAME_SIZE} bytes, not ${frameSize}`,
    );
  }
}

/**
 * Seal bytes in frames, as they come.
 *
 * @param {Uint8Array | AsyncIterable<Uint8Array> | Iterable<Uint8Array>} source the plaintext
 * @param {object} options
 * @param {Uint8Array | CryptoKey} options.key 32 bytes, or a `CryptoKey` for HKDF
 * @param {Uint8Array} [options.context] bound into the file's key; the same
 *   bytes open it again
 * @param {number} [options.frameSize] plaintext bytes in a frame
 * @param {Uint8Array} [options.salt] for tests only: a salt used twice with
 *   one key repeats every nonce
 * @returns {AsyncGenerator<Uint8Array>} the sealed file, in pieces
 */
export async function* sealFrames(
  source,
  { key, context, frameSize = DEFAULT_FRAME_SIZE, salt } = {},
) {
  assertFrameSize(frameSize);
  const fresh =
    salt ?? globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  if (fresh.length !== SALT_BYTES) {
    throw new BackendError("INVALID_BACKEND", `A salt has ${SALT_BYTES} bytes`);
  }
  const header = new Uint8Array(FRAMED_HEADER_BYTES);
  header.set(ENVELOPE_MAGIC, 0);
  header[ENVELOPE_MAGIC.length] = FRAMED_VERSION;
  new DataView(header.buffer).setUint32(ENVELOPE_MAGIC.length + 1, frameSize);
  header.set(fresh, ENVELOPE_MAGIC.length + 5);

  const sealing = await fileKey(key, fresh, frameSize, context);
  const { subtle } = globalThis.crypto;
  const seal = async (plaintext, index, mark) =>
    new Uint8Array(
      await subtle.encrypt(algorithm(header, index, mark), sealing, plaintext),
    );

  const preamble = new Uint8Array(FRAMED_PREAMBLE_BYTES);
  preamble.set(header, 0);
  preamble.set(await seal(new Uint8Array(0), 0, KEY_CHECK), header.length);
  yield preamble;

  const queue = new ByteQueue();
  let index = 0;
  for await (const chunk of chunksOf(source)) {
    queue.push(chunk);
    // A frame is "not the last" only once a byte behind it is in hand.
    while (queue.length > frameSize) {
      yield seal(queue.take(frameSize), index++, MORE);
    }
  }
  yield seal(queue.take(queue.length), index, LAST);
}

/**
 * Open a framed envelope as it arrives: each frame authenticated and in its
 * place before its plaintext is handed on.
 *
 * @param {Uint8Array | AsyncIterable<Uint8Array> | Iterable<Uint8Array>} source the sealed file
 * @param {object} options
 * @param {Uint8Array | CryptoKey} options.key
 * @param {Uint8Array} [options.context] as it was sealed with
 * @param {(progress: { stage: "opened", frames: number, bytes: number }) => void} [options.onProgress]
 *   after each frame: how many are open, and their plaintext bytes
 * @returns {AsyncGenerator<Uint8Array>} the plaintext, a frame at a time
 * @throws {FrameError}
 */
export async function* openFrames(source, { key, context, onProgress } = {}) {
  const queue = new ByteQueue();
  const chunks = chunksOf(source)[Symbol.asyncIterator]();
  let ended = false;
  /** Read until `n` bytes are queued or the source ends. */
  const fill = async (n) => {
    while (!ended && queue.length < n) {
      const { done, value } = await chunks.next();
      if (done) ended = true;
      else queue.push(value);
    }
    return queue.length >= n;
  };

  try {
    if (!(await fill(FRAMED_PREAMBLE_BYTES))) {
      const start = queue.take(queue.length);
      if (envelopeVersion(start) === null) {
        throw new FrameError(
          "header",
          "These bytes are not an encrypted backup",
        );
      }
      throw new FrameError("cut-short", "This backup ends inside its header", {
        frame: 0,
      });
    }
    const header = queue.take(FRAMED_HEADER_BYTES);
    const version = envelopeVersion(header);
    if (version === null) {
      throw new FrameError("header", "These bytes are not an encrypted backup");
    }
    if (version !== FRAMED_VERSION) {
      throw new FrameError(
        "header",
        `This backup was written with envelope version ${version}, and frames are version ${FRAMED_VERSION}.` +
          (version === 1
            ? " It is sealed in one piece: open it with decrypt, whole."
            : " Upgrade @le-space/orbitdb-storage-bridge to restore it."),
      );
    }
    const frameSize = new DataView(
      header.buffer,
      header.byteOffset,
      header.byteLength,
    ).getUint32(ENVELOPE_MAGIC.length + 1);
    if (frameSize < 1 || frameSize > MAX_FRAME_SIZE) {
      throw new FrameError(
        "header",
        `This backup names frames of ${frameSize} bytes; this build reads up to ${MAX_FRAME_SIZE}`,
      );
    }
    // Its own copy: the header is every frame's additional data, long after
    // the chunk it arrived in is gone.
    const bound = new Uint8Array(header);
    const salt = bound.subarray(ENVELOPE_MAGIC.length + 5);
    const opening = await fileKey(key, salt, frameSize, context);
    const { subtle } = globalThis.crypto;

    try {
      await subtle.decrypt(
        algorithm(bound, 0, KEY_CHECK),
        opening,
        queue.take(TAG_BYTES),
      );
    } catch (cause) {
      throw new FrameError(
        "wrong-key",
        "This backup does not open with this key: it was sealed with another one, or for another purpose.",
        { cause },
      );
    }

    const sealedFrame = frameSize + TAG_BYTES;
    let index = 0;
    let bytes = 0;
    for (;;) {
      // One byte more than a frame says this frame is not the last.
      const more = await fill(sealedFrame + 1);
      if (!more && queue.length < TAG_BYTES) {
        throw new FrameError(
          "cut-short",
          `This backup is cut short: it ends before frame ${index} is complete.`,
          { frame: index },
        );
      }
      const mark = more ? MORE : LAST;
      const sealed = queue.take(more ? sealedFrame : queue.length);
      let plaintext;
      try {
        plaintext = new Uint8Array(
          await subtle.decrypt(algorithm(bound, index, mark), opening, sealed),
        );
      } catch (cause) {
        throw new FrameError(
          "frame",
          `Frame ${index} of this backup does not open: ` +
            (more
              ? "it was altered, or frames were moved or left out."
              : "the backup is cut short, has something appended, or its last frame was altered."),
          { frame: index, cause },
        );
      }
      // Only the one frame of an empty file holds nothing.
      if (plaintext.length === 0 && index > 0) {
        throw new FrameError(
          "frame",
          `Frame ${index} of this backup is empty, which no writer makes.`,
          { frame: index },
        );
      }
      bytes += plaintext.length;
      index++;
      onProgress?.({ stage: "opened", frames: index, bytes });
      if (plaintext.length) yield plaintext;
      if (!more) return;
    }
  } finally {
    // A reader that stops early, or a frame that failed: let the source go.
    await chunks.return?.();
  }
}

/** @param {AsyncIterable<Uint8Array>} chunks @returns {Promise<Uint8Array>} */
export async function collectBytes(chunks) {
  const parts = [];
  let total = 0;
  for await (const chunk of chunks) {
    parts.push(chunk);
    total += chunk.length;
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Seal bytes in frames, in one piece: for a writer that has the whole
 * plaintext in memory anyway and an upload that wants the whole body.
 *
 * @param {Uint8Array} bytes
 * @param {Parameters<typeof sealFrames>[1]} options
 * @returns {Promise<Uint8Array>}
 */
export function sealFramed(bytes, options) {
  return collectBytes(sealFrames(bytes, options));
}

/**
 * Open a framed envelope in one piece. For small files and for readers that
 * need all of it at once; a restore that must stay small uses {@link openFrames}.
 *
 * @param {Uint8Array} bytes
 * @param {Parameters<typeof openFrames>[1]} options
 * @returns {Promise<Uint8Array>}
 */
export async function openFramed(bytes, options) {
  const plaintext = await collectBytes(openFrames(bytes, options));
  return plaintext ?? new Uint8Array(0);
}
