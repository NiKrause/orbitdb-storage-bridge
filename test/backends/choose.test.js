/**
 * @fileoverview A backend from a name and a key — what a page has, rather than
 * what a Node caller has.
 *
 * Offline, and deliberately not a test of the vendors: what is asserted here is
 * that a choice is turned into the right driver, that a missing credential is
 * refused with the service named rather than at the first upload, and that
 * several choices become a mirror instead of a loop in the caller.
 */

import { jest, describe, test, expect, afterEach } from "@jest/globals";
import {
  createBackendFromChoice,
  BACKEND_KINDS,
} from "../../lib/backends/choose.js";

describe("a backend from a choice", () => {
  test("aleph needs nothing, which is why it is the default anywhere", async () => {
    const backend = await createBackendFromChoice({ kind: "aleph" });
    expect(backend.name).toBe("aleph");
    expect(backend.capabilities.browserSafeAuth).toBe(true);
  });

  test("a missing key is refused here, with the service named", async () => {
    await expect(
      createBackendFromChoice({ kind: "lighthouse" }),
    ).rejects.toThrow(/Lighthouse needs an apiKey/);
    await expect(createBackendFromChoice({ kind: "pinata" })).rejects.toThrow(
      /Pinata needs a JWT, or a getUploadUrl/,
    );
  });

  test("whose Lighthouse key it is decides whether a page may hold it", async () => {
    const shared = await createBackendFromChoice({
      kind: "lighthouse",
      apiKey: "x",
    });
    const own = await createBackendFromChoice({
      kind: "lighthouse",
      apiKey: "x",
      keyOwnership: "user",
    });
    expect(shared.capabilities.browserSafeAuth).toBe(false);
    expect(own.capabilities.browserSafeAuth).toBe(true);
  });

  test("several kinds become a mirror", async () => {
    const backend = await createBackendFromChoice({
      kind: ["aleph", "memory"],
    });
    expect(backend.name).toBe("mirror(aleph+memory)");
    expect(backend.backends).toHaveLength(2);
  });

  test("an unknown or missing name says what the choices are", async () => {
    await expect(createBackendFromChoice({ kind: "dropbox" })).rejects.toThrow(
      /Unknown backend "dropbox"/,
    );
    await expect(createBackendFromChoice({})).rejects.toThrow(/Pick a backend/);
    expect(BACKEND_KINDS).toContain("lighthouse");
  });

  test("resolveBackend takes the same choice, so there is one decision", async () => {
    const { resolveBackend } = await import("../../lib/backends/resolve.js");
    const backend = await resolveBackend({ kind: "memory" });
    expect(backend.name).toBe("memory");
  });
});

/**
 * Where a read goes, rather than what the driver was handed.
 *
 * Since the public path gateways were retired (#111) the usable gateway is
 * normally the reader's own account's, and the two services' gateways refuse
 * each other's content — Pinata answers 401, Lighthouse 402. So the thing
 * worth asserting is the URL the driver actually asks.
 */
describe("the gateway a read goes to", () => {
  const CID = "bafkreibjw4ccgiflcijrenzjpiptwsvhrkugkfzryan4wplryxfc6xrlrm";
  const realFetch = globalThis.fetch;
  let asked;

  /** @param {(url: string) => boolean} [refuse] hosts that answer 404 */
  const stubFetch = (refuse = () => false) => {
    asked = [];
    globalThis.fetch = jest.fn(async (url) => {
      asked.push(String(url));
      const denied = refuse(String(url));
      return {
        ok: !denied,
        status: denied ? 404 : 200,
        statusText: denied ? "Not Found" : "OK",
        headers: { get: () => null },
        text: async () => (denied ? "not here" : ""),
        arrayBuffer: async () => new Uint8Array([7]).buffer,
      };
    });
  };

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("pinata reads from the account's own gateway", async () => {
    stubFetch();
    const backend = await createBackendFromChoice({
      kind: "pinata",
      jwt: "test",
      gateway: "https://silver-fox.mypinata.cloud",
    });

    await backend.getBlob({ id: CID });

    expect(asked.some((url) => url.startsWith("https://silver-fox.mypinata.cloud/ipfs/"))).toBe(true);
  });

  test("lighthouse reads from the account's own gateway, bare domain and all", async () => {
    stubFetch();
    const backend = await createBackendFromChoice({
      kind: "lighthouse",
      apiKey: "test",
      keyOwnership: "user",
      gateway: "preferred-cat.lighthouseweb3.xyz",
    });

    await backend.getBlob({ id: CID });

    expect(asked.some((url) => url.startsWith("https://preferred-cat.lighthouseweb3.xyz/ipfs/"))).toBe(true);
  });

  test("aleph takes a host and asks it under /ipfs, because its driver tries a list", async () => {
    stubFetch();
    const backend = await createBackendFromChoice({
      kind: "aleph",
      gateway: "my-own-node.example",
    });

    await backend.getBlob({ id: CID });

    expect(asked[0]).toBe(`https://my-own-node.example/ipfs/${CID}`);
  });

  test("an explicit list still wins over a single gateway", async () => {
    stubFetch();
    const backend = await createBackendFromChoice({
      kind: "aleph",
      gateway: "ignored.example",
      gateways: ["https://listed.example/ipfs"],
    });

    await backend.getBlob({ id: CID });

    expect(asked[0]).toBe(`https://listed.example/ipfs/${CID}`);
  });

  test("each service in a mirror keeps its own gateway", async () => {
    // Pinata refuses, so the mirror falls through to Lighthouse — which is the
    // only way to see that the second driver got the *second* gateway rather
    // than a copy of the first.
    stubFetch((url) => url.includes("mypinata.cloud"));
    const backend = await createBackendFromChoice({
      kind: ["pinata", "lighthouse"],
      jwt: "test",
      apiKey: "test",
      gateway: {
        pinata: "https://silver-fox.mypinata.cloud",
        lighthouse: "https://preferred-cat.lighthouseweb3.xyz",
      },
    });

    await backend.getBlob({ id: CID });

    expect(asked.some((url) => url.startsWith("https://silver-fox.mypinata.cloud/ipfs/"))).toBe(true);
    expect(asked.some((url) => url.startsWith("https://preferred-cat.lighthouseweb3.xyz/ipfs/"))).toBe(true);
  });

  test("one gateway for several services is refused, not shared out", async () => {
    await expect(
      createBackendFromChoice({
        kind: ["pinata", "lighthouse"],
        jwt: "test",
        apiKey: "test",
        gateway: "https://silver-fox.mypinata.cloud",
      }),
    ).rejects.toThrow(/belongs to one service/);
  });
});
