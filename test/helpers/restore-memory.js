/**
 * @fileoverview What a restore holds in memory, measured (#187). Run by
 * streamed-restore-memory.test.js in a process of its own:
 *
 *     node --expose-gc test/helpers/restore-memory.js <streamed|whole> <MiB>
 *
 * A backup of that many MiB of random blocks is restored into a blockstore
 * that keeps nothing, and the largest amount of memory in `ArrayBuffer`s seen
 * on the way is printed as JSON. Collected before every reading, so what is
 * counted is what is still referenced, not what the collector has not got to.
 *
 * `--max-old-space-size` would not do: it bounds the JavaScript heap, and
 * the bytes of a `Uint8Array` live outside it.
 *
 * - `streamed`: the backup never exists whole. Blocks are made one at a time,
 *   written into a CAR as a stream, sealed in frames as a stream, and that
 *   stream is opened and stored block by block.
 * - `whole`: the envelope in one piece. The sealed file is in memory, as
 *   `getBlob` returns it, then opened and read as before.
 */

import { CarWriter } from "@ipld/car";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import { openFrames, sealFrames } from "../../lib/backends/frames.js";
import { readEnvelope, wrapEnvelope } from "../../lib/backends/encryption.js";
import {
  readBlocksFromCAR,
  storeBlocksFromCAR,
} from "../../lib/restore-cid.js";

const [mode, megabytes] = [process.argv[2], Number(process.argv[3] ?? 100)];
const MIB = 1024 * 1024;
const BLOCK = MIB;

const held = () => {
  globalThis.gc();
  return process.memoryUsage().arrayBuffers;
};
const baseline = held();
let peak = 0;
const sample = () => {
  peak = Math.max(peak, held() - baseline);
};

async function block() {
  const bytes = new Uint8Array(BLOCK);
  for (let at = 0; at < BLOCK; at += 65536)
    globalThis.crypto.getRandomValues(bytes.subarray(at, at + 65536));
  return { cid: CID.createV1(raw.code, await sha256.digest(bytes)), bytes };
}

/** A CAR of `count` random blocks, as a stream: no block outlives its turn. */
async function* car(count) {
  const first = await block();
  const { writer, out } = CarWriter.create([first.cid]);
  const feeding = (async () => {
    await writer.put(first);
    for (let i = 1; i < count; i++) await writer.put(await block());
    await writer.close();
  })();
  yield* out;
  await feeding;
}

/** A blockstore that takes a block and keeps nothing, as a disk would. */
const sink = { put: async () => {} };

const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
let blocks;

if (mode === "streamed") {
  const sealed = sealFrames(car(megabytes), { key });
  const stored = await storeBlocksFromCAR(sink, openFrames(sealed, { key }), {
    onProgress: sample,
  });
  blocks = stored.blocks;
} else if (mode === "whole") {
  const aes = await globalThis.crypto.subtle.importKey(
    "raw",
    key,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  // Outside the measurement: making the file is not restoring it.
  let file;
  {
    const parts = [];
    for await (const chunk of car(megabytes)) parts.push(chunk);
    const plain = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      plain.set(p, at);
      at += p.length;
    }
    parts.length = 0;
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    file = wrapEnvelope(
      new Uint8Array(
        await globalThis.crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          aes,
          plain,
        ),
      ),
      iv,
    );
  }
  // The restore: the fetched file, opened, read, stored.
  sample();
  const { ciphertext, iv } = readEnvelope(file);
  const plain = new Uint8Array(
    await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      aes,
      ciphertext,
    ),
  );
  sample();
  const read = await readBlocksFromCAR(plain, { verify: true });
  sample();
  for (const [name, { bytes }] of read) await sink.put(CID.parse(name), bytes);
  blocks = read.size;
  // Still referenced while the blocks are stored, as in a restore.
  void file.length;
} else {
  throw new Error("streamed or whole");
}

process.stdout.write(JSON.stringify({ mode, megabytes, blocks, peak }) + "\n");
