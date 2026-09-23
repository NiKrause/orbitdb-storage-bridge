/**
 * @fileoverview Fetching by CID from peers rather than a gateway.
 *
 * Offline: `fetch` is a stub for the router, and the Helia node is replaced by
 * the two functions this module actually uses — `dial` and `cat`. That split
 * exists for this reason, and it means the tests assert behaviour (which
 * addresses are dialled, which path delivered, what is said when both fail)
 * rather than mocking libp2p.
 *
 * The live half — that a page can really dial `bitswap-v3.pinata.cloud` and
 * bitswap a block — was measured in a browser, and is recorded in the module's
 * docstring. No test here can prove it.
 */

import { jest, describe, test, expect } from "@jest/globals";
import {
  providersFor,
  isBrowserDialable,
  createPeerFetch,
  createGatewayFirstFetch,
  PINATA_BITSWAP,
  BROWSER_TRANSPORTS,
} from "../lib/peer-fetch.js";

const CID = "bafkreibjw4ccgiflcijrenzjpiptwsvhrkugkfzryan4wplryxfc6xrlrm";
const BYTES = new Uint8Array([1, 2, 3]);

const routerAnswer = (providers) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ Providers: providers }),
});

describe("which addresses a page could open", () => {
  test.each([
    ["/dns4/bitswap-v3.pinata.cloud/tcp/443/wss", true],
    ["/dns4/host.example/tcp/4003/tls/ws", true],
    ["/ip4/1.2.3.4/udp/4001/webrtc-direct/certhash/uEiAAAA", true],
    ["/ip4/1.2.3.4/udp/4001/quic-v1/webtransport/certhash/uEiAAAA", true],
    ["/ip4/1.2.3.4/tcp/4001", false],
    ["/ip4/1.2.3.4/udp/4001/quic-v1", false],
  ])("%s → %s", (addr, expected) => {
    expect(isBrowserDialable(addr)).toBe(expected);
  });

  test("a certificate cannot be issued for a bare IP, so ws on one is not dialable", () => {
    // Well-formed, and useless from a page: the TLS name would never match.
    expect(isBrowserDialable("/ip4/1.2.3.4/tcp/443/wss")).toBe(false);
    expect(isBrowserDialable("/dns4/host.example/tcp/443/wss")).toBe(true);
  });

  test("the transports named are the ones a browser has", () => {
    expect(BROWSER_TRANSPORTS).toContain("/wss");
    expect(BROWSER_TRANSPORTS).not.toContain("/tcp");
  });
});

describe("asking who holds a CID", () => {
  test("keeps the dialable addresses and drops the rest", async () => {
    const fetchImpl = jest.fn(async () =>
      routerAnswer([
        {
          ID: "12D3KooWaaa",
          Addrs: ["/ip4/1.2.3.4/tcp/4001", "/ip4/1.2.3.4/udp/4001/webrtc-direct/certhash/uEiA"],
        },
        { ID: "12D3KooWbbb", Addrs: ["/ip4/5.6.7.8/tcp/4001"] },
      ]),
    );

    const found = await providersFor(CID, { fetchImpl });

    expect(found).toHaveLength(1);
    expect(found[0].id).toBe("12D3KooWaaa");
    expect(found[0].addrs).toEqual(["/ip4/1.2.3.4/udp/4001/webrtc-direct/certhash/uEiA"]);
  });

  test("dialableOnly: false keeps what a Node caller can still use", async () => {
    const fetchImpl = jest.fn(async () =>
      routerAnswer([{ ID: "12D3KooWaaa", Addrs: ["/ip4/1.2.3.4/tcp/4001"] }]),
    );

    const found = await providersFor(CID, { fetchImpl, dialableOnly: false });

    expect(found[0].addrs).toEqual(["/ip4/1.2.3.4/tcp/4001"]);
  });

  test("reads a streamed answer, one record per line", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        [
          JSON.stringify({ ID: "12D3KooWaaa", Addrs: ["/dns4/a.example/tcp/443/wss"] }),
          JSON.stringify({ ID: "12D3KooWbbb", Addrs: ["/dns4/b.example/tcp/443/wss"] }),
          "", // a stream ends with one
        ].join("\n"),
    }));

    const found = await providersFor(CID, { fetchImpl });

    expect(found.map((p) => p.id)).toEqual(["12D3KooWaaa", "12D3KooWbbb"]);
  });

  test("merges the same peer seen at two routers, without duplicating an address", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        routerAnswer([{ ID: "12D3KooWaaa", Addrs: ["/dns4/a.example/tcp/443/wss"] }]),
      )
      .mockResolvedValueOnce(
        routerAnswer([
          {
            ID: "12D3KooWaaa",
            Addrs: ["/dns4/a.example/tcp/443/wss", "/dns4/b.example/tcp/443/wss"],
          },
        ]),
      );

    const found = await providersFor(CID, {
      fetchImpl,
      routers: ["https://one.example", "https://two.example"],
    });

    expect(found).toHaveLength(1);
    expect(found[0].addrs).toEqual(["/dns4/a.example/tcp/443/wss", "/dns4/b.example/tcp/443/wss"]);
  });

  test("a router that refuses is skipped, not fatal", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => "" })
      .mockResolvedValueOnce(
        routerAnswer([{ ID: "12D3KooWaaa", Addrs: ["/dns4/a.example/tcp/443/wss"] }]),
      );

    const found = await providersFor(CID, {
      fetchImpl,
      routers: ["https://rate-limited.example", "https://fine.example"],
    });

    expect(found).toHaveLength(1);
  });
});

describe("fetching over peers", () => {
  const cat = (bytes = BYTES) =>
    jest.fn(async function* () {
      yield bytes.subarray(0, 1);
      yield bytes.subarray(1);
    });

  test("dials what it was given and returns the reassembled bytes", async () => {
    const dialled = [];
    const fetchBytes = createPeerFetch({
      providers: [PINATA_BITSWAP],
      dial: async (addr) => dialled.push(addr),
      cat: cat(),
    });

    const bytes = await fetchBytes(CID);

    expect(dialled).toEqual([PINATA_BITSWAP]);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  test("a chunked file arrives whole, not as its first block", async () => {
    const big = new Uint8Array(300).fill(9);
    const fetchBytes = createPeerFetch({
      providers: ["/dns4/a.example/tcp/443/wss"],
      dial: async () => {},
      cat: jest.fn(async function* () {
        yield big.subarray(0, 256);
        yield big.subarray(256);
      }),
    });

    const bytes = await fetchBytes(CID);

    expect(bytes.length).toBe(300);
  });

  test("providers can be looked up per CID", async () => {
    const asked = [];
    const fetchBytes = createPeerFetch({
      providers: async (cid) => {
        asked.push(cid);
        return ["/dns4/found.example/tcp/443/wss"];
      },
      dial: async () => {},
      cat: cat(),
    });

    await fetchBytes(CID);

    expect(asked).toEqual([CID]);
  });

  test("one address failing is fine as long as another answers", async () => {
    const fetchBytes = createPeerFetch({
      providers: ["/dns4/down.example/tcp/443/wss", "/dns4/up.example/tcp/443/wss"],
      dial: async (addr) => {
        if (addr.includes("down")) throw new Error("connection refused");
      },
      cat: cat(),
    });

    await expect(fetchBytes(CID)).resolves.toBeInstanceOf(Uint8Array);
  });

  test("no provider at all says so before dialling anything", async () => {
    const fetchBytes = createPeerFetch({ providers: [], dial: async () => {}, cat: cat() });

    await expect(fetchBytes(CID)).rejects.toThrow(/No provider to dial/);
  });

  test("every dial failing names how many were tried", async () => {
    const fetchBytes = createPeerFetch({
      providers: ["/dns4/a.example/tcp/443/wss", "/dns4/b.example/tcp/443/wss"],
      dial: async () => {
        throw new Error("nope");
      },
      cat: cat(),
    });

    await expect(fetchBytes(CID)).rejects.toThrow(/tried 2/);
  });
});

describe("gateway first, peers behind it", () => {
  test("a gateway that answers is the whole story", async () => {
    const paths = [];
    const viaPeers = jest.fn();
    const fetchBytes = createGatewayFirstFetch({
      viaGateway: async () => BYTES,
      viaPeers,
      onPath: (path, info) => paths.push([path, info.bytes]),
    });

    await fetchBytes(CID);

    expect(paths).toEqual([["gateway", 3]]);
    expect(viaPeers).not.toHaveBeenCalled();
  });

  test("a gateway that fails hands over, and the page is told why", async () => {
    const paths = [];
    const fetchBytes = createGatewayFirstFetch({
      viaGateway: async () => {
        throw new Error("429 from every gateway");
      },
      viaPeers: async () => BYTES,
      onPath: (path, info) => paths.push([path, info.after?.error]),
    });

    const bytes = await fetchBytes(CID);

    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(paths).toEqual([["peers", "429 from every gateway"]]);
  });

  test("the gateway gets a short timeout, not the caller's", async () => {
    let seen = null;
    const fetchBytes = createGatewayFirstFetch({
      viaGateway: async (_cid, options) => {
        seen = options.timeout;
        return BYTES;
      },
      viaPeers: async () => BYTES,
      gatewayTimeout: 2500,
    });

    await fetchBytes(CID, { timeout: 60_000 });

    expect(seen).toBe(2500);
  });

  test("both failing says both reasons, because either one alone is misleading", async () => {
    const fetchBytes = createGatewayFirstFetch({
      viaGateway: async () => {
        throw new Error("gateway retired");
      },
      viaPeers: async () => {
        throw new Error("no provider to dial");
      },
    });

    await expect(fetchBytes(CID)).rejects.toThrow(
      /gateway retired.*no provider to dial/s,
    );
  });
});
