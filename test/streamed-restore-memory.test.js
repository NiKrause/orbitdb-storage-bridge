/**
 * @fileoverview A backup of 100 MiB restored under a ceiling of memory that
 * the envelope in one piece cannot stay under (#187).
 *
 * The reason for frames, measured: a phone's browser tab ends, silently, when
 * a restore holds the sealed file, its plaintext and its blocks at once. Each
 * way runs in a process of its own (./helpers/restore-memory.js) and reports
 * the most it held in `ArrayBuffer`s. The streamed restore must stay under the
 * ceiling whatever the backup's size; the restore in one piece is run to show
 * that the ceiling is one it breaks, so the test would notice a "streamed"
 * path that quietly gathered the file.
 *
 * Not a process killed by a limit: Node bounds its heap
 * (`--max-old-space-size`), and the bytes of a `Uint8Array` are not in it.
 */

import { jest, describe, test, expect } from "@jest/globals";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

jest.setTimeout(300000);

const HELPER = join(
  dirname(fileURLToPath(import.meta.url)),
  "helpers",
  "restore-memory.js",
);
const MIB = 1024 * 1024;
const SIZE = 100;
/** A frame, a block, a CAR writer's and a cipher's buffers: far under this. */
const CEILING = 32 * MIB;

async function measure(mode, megabytes = SIZE) {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--expose-gc", "--no-warnings", HELPER, mode, String(megabytes)],
    // Not this process's options: jest's loader flags are not the helper's.
    { env: { ...process.env, NODE_OPTIONS: "" }, maxBuffer: MIB },
  );
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

describe("what a restore holds in memory", () => {
  test("streamed: 100 MiB under a ceiling of 32 MiB", async () => {
    const streamed = await measure("streamed");
    expect(streamed.blocks).toBe(SIZE);
    expect(streamed.peak).toBeLessThan(CEILING);
  });

  test("streamed: the size of the backup is not in it", async () => {
    const [small, large] = [
      await measure("streamed", 20),
      await measure("streamed", 60),
    ];
    // Three times the backup, the same few buffers.
    expect(large.peak).toBeLessThan(small.peak + 8 * MIB);
  });

  test("in one piece: the same backup is far over it, twice its size and more", async () => {
    const whole = await measure("whole");
    expect(whole.blocks).toBe(SIZE);
    expect(whole.peak).toBeGreaterThan(CEILING);
    expect(whole.peak).toBeGreaterThan(2 * SIZE * MIB);
  });
});
