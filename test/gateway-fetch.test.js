/**
 * @fileoverview What the gateway fetcher does when a gateway is not merely
 * slow, but gone.
 *
 * This module had no tests, which is how it came to list four gateways that
 * were all retired on the same day (issue #111). Two of these tests are about
 * that failure mode specifically: a gateway that answers `429` with
 * `Retry-After: 900` is not rate-limiting us, and honouring it three times
 * over four hosts is most of an afternoon spent waiting for an answer that
 * will not change.
 *
 * Nothing here touches the network: `fetch` is a stub, and the wait is
 * injected, so the "waited 15 minutes" case costs nothing to assert.
 */

import { jest, describe, test, expect } from "@jest/globals";
import {
  fetchFromGateways,
  DEFAULT_GATEWAYS,
  TRUSTLESS_GATEWAYS,
  RAW_BLOCK,
  MAX_BACKOFF_MS,
} from "../lib/gateway-fetch.js";

const CID = "bafkreibjw4ccgiflcijrenzjpiptwsvhrkugkfzryan4wplryxfc6xrlrm";
const BYTES = new Uint8Array([1, 2, 3, 4]);

const answer = ({ status = 200, headers = {}, body = BYTES } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null },
  arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
});

/** Answers per gateway host, in the order the hosts are tried. */
function stubFetch(answers) {
  const seen = [];
  const fetchStub = jest.fn(async (url, options) => {
    seen.push({ url, accept: options?.headers?.Accept ?? null });
    const key = Object.keys(answers).find((host) => url.includes(host));
    const next = answers[key];
    return typeof next === "function" ? next(seen.filter((s) => s.url.includes(key)).length) : next;
  });
  return { fetchStub, seen };
}

describe("a gateway that is gone, not busy", () => {
  test("a Sunset header retires the gateway instead of retrying it", async () => {
    // Retry-After is short on purpose: without the Sunset check this gateway
    // would be waited for and asked again, which is what the test has to see.
    const { fetchStub, seen } = stubFetch({
      "retired.example": answer({
        status: 429,
        headers: { Sunset: "Mon, 21 Sep 2026 00:00:00 GMT", "Retry-After": "2" },
      }),
      "alive.example": answer(),
    });
    const waits = [];

    const bytes = await fetchFromGateways(CID, {
      gateways: ["https://retired.example/ipfs", "https://alive.example/ipfs"],
      fetchImpl: fetchStub,
      sleep: async (ms) => waits.push(ms),
    });

    expect(bytes).toEqual(BYTES);
    expect(waits).toEqual([]);
    expect(seen.filter((s) => s.url.includes("retired.example"))).toHaveLength(1);
  });

  test("a gateway that announces its retirement and still serves is still used", async () => {
    // How a sunset actually arrives: the header appears weeks before the
    // host stops answering. Refusing it early would break a working path.
    const { fetchStub } = stubFetch({
      "leaving.example": answer({ headers: { Sunset: "Mon, 21 Sep 2026 00:00:00 GMT" } }),
    });

    const bytes = await fetchFromGateways(CID, {
      gateways: ["https://leaving.example/ipfs"],
      fetchImpl: fetchStub,
    });

    expect(bytes).toEqual(BYTES);
  });

  test("a Retry-After beyond the cap moves on rather than waiting it out", async () => {
    const { fetchStub } = stubFetch({
      "closed.example": answer({ status: 429, headers: { "Retry-After": "900" } }),
      "alive.example": answer(),
    });
    const waits = [];

    const bytes = await fetchFromGateways(CID, {
      gateways: ["https://closed.example/ipfs", "https://alive.example/ipfs"],
      fetchImpl: fetchStub,
      sleep: async (ms) => waits.push(ms),
    });

    expect(bytes).toEqual(BYTES);
    expect(waits).toEqual([]);
  });

  test("a short Retry-After is still honoured", async () => {
    const { fetchStub } = stubFetch({
      "busy.example": (attempt) =>
        attempt === 1 ? answer({ status: 429, headers: { "Retry-After": "2" } }) : answer(),
    });
    const waits = [];

    const bytes = await fetchFromGateways(CID, {
      gateways: ["https://busy.example/ipfs"],
      fetchImpl: fetchStub,
      sleep: async (ms) => waits.push(ms),
    });

    expect(bytes).toEqual(BYTES);
    expect(waits).toEqual([2000]);
    expect(waits[0]).toBeLessThanOrEqual(MAX_BACKOFF_MS);
  });
});

describe("what it refuses to accept as an answer", () => {
  test("an error page served with a 200 does not count", async () => {
    const html = new TextEncoder().encode("<!DOCTYPE html><html>nope</html>");
    const { fetchStub } = stubFetch({
      "liar.example": answer({ body: html, headers: { "content-type": "text/html" } }),
      "alive.example": answer(),
    });

    const bytes = await fetchFromGateways(CID, {
      gateways: ["https://liar.example/ipfs", "https://alive.example/ipfs"],
      fetchImpl: fetchStub,
    });

    expect(bytes).toEqual(BYTES);
  });

  test("every gateway failing says so, naming the CID", async () => {
    const { fetchStub } = stubFetch({ "gone.example": answer({ status: 410 }) });

    await expect(
      fetchFromGateways(CID, { gateways: ["https://gone.example/ipfs"], fetchImpl: fetchStub }),
    ).rejects.toThrow(new RegExp(CID));
  });
});

describe("trustless gateways", () => {
  test("accept is sent when asked for, and left off when not", async () => {
    const { fetchStub, seen } = stubFetch({ "trustless.example": answer() });

    await fetchFromGateways(CID, {
      gateways: ["https://trustless.example/ipfs"],
      accept: RAW_BLOCK,
      fetchImpl: fetchStub,
    });
    await fetchFromGateways(CID, {
      gateways: ["https://trustless.example/ipfs"],
      fetchImpl: fetchStub,
    });

    expect(seen.map((s) => s.accept)).toEqual([RAW_BLOCK, null]);
  });

  test("the trustless list is separate from the default one", () => {
    expect(TRUSTLESS_GATEWAYS).not.toHaveLength(0);
    for (const gateway of TRUSTLESS_GATEWAYS) {
      expect(DEFAULT_GATEWAYS).not.toContain(gateway);
    }
  });
});

describe("the default list", () => {
  /**
   * Not a style rule: each of these answered until it did not, and the package
   * kept asking. A gateway that is retired belongs in nobody's default.
   */
  test.each(["dweb.link", "ipfs.io", "w3s.link", "storacha.link"])(
    "does not contain %s, retired on 2026-09-21",
    (host) => {
      expect(DEFAULT_GATEWAYS.join(" ")).not.toContain(host);
    },
  );

  test("is not empty", () => {
    expect(DEFAULT_GATEWAYS.length).toBeGreaterThan(0);
  });
});
