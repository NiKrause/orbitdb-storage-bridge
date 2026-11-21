/**
 * @fileoverview The envelope in frames (#187): what goes in comes out, however
 * the bytes are cut on the way, and a file that is not the one that was sealed
 * is refused at the frame where it differs.
 *
 * A backup format is hard to change once backups exist, so what is asserted
 * here is the format itself, byte for byte where it matters: the header, the
 * frame's length, and each way of damaging a file that a storage service, a
 * gateway or a dropped connection could produce.
 */

import { describe, test, expect } from "@jest/globals";
import {
  DEFAULT_FRAME_SIZE,
  FRAMED_HEADER_BYTES,
  FRAMED_PREAMBLE_BYTES,
  FRAMED_VERSION,
  MAX_FRAME_SIZE,
  ByteQueue,
  FrameError,
  collectBytes,
  envelopeVersion,
  isFramed,
  openFramed,
  openFrames,
  sealFramed,
  sealFrames,
} from "../../lib/backends/frames.js";
import {
  ENVELOPE_MAGIC,
  isEncrypted,
  readEnvelope,
  wrapEnvelope,
} from "../../lib/backends/encryption.js";

const FRAME = 64;
const SEALED = FRAME + 16;
const random = (n) => {
  const out = new Uint8Array(n);
  // getRandomValues fills at most 65536 bytes a call.
  for (let at = 0; at < n; at += 65536)
    globalThis.crypto.getRandomValues(
      out.subarray(at, Math.min(n, at + 65536)),
    );
  return out;
};
const key = random(32);
const other = random(32);

/** The file as an async stream of pieces of `size` bytes. */
async function* pieces(bytes, size) {
  for (let at = 0; at < bytes.length; at += size)
    yield bytes.subarray(at, Math.min(bytes.length, at + size));
}

/** The sealed frames behind the preamble, one per entry. */
function framesOf(sealed, frameSize = FRAME) {
  const frames = [];
  for (let at = FRAMED_PREAMBLE_BYTES; at < sealed.length; at += frameSize + 16)
    frames.push(
      sealed.subarray(at, Math.min(sealed.length, at + frameSize + 16)),
    );
  return frames;
}

const join = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** What opening `sealed` throws, after reading as far as it can. */
async function refusal(sealed, options = { key }) {
  const opened = [];
  try {
    for await (const chunk of openFrames(sealed, options)) opened.push(chunk);
  } catch (error) {
    return { error, opened };
  }
  throw new Error("it opened");
}

describe("the file", () => {
  test("starts with OSBE and version 2, then the frame size, a salt and the key check", async () => {
    const sealed = await sealFramed(random(3 * FRAME + 5), {
      key,
      frameSize: FRAME,
    });
    expect([...sealed.subarray(0, 4)]).toEqual([...ENVELOPE_MAGIC]);
    expect(sealed[4]).toBe(2);
    expect(FRAMED_VERSION).toBe(2);
    expect(new DataView(sealed.buffer).getUint32(5)).toBe(FRAME);
    expect(FRAMED_HEADER_BYTES).toBe(41);
    expect(FRAMED_PREAMBLE_BYTES).toBe(57);
    // Three full frames and one of five bytes, each with its tag; no lengths.
    expect(sealed.length).toBe(57 + 3 * SEALED + 5 + 16);
    expect(isEncrypted(sealed)).toBe(true);
    expect(isFramed(sealed)).toBe(true);
    expect(envelopeVersion(sealed)).toBe(2);
  });

  test("a megabyte to a frame unless the writer says otherwise", () => {
    expect(DEFAULT_FRAME_SIZE).toBe(1024 * 1024);
  });

  test.each([0, 1, FRAME - 1, FRAME, FRAME + 1, 2 * FRAME, 5 * FRAME + 17])(
    "%i bytes come back as they went in",
    async (length) => {
      const plain = random(length);
      const sealed = await sealFramed(plain, { key, frameSize: FRAME });
      // A payload that fills its frames exactly has no empty frame behind it.
      const frames = Math.max(1, Math.ceil(length / FRAME));
      expect(sealed.length).toBe(57 + length + 16 * frames);
      expect([...(await openFramed(sealed, { key }))]).toEqual([...plain]);
    },
  );

  test("however the bytes are cut on the way in and on the way out", async () => {
    const plain = random(7 * FRAME + 3);
    for (const cut of [1, 7, FRAME, SEALED, 1000]) {
      const sealed = await collectBytes(
        sealFrames(pieces(plain, cut), { key, frameSize: FRAME }),
      );
      const back = await collectBytes(openFrames(pieces(sealed, cut), { key }));
      expect([...back]).toEqual([...plain]);
    }
  });

  test("the plaintext arrives a frame at a time, with the count", async () => {
    const plain = random(3 * FRAME + 1);
    const sealed = await sealFramed(plain, { key, frameSize: FRAME });
    const progress = [];
    const sizes = [];
    for await (const chunk of openFrames(pieces(sealed, 10), {
      key,
      onProgress: (p) => progress.push(p),
    }))
      sizes.push(chunk.length);
    expect(sizes).toEqual([FRAME, FRAME, FRAME, 1]);
    expect(progress.at(-1)).toEqual({
      stage: "opened",
      frames: 4,
      bytes: plain.length,
    });
    expect(progress.map((p) => p.frames)).toEqual([1, 2, 3, 4]);
  });

  test("the same bytes sealed twice share nothing: a salt, and so a key, per file", async () => {
    const plain = random(2 * FRAME);
    const a = await sealFramed(plain, { key, frameSize: FRAME });
    const b = await sealFramed(plain, { key, frameSize: FRAME });
    expect([...a.subarray(9, 41)]).not.toEqual([...b.subarray(9, 41)]);
    expect([...framesOf(a)[0]]).not.toEqual([...framesOf(b)[0]]);
    // The plaintext is not in the file.
    expect(Buffer.from(a).includes(Buffer.from(plain.subarray(0, 16)))).toBe(
      false,
    );
  });

  test("a CryptoKey for HKDF is as good as its 32 bytes", async () => {
    const imported = await globalThis.crypto.subtle.importKey(
      "raw",
      key,
      "HKDF",
      false,
      ["deriveKey"],
    );
    const plain = random(100);
    const sealed = await sealFramed(plain, { key: imported, frameSize: FRAME });
    expect([...(await openFramed(sealed, { key }))]).toEqual([...plain]);
  });

  test("a key of another length, or none, is refused before anything is sealed", async () => {
    await expect(sealFramed(random(8), { key: random(16) })).rejects.toThrow(
      /32-byte key/,
    );
    await expect(sealFramed(random(8), {})).rejects.toThrow(/needs its key/);
    await expect(sealFramed(random(8), { key, frameSize: 0 })).rejects.toThrow(
      /between 1 and/,
    );
    await expect(
      sealFramed(random(8), { key, frameSize: MAX_FRAME_SIZE + 1 }),
    ).rejects.toThrow(/between 1 and/);
  });
});

describe("a key that is not the one", () => {
  test("is known at the key check, before any frame is opened", async () => {
    const sealed = await sealFramed(random(3 * FRAME), {
      key,
      frameSize: FRAME,
    });
    const { error, opened } = await refusal(sealed, { key: other });
    expect(error).toBeInstanceOf(FrameError);
    expect(error.reason).toBe("wrong-key");
    expect(error.code).toBe("INVALID_BACKEND");
    expect(opened).toEqual([]);
  });

  test("and so is another context: a file sealed for one purpose does not open for another", async () => {
    const context = new TextEncoder().encode(
      "the header this file was made with",
    );
    const sealed = await sealFramed(random(100), {
      key,
      frameSize: FRAME,
      context,
    });
    expect((await openFramed(sealed, { key, context })).length).toBe(100);
    expect((await refusal(sealed, { key })).error.reason).toBe("wrong-key");
    expect(
      (
        await refusal(sealed, {
          key,
          context: new TextEncoder().encode("another"),
        })
      ).error.reason,
    ).toBe("wrong-key");
  });
});

describe("a file that is not the one that was sealed", () => {
  let plain;
  let sealed;
  let preamble;
  let frames;

  const fresh = async () => {
    plain = random(5 * FRAME + 9);
    sealed = await sealFramed(plain, { key, frameSize: FRAME });
    preamble = sealed.subarray(0, FRAMED_PREAMBLE_BYTES);
    frames = framesOf(sealed);
  };

  test("a frame left out is refused at its index, with what came before it opened", async () => {
    await fresh();
    const { error, opened } = await refusal(
      join(preamble, frames[0], frames[1], frames[3], frames[4], frames[5]),
    );
    expect(error).toBeInstanceOf(FrameError);
    expect(error.reason).toBe("frame");
    expect(error.frame).toBe(2);
    expect(error.message).toMatch(/Frame 2 /);
    expect(opened.length).toBe(2);
    expect([...join(...opened)]).toEqual([...plain.subarray(0, 2 * FRAME)]);
  });

  test("two frames changing places are refused at the first of them", async () => {
    await fresh();
    const { error } = await refusal(
      join(
        preamble,
        frames[0],
        frames[2],
        frames[1],
        frames[3],
        frames[4],
        frames[5],
      ),
    );
    expect(error.reason).toBe("frame");
    expect(error.frame).toBe(1);
  });

  test("a frame said twice is refused where it repeats", async () => {
    await fresh();
    const { error } = await refusal(
      join(preamble, frames[0], frames[0], ...frames.slice(1)),
    );
    expect(error.frame).toBe(1);
  });

  test("one bit changed in a frame, or in its tag, is refused at that frame", async () => {
    await fresh();
    for (const at of [0, FRAME - 1, FRAME, SEALED - 1]) {
      const damaged = new Uint8Array(sealed);
      damaged[FRAMED_PREAMBLE_BYTES + 3 * SEALED + at] ^= 1;
      const { error, opened } = await refusal(damaged);
      expect(error.reason).toBe("frame");
      expect(error.frame).toBe(3);
      expect(opened.length).toBe(3);
    }
  });

  test("a frame of another file sealed with the same key does not fit in", async () => {
    await fresh();
    const stranger = framesOf(
      await sealFramed(random(5 * FRAME + 9), { key, frameSize: FRAME }),
    );
    const { error } = await refusal(
      join(preamble, frames[0], stranger[1], ...frames.slice(2)),
    );
    expect(error.frame).toBe(1);
  });

  test("cut at a frame's edge: the frame it now ends on is not the last one", async () => {
    await fresh();
    for (const kept of [1, 3, 5]) {
      const { error, opened } = await refusal(
        join(preamble, ...frames.slice(0, kept)),
      );
      expect(error.reason).toBe("frame");
      expect(error.frame).toBe(kept - 1);
      expect(error.message).toMatch(/cut short/);
      // Nothing of the frame that claims to be the end is handed on.
      expect(opened.length).toBe(kept - 1);
    }
  });

  test("cut inside a frame, or inside the last one's tag", async () => {
    await fresh();
    const inside = await refusal(
      sealed.subarray(0, FRAMED_PREAMBLE_BYTES + 2 * SEALED + 20),
    );
    expect(inside.error.reason).toBe("frame");
    expect(inside.error.frame).toBe(2);
    const inTag = await refusal(sealed.subarray(0, sealed.length - 1));
    expect(inTag.error.frame).toBe(5);
    // Fewer bytes than a tag is no frame at all.
    const stub = await refusal(
      sealed.subarray(0, FRAMED_PREAMBLE_BYTES + 5 * SEALED + 3),
    );
    expect(stub.error.reason).toBe("cut-short");
    expect(stub.error.frame).toBe(5);
  });

  test("cut right behind the key check, or inside the header", async () => {
    await fresh();
    const none = await refusal(preamble);
    expect(none.error.reason).toBe("cut-short");
    expect(none.error.frame).toBe(0);
    const header = await refusal(sealed.subarray(0, 30));
    expect(header.error.reason).toBe("cut-short");
  });

  test("anything appended is refused: the last frame is last", async () => {
    await fresh();
    const one = await refusal(join(sealed, new Uint8Array(1)));
    expect(one.error.reason).toBe("frame");
    expect(one.error.frame).toBe(5);
    const again = await refusal(join(sealed, frames[5]));
    expect(again.error.frame).toBe(5);
  });

  test("a full last frame with one more behind it: the mark is in the seal, not in the length", async () => {
    const whole = random(2 * FRAME);
    const made = await sealFramed(whole, { key, frameSize: FRAME });
    const [first, last] = framesOf(made);
    const { error } = await refusal(
      join(made.subarray(0, FRAMED_PREAMBLE_BYTES), first, last, last),
    );
    expect(error.frame).toBe(1);
  });

  test("a header that names another frame size opens nothing", async () => {
    await fresh();
    const lied = new Uint8Array(sealed);
    new DataView(lied.buffer).setUint32(5, FRAME * 2);
    // The frame size is in the key: the key check already fails.
    expect((await refusal(lied)).error.reason).toBe("wrong-key");
    const huge = new Uint8Array(sealed);
    new DataView(huge.buffer).setUint32(5, MAX_FRAME_SIZE + 1);
    const { error } = await refusal(huge);
    expect(error.reason).toBe("header");
    expect(error.message).toMatch(/reads up to/);
  });

  test("a changed salt, or a changed key check", async () => {
    await fresh();
    const salted = new Uint8Array(sealed);
    salted[20] ^= 1;
    expect((await refusal(salted)).error.reason).toBe("wrong-key");
    const checked = new Uint8Array(sealed);
    checked[FRAMED_HEADER_BYTES + 2] ^= 1;
    expect((await refusal(checked)).error.reason).toBe("wrong-key");
  });
});

describe("beside the envelope in one piece", () => {
  test("bytes that are no envelope, and versions this build does not read", async () => {
    expect((await refusal(random(200))).error.reason).toBe("header");
    expect((await refusal(new Uint8Array(0))).error.reason).toBe("header");
    const later = await sealFramed(random(10), { key, frameSize: FRAME });
    later[4] = 3;
    const { error } = await refusal(later);
    expect(error.reason).toBe("header");
    expect(error.message).toMatch(/Upgrade/);
  });

  test("an envelope in one piece is named as one, not opened as frames", async () => {
    const whole = join(wrapEnvelope(random(80), random(12)), random(40));
    expect(envelopeVersion(whole)).toBe(1);
    expect(isFramed(whole)).toBe(false);
    const { error } = await refusal(whole);
    expect(error.reason).toBe("header");
    expect(error.message).toMatch(/one piece/);
  });

  test("and frames are named as frames by the reader of the envelope in one piece", async () => {
    const sealed = await sealFramed(random(10), { key, frameSize: FRAME });
    expect(() => readEnvelope(sealed)).toThrow(/sealed in frames/);
  });
});

describe("the queue the frames are cut from", () => {
  test("hands out what was pushed, in the pieces asked for", () => {
    const queue = new ByteQueue();
    const all = random(1000);
    for (let at = 0; at < all.length; at += 37)
      queue.push(all.subarray(at, at + 37));
    expect(queue.length).toBe(1000);
    const out = [
      queue.take(10),
      queue.take(27),
      queue.take(500),
      queue.take(0),
      queue.take(463),
    ];
    expect(queue.length).toBe(0);
    expect([...join(...out)]).toEqual([...all]);
    expect(() => queue.take(1)).toThrow(RangeError);
  });
});
