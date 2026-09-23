/**
 * @fileoverview What a mirror promises across several services, and what it
 * refuses to promise.
 *
 * Offline: every service here is a memory backend, or one that fails on
 * purpose. The questions are the ones a caller has to be able to trust — who
 * holds the blob afterwards, what a partial write reports, which service a read
 * came from, and whether the capability set flatters the weakest member.
 */

import { describe, test, expect } from "@jest/globals";
import { createMirrorBackend } from "../../lib/backends/mirror.js";
import { createMemoryBackend } from "../../lib/backends/memory.js";
import { BackendError } from "../../lib/backends/types.js";

const bytes = () => new Uint8Array([1, 2, 3, 4, 5]);

/** A service whose ids are its own, the way a vendor that is not content-addressed behaves. */
const renaming = (inner, prefix) => ({
  ...inner,
  name: prefix,
  putBlob: async (bytesIn, meta) => {
    const handle = await inner.putBlob(bytesIn, meta);
    return { ...handle, id: `${prefix}:${handle.cid}`, backend: prefix };
  },
  getBlob: async (handle) => {
    const id = String(typeof handle === "string" ? handle : handle?.id);
    if (!id.startsWith(`${prefix}:`)) {
      throw new BackendError(
        "NOT_FOUND",
        `${prefix} only knows its own ids, not ${id}`,
      );
    }
    return inner.getBlob(id.slice(prefix.length + 1));
  },
});

/** A service that takes nothing, the way a vendor with a refused key behaves. */
const refusing = (name, code = "FAILED") => ({
  name,
  capabilities: {
    browserSafeAuth: true,
    preservesInnerCids: true,
    minBlobSize: 0,
  },
  putBlob: async () => {
    throw new BackendError(code, `${name} refused the upload`);
  },
  getBlob: async () => {
    throw new BackendError("NOT_FOUND", `${name} has nothing`);
  },
});

describe("a mirror across several services", () => {
  test("writes to all of them, and the handle names who holds it", async () => {
    const mirror = createMirrorBackend([
      createMemoryBackend(),
      createMemoryBackend(),
    ]);
    const handle = await mirror.putBlob(bytes(), { name: "backup.car" });

    expect(handle.copies.map((copy) => copy.backend)).toEqual([
      "memory",
      "memory",
    ]);
    expect(handle.failures).toBeUndefined();
    // The bytes decide the CID, so every service agreed on one and the handle carries it.
    expect(handle.cid).toBe(handle.copies[0].cid);
    expect(handle.id).toBe(handle.cid);
    expect(handle.name).toBe("backup.car");
  });

  test("one service refusing is reported, not swallowed", async () => {
    const mirror = createMirrorBackend([
      createMemoryBackend(),
      refusing("broken"),
    ]);
    const handle = await mirror.putBlob(bytes());

    expect(handle.copies).toHaveLength(1);
    expect(handle.failures).toEqual([
      expect.objectContaining({ backend: "broken", code: "FAILED" }),
    ]);
  });

  test('with require "all", one refusal fails the write', async () => {
    const mirror = createMirrorBackend(
      [createMemoryBackend(), refusing("broken")],
      {
        require: "all",
      },
    );
    await expect(mirror.putBlob(bytes())).rejects.toThrow(
      /1 of 2 services refused/,
    );
  });

  test("a write nobody took is an error naming every reason", async () => {
    const mirror = createMirrorBackend([refusing("one"), refusing("two")]);
    await expect(mirror.putBlob(bytes())).rejects.toThrow(
      /one refused the upload.*two refused/s,
    );
  });

  test("a read asks in order and stops at the first answer", async () => {
    const empty = createMemoryBackend();
    const holding = createMemoryBackend();
    const stored = await holding.putBlob(bytes());

    const mirror = createMirrorBackend([empty, holding]);
    expect(await mirror.getBlob(stored.cid)).toEqual(bytes());

    // And when nobody has it, the error carries what each one said.
    await expect(
      mirror.getBlob(
        "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    ).rejects.toThrow(/no service returned/);
  });

  test("a read uses each service's own id, not only the shared CID", async () => {
    // Only one service holds it, and it keys by an id of its own — so a read
    // that passed the shared CID around would find nothing anywhere.
    const mirror = createMirrorBackend([
      renaming(createMemoryBackend(), "alpha"),
      refusing("empty"),
    ]);
    const handle = await mirror.putBlob(bytes());

    expect(handle.copies[0].id).toMatch(/^alpha:/);
    expect(await mirror.getBlob(handle)).toEqual(bytes());
  });

  test("capabilities follow the weakest member, and the strictest door", async () => {
    const strict = {
      ...createMemoryBackend(),
      name: "strict",
      capabilities: {
        pinByCid: false,
        carImport: true,
        preservesInnerCids: true,
        browserSafeAuth: false, // a bearer secret somewhere in the set
        delegation: false,
        listing: true,
        deletion: true,
        minBlobSize: 127, // Filecoin Onchain Cloud's floor
      },
    };
    const mirror = createMirrorBackend([createMemoryBackend(), strict]);

    expect(mirror.capabilities.browserSafeAuth).toBe(false);
    expect(mirror.capabilities.carImport).toBe(false); // memory cannot
    expect(mirror.capabilities.preservesInnerCids).toBe(true); // both can
    expect(mirror.capabilities.minBlobSize).toBe(127);
    // Neither question has one honest answer across services.
    expect(mirror.capabilities.listing).toBe(false);
    expect(mirror.capabilities.deletion).toBe(false);
    expect(mirror.list).toBeUndefined();
    expect(mirror.remove).toBeUndefined();
  });

  test("pinning is offered when any service can, and only those are asked", async () => {
    const published = new Map();
    const pinner = createMemoryBackend({
      resolve: async (cid) => published.get(cid) ?? null,
    });
    const plain = createMemoryBackend();
    const mirror = createMirrorBackend([plain, pinner]);

    expect(mirror.capabilities.pinByCid).toBe(true);

    const stored = await pinner.putBlob(bytes());
    published.set(stored.cid, bytes());
    const pinned = await mirror.pinCid(stored.cid);

    expect(pinned.copies.map((copy) => copy.backend)).toEqual(["memory"]);
    expect(pinned.copies).toHaveLength(1); // the one that can, not both
    // Asking a service that cannot pin would show up here as a failure.
    expect(pinned.failures).toBeUndefined();
  });

  test("a mirror of one is not a mirror", () => {
    expect(() => createMirrorBackend([createMemoryBackend()])).toThrow(
      /at least two backends/,
    );
    expect(() => createMirrorBackend([])).toThrow(/at least two backends/);
  });

  test("it keeps the backend contract, so callers need not know it is one", () => {
    const mirror = createMirrorBackend([
      createMemoryBackend(),
      createMemoryBackend(),
    ]);
    expect(typeof mirror.putBlob).toBe("function");
    expect(typeof mirror.getBlob).toBe("function");
    expect(mirror.name).toBe("mirror(memory+memory)");
    expect(mirror.backends).toHaveLength(2);
  });
});
