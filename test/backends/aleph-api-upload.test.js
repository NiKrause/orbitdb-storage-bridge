/**
 * @fileoverview The upload when Aleph's IPFS host takes none.
 *
 * Since 2026-10-26 the IPFS hosts answer `/api/v0/add` with 404. The driver
 * then goes to an API node's `add_file`: without a signed STORE message up to
 * 25 MiB and not kept; with one (a pin that can `sign`) kept in the same
 * call, up to 1 GiB, which needs the file's CID before the upload. Against
 * the stub, which answers as the node was measured to on 2026-10-27.
 */

import {
  jest,
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
} from "@jest/globals";
import { createHash } from "node:crypto";
import { createAlephBackend } from "../../lib/backends/aleph.js";
import { createAlephPin } from "../../lib/backends/aleph-pin.js";
import {
  ALEPH_API_UNSIGNED_LIMIT,
  hashFromAddAnswer,
  unixfsCid,
  uploadTimeout,
} from "../../lib/backends/aleph-upload.js";
import { startAlephStub } from "../helpers/aleph-stub.js";

jest.setTimeout(60_000);

const SENDER = "0x1111111111111111111111111111111111111111";
const sign = jest.fn(async (address, payload) => {
  // A signature is what the caller makes of the payload; the library only
  // ever sees the address and the string.
  return createHash("sha256").update(`${address}:${payload}`).digest("hex");
});

const bytesOf = (n, seed = 7) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) % 256;
  return out;
};

describe("the CID Aleph's hosts give a file, computed before the upload", () => {
  test("matches the published UnixFS defaults: a single chunk is the file node itself", async () => {
    // 16 bytes measured against api2.aleph.im on 2026-10-27: the same answer.
    expect(await unixfsCid(new Uint8Array(0))).toBe(
      "QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH",
    );
    const once = await unixfsCid(bytesOf(16));
    expect(once).toMatch(/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/);
    expect(await unixfsCid(bytesOf(16))).toBe(once);
    expect(await unixfsCid(bytesOf(16, 8))).not.toBe(once);
  });

  test("a file of several chunks is a balanced tree, and still the same twice", async () => {
    const big = bytesOf(600_000);
    const cid = await unixfsCid(big);
    expect(cid).toMatch(/^Qm/);
    expect(await unixfsCid(big)).toBe(cid);
  });

  test("the IPFS host's answer is read by the file's name, not the wrapper's", () => {
    const text =
      '{"Name":"dir","Hash":"QmDir","Size":"0"}\n{"Name":"dir/f","Hash":"QmFile","Size":"3"}\n';
    expect(hashFromAddAnswer(text, "dir/f")).toBe("QmFile");
    expect(() => hashFromAddAnswer("nope", "f")).toThrow(/not JSON/);
  });

  test("an upload's timeout grows with the bytes, and is an integer", () => {
    expect(uploadTimeout(0)).toBe(120_000);
    expect(uploadTimeout(500e6)).toBe(120_000 + 5_000_000);
    expect(Number.isInteger(uploadTimeout(123_457))).toBe(true);
  });
});

describe("the API node, once the IPFS host is gone", () => {
  let stub;
  beforeAll(async () => {
    stub = await startAlephStub();
  });
  afterAll(async () => {
    await stub.stop();
  });

  test("a 404 from the host sends the upload to the API node, unsigned and not retained, and the host is not asked again", async () => {
    stub.ingestGone(true);
    const calls = [];
    const backend = createAlephBackend({
      ingestUrl: stub.ingestUrl,
      apiHost: stub.url,
      gateways: [stub.gatewayUrl],
      fetch: (url, init) => {
        calls.push(new URL(url).pathname);
        return fetch(url, init);
      },
    });
    const bytes = bytesOf(5000);
    const handle = await backend.putBlob(bytes, { name: "backups/one.car" });
    expect(handle.id).toBe(await unixfsCid(bytes));
    expect(handle.retained).toBe(false);
    expect(handle.status).toBeUndefined();
    expect(calls).toEqual(["/api/v0/add", "/api/v0/ipfs/add_file"]);

    calls.length = 0;
    await backend.putBlob(bytesOf(10), { name: "two" });
    expect(calls).toEqual(["/api/v0/ipfs/add_file"]);

    // What went up comes back, from the same store the gateway serves.
    const back = await backend.getBlob(handle);
    expect(Buffer.from(back).equals(Buffer.from(bytes))).toBe(true);
    stub.ingestGone(false);
  });

  test("with a pin that signs, the STORE goes beside the file and the handle says retained", async () => {
    stub.ingestGone(true);
    sign.mockClear();
    const pin = createAlephPin({
      sender: SENDER,
      owner: "0x2222222222222222222222222222222222222222",
      sign,
      channel: "TEST-UPLOAD",
      apiHost: stub.url,
    });
    const backend = createAlephBackend({
      ingestUrl: stub.ingestUrl,
      apiHost: stub.url,
      gateways: [stub.gatewayUrl],
      pin,
    });
    expect(backend.capabilities.pinByCid).toBe(true);

    const bytes = bytesOf(300_000, 3);
    const before = stub.stores.length;
    const progress = [];
    const handle = await backend.putBlob(bytes, {
      name: "backups/signed.car",
      ref: "chain-base",
      onProgress: (sent, total) => progress.push([sent, total]),
    });
    expect(handle.retained).toBe(true);
    expect(handle.status).toBe("processed");
    expect(handle.itemHash).toMatch(/^[0-9a-f]{64}$/);
    expect(handle.id).toBe(await unixfsCid(bytes));

    // The node got the message with the CID it then computed itself.
    const store = stub.stores[before];
    expect(store).toMatchObject({
      cid: handle.id,
      itemHash: handle.itemHash,
      sender: SENDER,
      owner: "0x2222222222222222222222222222222222222222",
      channel: "TEST-UPLOAD",
      sync: true,
    });
    // The library never saw a key: `sign` got the address and a string.
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign.mock.calls[0][0]).toBe(SENDER);
    expect(typeof sign.mock.calls[0][1]).toBe("string");
    // Without XMLHttpRequest (Node), progress is reported once, at the end.
    expect(progress.at(-1)).toEqual([bytes.length, bytes.length]);
    stub.ingestGone(false);
  });

  test("too big for an unsigned upload: refused before anything is sent, and the error says what would help", async () => {
    stub.ingestGone(true);
    const calls = [];
    const backend = createAlephBackend({
      ingestUrl: stub.ingestUrl,
      apiHost: stub.url,
      fetch: (url, init) => {
        calls.push(new URL(url).pathname);
        return fetch(url, init);
      },
    });
    // The host is asked once, says 404; the big file then never leaves.
    await expect(
      backend.putBlob(new Uint8Array(ALEPH_API_UNSIGNED_LIMIT + 1), {
        name: "big",
      }),
    ).rejects.toThrow(
      /at most 26210304 bytes without a signed STORE message.*createAlephPin/,
    );
    expect(calls).toEqual(["/api/v0/add"]);
    stub.ingestGone(false);
  });

  test("`ingestUrl: null` goes to the API node from the start", async () => {
    const calls = [];
    const backend = createAlephBackend({
      ingestUrl: null,
      apiHost: stub.url,
      fetch: (url, init) => {
        calls.push(new URL(url).pathname);
        return fetch(url, init);
      },
    });
    const handle = await backend.putBlob(bytesOf(32), { name: "direct" });
    expect(handle.id).toMatch(/^Qm/);
    expect(calls).toEqual(["/api/v0/ipfs/add_file"]);
  });

  test("while the host answers, nothing changes: the host is used, nothing is retained", async () => {
    stub.ingestGone(false);
    const calls = [];
    const backend = createAlephBackend({
      ingestUrl: stub.ingestUrl,
      apiHost: stub.url,
      fetch: (url, init) => {
        calls.push(new URL(url).pathname);
        return fetch(url, init);
      },
    });
    const handle = await backend.putBlob(bytesOf(64), {
      name: "backups/same.car",
    });
    expect(handle.retained).toBe(false);
    expect(calls).toEqual(["/api/v0/add"]);
  });
});
