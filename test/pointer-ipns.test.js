/**
 * @fileoverview A pointer a second device can find with nothing but a key.
 *
 * The routing endpoint here is a few lines of `node:http` in this file, so the
 * suite needs no network and no third party. What it cannot test is the part
 * that is somebody else's: whether a public endpoint takes a record, keeps it,
 * and hands it back. That was measured separately
 * (`test/helpers/probe-ipns-routing.js`), and the module's own doc comment says
 * what the measurement did and did not establish.
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { createServer } from "node:http";

import {
  derivePointerKey,
  pointerName,
  publishPointer,
  resolvePointer,
} from "../lib/pointer-ipns.js";

const CID_ONE = "bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354";
const CID_TWO = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const SEED = new TextEncoder().encode(
  "not a real PRF output, but the same shape",
);

/** A routing endpoint of our own, and a note of everything it was asked. */
function startEndpoint({ refuse = false, missAs200 = false } = {}) {
  const records = new Map();
  const asked = [];
  const server = createServer((request, response) => {
    const name = request.url.split("/").pop();
    asked.push(`${request.method} ${name}`);
    if (refuse) {
      response.writeHead(503).end("busy");
      return;
    }
    if (request.method === "PUT") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        records.set(name, Buffer.concat(chunks));
        response.writeHead(200).end();
      });
      return;
    }
    const record = records.get(name);
    if (!record) {
      // What delegated-ipfs.dev really answers for a name it does not hold.
      if (missAs200) {
        response
          .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
          .end("delegate error: routing: not found\n");
        return;
      }
      response.writeHead(404).end("not found");
      return;
    }
    response
      .writeHead(200, { "content-type": "application/vnd.ipfs.ipns-record" })
      .end(record);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        records,
        asked,
        stop: () => new Promise((done) => server.close(done)),
      }),
    );
  });
}

describe("pointer-ipns — a name computed from a seed, not remembered", () => {
  let endpoint;

  beforeAll(async () => {
    endpoint = await startEndpoint();
  });

  afterAll(async () => {
    await endpoint.stop();
  });

  test("the same seed gives the same name, on any device, for ever", async () => {
    const here = await derivePointerKey(SEED);
    const there = await derivePointerKey(SEED);

    expect(pointerName(here)).toBe(pointerName(there));
    // The canonical spelling of an IPNS name, which is what gateways and
    // routing endpoints expect to be handed.
    expect(pointerName(here)).toMatch(/^k51/);
  });

  test("a label separates two pointers of one seed", async () => {
    const backup = await derivePointerKey(SEED, { label: "backup" });
    const somethingElse = await derivePointerKey(SEED, { label: "other" });

    expect(pointerName(backup)).not.toBe(pointerName(somethingElse));
  });

  test("a different seed is a different name", async () => {
    const mine = await derivePointerKey(SEED);
    const theirs = await derivePointerKey(
      new TextEncoder().encode("somebody else's key entirely"),
    );

    expect(pointerName(mine)).not.toBe(pointerName(theirs));
  });

  test("published once, found again from the key alone", async () => {
    const key = await derivePointerKey(SEED, { label: "round-trip" });
    const published = await publishPointer({
      privateKey: key,
      cid: CID_ONE,
      endpoints: [endpoint.url],
    });
    expect(published.name).toBe(pointerName(key));
    expect(published.results).toEqual([
      { endpoint: endpoint.url, ok: true, status: 200 },
    ]);

    // A second device: the same seed, nothing else.
    const elsewhere = await derivePointerKey(SEED, { label: "round-trip" });
    const found = await resolvePointer({
      privateKey: elsewhere,
      endpoints: [endpoint.url],
    });

    expect(found.cid).toBe(CID_ONE);
    expect(found.name).toBe(published.name);
    expect(found.sequence).toBe(published.sequence);
  });

  test("a newer pointer replaces the older one under the same name", async () => {
    const key = await derivePointerKey(SEED, { label: "moving" });
    await publishPointer({
      privateKey: key,
      cid: CID_ONE,
      endpoints: [endpoint.url],
      sequence: 1n,
    });
    await publishPointer({
      privateKey: key,
      cid: CID_TWO,
      endpoints: [endpoint.url],
      sequence: 2n,
    });

    const found = await resolvePointer({
      privateKey: key,
      endpoints: [endpoint.url],
    });
    expect(found.cid).toBe(CID_TWO);
    expect(found.sequence).toBe(2n);
  });

  test("a record signed by another key is refused under our name", async () => {
    // What a dishonest or confused endpoint would hand back. The name is the
    // hash of the key that signs, so this is catchable — and caught.
    const key = await derivePointerKey(SEED, { label: "forgery" });
    const impostor = await derivePointerKey(SEED, { label: "impostor" });
    await publishPointer({
      privateKey: impostor,
      cid: CID_TWO,
      endpoints: [endpoint.url],
    });
    endpoint.records.set(
      pointerName(key),
      endpoint.records.get(pointerName(impostor)),
    );

    await expect(
      resolvePointer({ privateKey: key, endpoints: [endpoint.url] }),
    ).rejects.toThrow(/no endpoint had a valid pointer/);
  });

  test("one endpoint out of two is enough to publish, and to find", async () => {
    const broken = await startEndpoint({ refuse: true });
    const key = await derivePointerKey(SEED, { label: "two endpoints" });

    const published = await publishPointer({
      privateKey: key,
      cid: CID_ONE,
      endpoints: [broken.url, endpoint.url],
    });
    expect(published.results.map((result) => result.ok)).toEqual([false, true]);

    const found = await resolvePointer({
      privateKey: key,
      endpoints: [broken.url, endpoint.url],
    });
    expect(found.cid).toBe(CID_ONE);

    await broken.stop();
  });

  test("an endpoint that refuses everything is an error with its reasons in it", async () => {
    const broken = await startEndpoint({ refuse: true });
    const key = await derivePointerKey(SEED, { label: "nowhere" });

    await expect(
      publishPointer({
        privateKey: key,
        cid: CID_ONE,
        endpoints: [broken.url],
      }),
    ).rejects.toThrow(/no endpoint took the pointer.*503/s);

    await expect(
      resolvePointer({ privateKey: key, endpoints: [broken.url] }),
    ).rejects.toThrow(/503/);

    await broken.stop();
  });

  test("a name nobody has published is a plain not-found, not a crash", async () => {
    const key = await derivePointerKey(SEED, { label: "never published" });

    await expect(
      resolvePointer({ privateKey: key, endpoints: [endpoint.url] }),
    ).rejects.toThrow(/404/);
  });

  test("a miss dressed as 200 says what the endpoint said, not what our parser thinks", async () => {
    // delegated-ipfs.dev answers an unknown name with 200 and a sentence in
    // text/plain. Read as a record that is "invalid wire type 4 at offset 1",
    // which sends the reader after a protocol fault instead of a missing
    // pointer.
    const polite = await startEndpoint({ missAs200: true });
    const key = await derivePointerKey(SEED, {
      label: "a miss dressed as 200",
    });

    const failed = await resolvePointer({
      privateKey: key,
      endpoints: [polite.url],
    }).catch((error) => error);

    expect(failed.message).toMatch(/routing: not found/);
    expect(failed.message).not.toMatch(/wire type/);

    await polite.stop();
  });

  test("bytes that are a record for another name still fail as a bad record", async () => {
    // The message above is for prose, not for a signature that does not hold:
    // that one is the validator's to report, and worth reading as such.
    const mine = await derivePointerKey(SEED, { label: "mine" });
    const theirs = await derivePointerKey(SEED, { label: "theirs" });
    await publishPointer({
      privateKey: theirs,
      cid: CID_ONE,
      endpoints: [endpoint.url],
    });
    // Serve their record under my name.
    endpoint.records.set(
      pointerName(mine),
      endpoint.records.get(pointerName(theirs)),
    );

    const failed = await resolvePointer({
      privateKey: mine,
      endpoints: [endpoint.url],
    }).catch((error) => error);

    expect(failed.message).toMatch(new RegExp(pointerName(mine)));
    expect(failed.message).not.toMatch(/routing: not found/);
  });
});
