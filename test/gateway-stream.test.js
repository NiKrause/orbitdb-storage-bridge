/**
 * @fileoverview A file from a gateway as it arrives (#187): handed on chunk by
 * chunk, picked up again where a connection dropped it, and refused at the end
 * when it is not the file that was asked for.
 *
 * Nothing here touches the network: `fetch` is a stub whose bodies can stop
 * half way, ignore a `Range`, or go quiet.
 */

import { describe, test, expect } from "@jest/globals";
import { MAX_RESUMES, streamFromGateways } from "../lib/gateway-fetch.js";
import {
  unixfsCid,
  unixfsCidVerifier,
  matchesUnixfsCid,
} from "../lib/backends/aleph-upload.js";
import { createAlephBackend } from "../lib/backends/aleph.js";
import {
  createGatewayFirstStream,
  createPeerFetch,
} from "../lib/peer-fetch.js";

const random = (n) => {
  const out = new Uint8Array(n);
  for (let at = 0; at < n; at += 65536)
    globalThis.crypto.getRandomValues(
      out.subarray(at, Math.min(n, at + 65536)),
    );
  return out;
};
const FILE = random(10_000);
const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

/**
 * A body of `bytes` in pieces of `size`; after `failAfter` pieces the read
 * throws, as a connection that dropped does.
 */
function body(
  bytes,
  { size = 1000, failAfter = Infinity, endAfter = Infinity } = {},
) {
  let at = 0;
  let pieces = 0;
  let cancelled = false;
  return {
    cancelled: () => cancelled,
    getReader: () => ({
      read: async () => {
        if (pieces >= failAfter) throw new Error("the connection dropped");
        if (at >= bytes.length || pieces >= endAfter)
          return { done: true, value: undefined };
        const value = bytes.subarray(at, Math.min(bytes.length, at + size));
        at += value.length;
        pieces++;
        return { done: false, value };
      },
      cancel: async () => {
        cancelled = true;
      },
    }),
  };
}

const answer = ({ status = 200, headers = {}, body: b } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  body: b,
});

/** A gateway that honours `Range`, and drops the connection as told per request. */
function gateway(file, drops = []) {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const range = options.headers?.Range ?? null;
    const from = range ? Number(/bytes=(\d+)-/.exec(range)[1]) : 0;
    const drop = drops[requests.length];
    requests.push({ url, range });
    return answer({
      status: range ? 206 : 200,
      headers: range
        ? { "content-range": `bytes ${from}-${file.length - 1}/${file.length}` }
        : { "content-length": String(file.length) },
      body: body(file.subarray(from), drop ?? {}),
    });
  };
  return { fetchImpl, requests };
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return { bytes: out, chunks };
}

const opts = (fetchImpl, more = {}) => ({
  gateways: ["https://one.example/ipfs"],
  fetchImpl,
  sleep: async () => {},
  ...more,
});

describe("a file as it arrives", () => {
  test("is handed on in the gateway's chunks, with the count and the announced length", async () => {
    const { fetchImpl, requests } = gateway(FILE);
    const progress = [];
    const { bytes, chunks } = await collect(
      streamFromGateways(
        CID,
        opts(fetchImpl, { onProgress: (r, t) => progress.push([r, t]) }),
      ),
    );
    expect([...bytes]).toEqual([...FILE]);
    expect(chunks.length).toBe(10);
    expect(progress[0]).toEqual([1000, 10_000]);
    expect(progress.at(-1)).toEqual([10_000, 10_000]);
    expect(requests).toEqual([
      { url: `https://one.example/ipfs/${CID}`, range: null },
    ]);
  });

  test("nothing is held back: the first chunk is with the caller before the second is read", async () => {
    let reads = 0;
    const fetchImpl = async () =>
      answer({
        headers: { "content-length": "3000" },
        body: {
          getReader: () => ({
            read: async () => {
              reads++;
              return reads > 3
                ? { done: true }
                : { done: false, value: FILE.subarray(0, 1000) };
            },
            cancel: async () => {},
          }),
        },
      });
    const stream = streamFromGateways(CID, opts(fetchImpl));
    await stream.next();
    expect(reads).toBe(1);
    await stream.return();
  });

  test("a caller that stops early lets the connection go", async () => {
    const b = body(FILE);
    const stream = streamFromGateways(
      CID,
      opts(async () => answer({ body: b })),
    );
    await stream.next();
    await stream.return();
    expect(b.cancelled()).toBe(true);
  });
});

describe("a connection that drops", () => {
  test("is picked up at the byte it stopped at, and the file is whole", async () => {
    const { fetchImpl, requests } = gateway(FILE, [
      { failAfter: 3 },
      { failAfter: 2 },
    ]);
    const { bytes } = await collect(streamFromGateways(CID, opts(fetchImpl)));
    expect([...bytes]).toEqual([...FILE]);
    expect(requests.map((r) => r.range)).toEqual([
      null,
      "bytes=3000-",
      "bytes=5000-",
    ]);
  });

  test("a body that ends early without an error is asked for the rest too", async () => {
    const { fetchImpl, requests } = gateway(FILE, [{ endAfter: 4 }]);
    const { bytes } = await collect(streamFromGateways(CID, opts(fetchImpl)));
    expect([...bytes]).toEqual([...FILE]);
    expect(requests.map((r) => r.range)).toEqual([null, "bytes=4000-"]);
  });

  test("a gateway that ignores the range has the bytes already delivered passed over", async () => {
    let n = 0;
    const fetchImpl = async () =>
      answer({
        headers: { "content-length": String(FILE.length) },
        body: body(
          FILE,
          n++ === 0 ? { failAfter: 4, size: 700 } : { size: 900 },
        ),
      });
    const { bytes } = await collect(streamFromGateways(CID, opts(fetchImpl)));
    expect([...bytes]).toEqual([...FILE]);
  });

  test("the next gateway goes on where the first one gave up", async () => {
    const one = gateway(FILE, [{ failAfter: 2 }]);
    const two = gateway(FILE);
    let firstAsked = 0;
    const fetchImpl = async (url, options) => {
      if (url.includes("one.example")) {
        if (firstAsked++ > 0) return answer({ status: 500 });
        return one.fetchImpl(url, options);
      }
      return two.fetchImpl(url, options);
    };
    const { bytes } = await collect(
      streamFromGateways(
        CID,
        opts(fetchImpl, {
          gateways: ["https://one.example/ipfs", "https://two.example/ipfs"],
        }),
      ),
    );
    expect([...bytes]).toEqual([...FILE]);
    expect(two.requests[0].range).toBe("bytes=2000-");
  });

  test("a transfer that keeps dropping ends, and says where it stopped", async () => {
    const drops = Array.from({ length: MAX_RESUMES + 5 }, () => ({
      failAfter: 1,
      size: 10,
    }));
    const { fetchImpl, requests } = gateway(FILE, drops);
    const error = await collect(streamFromGateways(CID, opts(fetchImpl))).catch(
      (e) => e,
    );
    expect(error.message).toMatch(/stopped at byte/);
    expect(error.received).toBe((MAX_RESUMES + 1) * 10);
    expect(requests.length).toBe(MAX_RESUMES + 1);
  });

  test("a gateway that never sends a byte is tried three times, no more", async () => {
    const { fetchImpl, requests } = gateway(FILE, [
      { failAfter: 0 },
      { failAfter: 0 },
      { failAfter: 0 },
      {},
    ]);
    await expect(
      collect(streamFromGateways(CID, opts(fetchImpl))),
    ).rejects.toThrow(/Could not fetch/);
    expect(requests.length).toBe(3);
  });

  test("silence counts only while the gateway is asked, not while the caller is busy", async () => {
    const { fetchImpl } = gateway(FILE);
    const stream = streamFromGateways(CID, opts(fetchImpl, { timeout: 30 }));
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
      // Longer than the idle time, as a slow disk is.
      if (chunks.length === 2) await new Promise((r) => setTimeout(r, 80));
    }
    expect(chunks.length).toBe(10);
  });

  test("a gateway that goes quiet is left after the idle time", async () => {
    const fetchImpl = async () =>
      answer({
        body: {
          getReader: () => ({
            read: () => new Promise(() => {}),
            cancel: async () => {},
          }),
        },
      });
    // The stub's read never settles, so the abort has to be what ends it.
    const quiet = async (url, options) => {
      const response = await fetchImpl(url, options);
      const reader = response.body.getReader();
      response.body.getReader = () => ({
        read: () =>
          new Promise((_, reject) =>
            options.signal.addEventListener("abort", () =>
              reject(options.signal.reason),
            ),
          ),
        cancel: reader.cancel,
      });
      return response;
    };
    await expect(
      collect(streamFromGateways(CID, opts(quiet, { timeout: 20 }))),
    ).rejects.toThrow(/no bytes from https:\/\/one\.example\/ipfs for 20 ms/);
  });
});

describe("a file that is not the one asked for", () => {
  test("an error page with a 200 is not handed on, and the next gateway is asked", async () => {
    const page = new TextEncoder().encode(
      "<!DOCTYPE html><html>not found</html>",
    );
    const good = gateway(FILE);
    const fetchImpl = async (url, options) =>
      url.includes("one.example")
        ? answer({ body: body(page) })
        : good.fetchImpl(url, options);
    const { bytes } = await collect(
      streamFromGateways(
        CID,
        opts(fetchImpl, {
          gateways: ["https://one.example/ipfs", "https://two.example/ipfs"],
        }),
      ),
    );
    expect([...bytes]).toEqual([...FILE]);
  });

  test("another length than the one known is refused at the end, before the iteration ends", async () => {
    const fetchImpl = async () => answer({ body: body(FILE) });
    const seen = [];
    const error = await (async () => {
      for await (const chunk of streamFromGateways(
        CID,
        opts(fetchImpl, { expectedSize: 12_000 }),
      ))
        seen.push(chunk);
    })().catch((e) => e);
    expect(error.message).toMatch(/served 10000 bytes .* not the 12000/);
    expect(seen.length).toBe(10);
  });

  test("a verifier sees every chunk once, and its no is the stream's error", async () => {
    const written = [];
    const verifier = (cid) => ({
      write: (chunk) => void written.push(chunk.length),
      done: async () => cid !== CID,
    });
    const { fetchImpl } = gateway(FILE, [{ failAfter: 3 }]);
    await expect(
      collect(streamFromGateways(CID, opts(fetchImpl, { verifier }))),
    ).rejects.toThrow(/bytes that are not/);
    expect(written.reduce((a, b) => a + b, 0)).toBe(FILE.length);
  });

  test("started at an offset, the rest is handed on and no whole-file check is asked", async () => {
    const { fetchImpl, requests } = gateway(FILE);
    let asked = false;
    const { bytes } = await collect(
      streamFromGateways(
        CID,
        opts(fetchImpl, {
          offset: 6000,
          expectedSize: FILE.length,
          verifier: () => {
            asked = true;
            return null;
          },
        }),
      ),
    );
    expect([...bytes]).toEqual([...FILE.subarray(6000)]);
    expect(requests[0].range).toBe("bytes=6000-");
    expect(asked).toBe(false);
  });
});

describe("the UnixFS CID of a file that arrives in pieces", () => {
  test.each([0, 1, 262_144, 262_145, 700_000])(
    "%i bytes: the same answer as for the file whole",
    async (length) => {
      const file = random(length);
      const cid = await unixfsCid(file);
      const verifier = unixfsCidVerifier(cid);
      for (let at = 0; at < file.length; at += 50_000)
        await verifier.write(
          file.subarray(at, Math.min(file.length, at + 50_000)),
        );
      expect(await verifier.done()).toBe(true);
      expect(await matchesUnixfsCid(cid, file)).toBe(true);
    },
  );

  test("one byte off, or one byte short, is another file", async () => {
    const file = random(600_000);
    const cid = await unixfsCid(file);
    const changed = new Uint8Array(file);
    changed[300_000] ^= 1;
    const a = unixfsCidVerifier(cid);
    await a.write(changed);
    expect(await a.done()).toBe(false);
    const b = unixfsCidVerifier(cid);
    await b.write(file.subarray(0, file.length - 1));
    expect(await b.done()).toBe(false);
  });

  test("a CID it cannot prove gets no verifier", () => {
    expect(unixfsCidVerifier(CID)).toBe(null);
    expect(unixfsCidVerifier("not a cid")).toBe(null);
  });
});

describe("the Aleph driver's stream", () => {
  test("hands the file on, checks its CID and its size at the end", async () => {
    const file = random(600_000);
    const cid = await unixfsCid(file);
    const { fetchImpl } = gateway(file, [{ failAfter: 100, size: 2000 }]);
    const backend = createAlephBackend({
      gateways: ["https://one.example/ipfs"],
      fetch: fetchImpl,
    });
    const progress = [];
    const { bytes } = await collect(
      backend.getBlobStream(cid, {
        size: file.length,
        onProgress: (r, t) => progress.push([r, t]),
      }),
    );
    expect([...bytes.subarray(0, 64)]).toEqual([...file.subarray(0, 64)]);
    expect(bytes.length).toBe(file.length);
    expect(progress.at(-1)).toEqual([file.length, file.length]);
  });

  test("a file that is not the CID's is refused as the driver refuses a blob", async () => {
    const file = random(300_000);
    const cid = await unixfsCid(file);
    const served = new Uint8Array(file);
    served[1234] ^= 1;
    const backend = createAlephBackend({
      gateways: ["https://one.example/ipfs"],
      fetch: gateway(served).fetchImpl,
    });
    const error = await collect(backend.getBlobStream(cid)).catch((e) => e);
    expect(error.name).toBe("BackendError");
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toMatch(/bytes that are not/);
  });
});

describe("gateway first, peers behind it, for a file handed on as it arrives", () => {
  const peersOver = (file, seen = []) =>
    createPeerFetch({
      providers: ["/dns4/peer.example/tcp/443/wss/p2p/12D3KooWExamplePeer"],
      dial: async () => ({}),
      cat: async function* (cid, options = {}) {
        seen.push(options.offset ?? 0);
        for (let at = options.offset ?? 0; at < file.length; at += 1500)
          yield file.subarray(at, Math.min(file.length, at + 1500));
      },
    });

  test("a gateway that delivers is the whole story", async () => {
    const paths = [];
    const stream = createGatewayFirstStream({
      viaGateway: (cid, options) =>
        streamFromGateways(cid, opts(gateway(FILE).fetchImpl, options)),
      viaPeers: () => {
        throw new Error("the peers were not to be asked");
      },
      onPath: (path, info) => paths.push([path, info.bytes]),
    });
    const { bytes } = await collect(stream(CID));
    expect([...bytes]).toEqual([...FILE]);
    expect(paths).toEqual([["gateway", 10_000]]);
  });

  test("a gateway that gives up half way: the peers go on from that byte", async () => {
    const drops = Array.from({ length: MAX_RESUMES + 2 }, (_, i) =>
      i === 0 ? { failAfter: 4 } : { failAfter: 0 },
    );
    const offsets = [];
    const paths = [];
    const stream = createGatewayFirstStream({
      viaGateway: (cid, options) =>
        streamFromGateways(
          cid,
          opts(gateway(FILE, drops).fetchImpl, { timeout: options.timeout }),
        ),
      viaPeers: peersOver(FILE, offsets).stream,
      onPath: (path, info) => paths.push([path, info]),
    });
    const { bytes } = await collect(stream(CID, { size: FILE.length }));
    expect([...bytes]).toEqual([...FILE]);
    expect(offsets).toEqual([4000]);
    expect(paths[0][0]).toBe("peers");
    expect(paths[0][1]).toMatchObject({
      bytes: 10_000,
      resumedAt: 4000,
      after: { path: "gateway" },
    });
  });

  test("a gateway that never answers: the peers deliver all of it", async () => {
    const offsets = [];
    const stream = createGatewayFirstStream({
      viaGateway: (cid) =>
        streamFromGateways(
          cid,
          opts(async () => answer({ status: 504 })),
        ),
      viaPeers: peersOver(FILE, offsets).stream,
    });
    const { bytes } = await collect(stream(CID));
    expect([...bytes]).toEqual([...FILE]);
    expect(offsets).toEqual([0]);
  });

  test("both failing says both reasons; a wrong length is refused", async () => {
    const failing = createGatewayFirstStream({
      viaGateway: (cid) =>
        streamFromGateways(
          cid,
          opts(async () => answer({ status: 504 })),
        ),
      viaPeers: createPeerFetch({
        providers: [],
        dial: async () => ({}),
        cat: async function* () {},
      }).stream,
    });
    await expect(collect(failing(CID))).rejects.toThrow(
      /the gateway said .* and the peers said/,
    );

    const short = createGatewayFirstStream({
      viaGateway: (cid) =>
        streamFromGateways(
          cid,
          opts(async () => answer({ status: 504 })),
        ),
      viaPeers: peersOver(FILE.subarray(0, 9000)).stream,
    });
    await expect(collect(short(CID, { size: FILE.length }))).rejects.toThrow(
      /9000 bytes .* not the 10000/,
    );
  });

  test("the peer fetch still answers with the whole file when asked for it", async () => {
    const fetchBytes = peersOver(FILE);
    expect([...(await fetchBytes(CID))]).toEqual([...FILE]);
  });
});
