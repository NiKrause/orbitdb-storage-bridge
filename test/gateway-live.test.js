/**
 * @fileoverview Are the gateways we default to still serving? Opt-in.
 *
 * `GATEWAYS_LIVE=true npm test -- test/gateway-live.test.js`
 *
 * Issue #111 is why this exists: `ipfs.io`, `dweb.link`, `w3s.link` and
 * `storacha.link` were retired on 2026-09-21 and nothing here noticed, because
 * the first entry of every chain still answered and the dead tail behind it is
 * only reached when the first one has a bad minute.
 *
 * A unit test cannot catch that — the list is only wrong out in the world. So
 * this uploads a blob through the Aleph driver, keyless, and asks every
 * default gateway for it by CID. It also looks for the RFC 8594 `Sunset`
 * header, which is the warning a gateway gives weeks before it goes quiet: a
 * failing test here should ideally arrive *before* users notice.
 *
 * `TRUSTLESS_GATEWAYS` is not checked this way on purpose. Whether
 * `trustless-gateway.link` can serve a given CID depends on that CID being
 * announced to the network by whoever holds it, which is a fact about Aleph
 * and the DHT rather than about this package's configuration.
 */

import { jest, describe, test, expect, beforeAll } from "@jest/globals";
import { createAlephBackend, ALEPH_GATEWAYS } from "../lib/backends/aleph.js";
import { DEFAULT_GATEWAYS } from "../lib/gateway-fetch.js";

jest.setTimeout(120_000);

const live = process.env.GATEWAYS_LIVE === "true";
const maybe = live ? describe : describe.skip;

if (!live) {
  console.log("⏭️  Skipping the live gateway check — set GATEWAYS_LIVE=true to run it");
}

/** Every gateway this package would reach for, without duplicates. */
const CONFIGURED = [...new Set([...DEFAULT_GATEWAYS, ...ALEPH_GATEWAYS])];

maybe("the gateways this package defaults to", () => {
  let cid;
  let expected;

  beforeAll(async () => {
    expected = new Uint8Array(64);
    for (let i = 0; i < expected.length; i++) expected[i] = (i * 37 + 11) % 256;
    const handle = await createAlephBackend().putBlob(expected);
    cid = handle.id ?? handle;
  });

  test.each(CONFIGURED)("%s serves a blob that was just uploaded", async (gateway) => {
    const response = await fetch(`${gateway}/${cid}`, { signal: AbortSignal.timeout(60_000) });

    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes)).toEqual(Array.from(expected));
  });

  test.each(CONFIGURED)("%s does not announce a sunset", async (gateway) => {
    const response = await fetch(`${gateway}/${cid}`, { signal: AbortSignal.timeout(60_000) });
    const sunset = response.headers.get("Sunset");

    // Not an assertion about kindness: a gateway that has published a
    // retirement date is one this package has to stop defaulting to, and the
    // date is how much time there is to do it.
    expect(sunset).toBeNull();
  });
});
