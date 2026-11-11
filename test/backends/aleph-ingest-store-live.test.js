/**
 * @fileoverview The two-step Aleph path, watched rather than relied on: an
 * upload to the IPFS host (`/api/v0/add`), then a separate STORE that Aleph's
 * nodes must fetch the file for. Opt-in; in the daily smoke test it is a
 * step that may fail without failing the run.
 *
 *     ALEPH_LIVE=true ALEPH_PRIVATE_KEY=0x… npm test -- test/backends/aleph-ingest-store-live.test.js
 *
 * From about 2026-11-04 every such STORE was rejected with `error_code` 4
 * ("could not retrieve IPFS content at this time"), and on 2026-11-11 it sat
 * `pending` for more than twenty minutes. A pin that signs no longer takes this
 * path for an upload (`lib/backends/aleph.js`), but `pinCid` still depends on
 * it; this says, every day, whether it works again.
 */

import { jest, describe, test, expect } from "@jest/globals";
import { createAlephBackend } from "../../lib/backends/aleph.js";
import {
  createAlephPin,
  createAlephForget,
  waitForMessage,
} from "../../lib/backends/aleph-pin.js";
import { createEthSigner } from "../helpers/eth-signer.js";
import { SMOKE_CHANNEL } from "./drivers.js";

jest.setTimeout(300_000);

const live =
  process.env.ALEPH_LIVE === "true" && Boolean(process.env.ALEPH_PRIVATE_KEY);
const maybe = live ? describe : describe.skip;

maybe("upload to the IPFS host, then a separate STORE", () => {
  test("Aleph's nodes fetch the file and the STORE ends processed", async () => {
    const { address, sign } = createEthSigner(process.env.ALEPH_PRIVATE_KEY);
    const pin = createAlephPin({
      sender: address,
      sign,
      channel: SMOKE_CHANNEL,
      ref: "ingest-then-store",
    });
    // No pin on the backend: the upload goes to the IPFS host, as before.
    const ingest = createAlephBackend();
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(2048));
    const handle = await ingest.putBlob(bytes, { name: "two-step.bin" });
    const sent = await pin(handle.id, { size: bytes.length });
    const final =
      sent.status === "processed"
        ? { status: "processed" }
        : await waitForMessage(sent.itemHash, {
            timeout: 240_000,
            interval: 10_000,
          });
    if (final.status === "processed") {
      const forget = createAlephForget({
        sender: address,
        sign,
        channel: SMOKE_CHANNEL,
      });
      await forget([sent.itemHash], "smoke test").catch(() => {});
    }
    expect(
      `STORE ${sent.itemHash} for ${handle.id} (uploaded to ipfs.aleph.cloud/api/v0/add): ${final.status}` +
        (final.errorCode != null ? `, error_code ${final.errorCode}` : "") +
        (final.errorCode === 4
          ? " — the nodes could not fetch the file from the IPFS host"
          : "") +
        (final.timedOut ? " after 240 s" : ""),
    ).toBe(
      `STORE ${sent.itemHash} for ${handle.id} (uploaded to ipfs.aleph.cloud/api/v0/add): processed`,
    );
  });
});
