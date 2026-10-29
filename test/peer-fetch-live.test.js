/**
 * @fileoverview Is the peer we ship as a constant still Aleph's? Opt-in.
 *
 * `PEERS_LIVE=true npm test -- test/peer-fetch-live.test.js`
 *
 * `ALEPH_BITSWAP` went stale without a sound. The docstring beside it promised
 * that the certificate hash rotates while the peer id outlives it, so a reader
 * — and this suite — had no reason to doubt the id. On 2026-10-29 the routing
 * answered with a different peer id altogether, which meant every address in
 * that constant had been dialling a node that was not there, and the only
 * place it showed was a demo whose gateway normally carries the restore.
 *
 * A unit test cannot catch that: the constant is only wrong out in the world.
 * So this uploads a blob through the Aleph driver, keyless, asks the routers
 * who holds it, and compares. When it fails it prints what the routing says,
 * so the fix is a copy and a paste.
 */

import { jest, describe, test, expect } from "@jest/globals";
import { createAlephBackend } from "../lib/backends/aleph.js";
import {
  providersFor,
  ALEPH_PEER_ID,
  isBrowserDialable,
} from "../lib/peer-fetch.js";

jest.setTimeout(120_000);

const live = process.env.PEERS_LIVE === "true";
const maybe = live ? describe : describe.skip;

maybe("the peer behind ALEPH_BITSWAP", () => {
  test("is the one the routing names for a blob Aleph has just taken", async () => {
    const backend = createAlephBackend();
    const bytes = crypto.getRandomValues(new Uint8Array(256));
    const { id: cid } = await backend.putBlob(bytes, {
      name: "peer-fetch-live.bin",
    });

    // The announcement was there 3 s after the upload when this was written;
    // a few tries cost little and save a flake.
    let found = [];
    for (let attempt = 0; attempt < 6 && found.length === 0; attempt++) {
      found = await providersFor(cid, { dialableOnly: false });
      if (found.length === 0)
        await new Promise((wait) => setTimeout(wait, 5_000));
    }

    const ids = found.map((provider) => provider.id);
    if (!ids.includes(ALEPH_PEER_ID)) {
      // Not a console.log for its own sake: this is the whole repair.
      console.log(
        `ALEPH_PEER_ID is ${ALEPH_PEER_ID}; the routing says ${ids.join(", ") || "nobody"}`,
      );
      for (const provider of found) {
        for (const addr of provider.addrs) {
          console.log(
            `  ${isBrowserDialable(addr) ? "page " : "node "} ${addr}`,
          );
        }
      }
    }
    expect(ids).toContain(ALEPH_PEER_ID);
  });
});
