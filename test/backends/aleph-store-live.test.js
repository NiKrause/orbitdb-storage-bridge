/**
 * @fileoverview Aleph with a real, funded account: a STORE sent, processed,
 * listed, retrieved and FORGOTTEN again. Opt-in, and part of the daily smoke
 * test (`.github/workflows/live-backends.yml`).
 *
 *     ALEPH_LIVE=true ALEPH_PRIVATE_KEY=0x… npm test -- test/backends/aleph-store-live.test.js
 *
 * `aleph-live.test.js` is keyless and never asked Aleph to *keep* anything,
 * which is exactly what broke on 2026-11-04: a STORE sent after an upload to
 * the IPFS host was rejected with `error_code` 4, "could not retrieve IPFS
 * content", and nothing here noticed. This suite takes the path a pin that
 * signs takes — upload and STORE in one call to the API node — and waits for
 * Aleph's decision. A few KB, paid in credits, forgotten at the end.
 *
 * The tests run in order and each names its step and endpoint, so a red run
 * says where it broke.
 */

import { jest, describe, test, expect, afterAll } from "@jest/globals";
import { createAlephBackend } from "../../lib/backends/aleph.js";
import {
  DEFAULT_ALEPH_API_HOST,
  createAlephPin,
  createAlephForget,
  listAlephStores,
  waitForMessage,
} from "../../lib/backends/aleph-pin.js";
import { matchesUnixfsCid, unixfsCid } from "../../lib/backends/aleph-upload.js";
import { createEthSigner } from "../helpers/eth-signer.js";
import { SMOKE_CHANNEL } from "./drivers.js";

jest.setTimeout(240_000);

const live =
  process.env.ALEPH_LIVE === "true" && Boolean(process.env.ALEPH_PRIVATE_KEY);
const maybe = live ? describe : describe.skip;
if (!live) {
  console.log(
    "⏭️  Skipping the signed Aleph check — set ALEPH_LIVE=true and ALEPH_PRIVATE_KEY to run it",
  );
}

const API = DEFAULT_ALEPH_API_HOST;
const REF = `smoke-${new Date().toISOString().slice(0, 10)}`;

/** Aleph's decision about a message, said so that a log line is enough. */
const describeFinal = (what, final) =>
  `${what}: ${final.status}` +
  (final.errorCode != null ? `, error_code ${final.errorCode}` : "") +
  (final.timedOut ? " (still pending when the wait ran out)" : "") +
  (final.details ? ` — ${JSON.stringify(final.details).slice(0, 300)}` : "");

maybe("a real STORE on Aleph, from upload to FORGET", () => {
  const { address, sign } = live
    ? createEthSigner(process.env.ALEPH_PRIVATE_KEY)
    : { address: "", sign: async () => "" };
  const pin = live
    ? createAlephPin({ sender: address, sign, channel: SMOKE_CHANNEL, ref: REF })
    : null;
  const forget = live
    ? createAlephForget({ sender: address, sign, channel: SMOKE_CHANNEL })
    : null;
  const backend = live ? createAlephBackend({ pin }) : null;

  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(3072));
  /** @type {any} */
  let handle;
  let forgotten = false;
  const needUpload = () => {
    if (!handle?.itemHash)
      throw new Error("nothing to check: the upload and STORE step failed");
  };

  afterAll(async () => {
    // A run that broke halfway still lets go of what it stored.
    if (handle?.itemHash && !forgotten) {
      await forget([handle.itemHash], "smoke test cleanup").catch(() => {});
    }
  });

  test("the API node answers (GET /api/v0/version)", async () => {
    const response = await fetch(`${API}/api/v0/version`);
    expect(`${API}/api/v0/version → ${response.status}`).toBe(
      `${API}/api/v0/version → 200`,
    );
    console.log(`account ${address}, API ${(await response.json()).version}`);
  });

  test("upload and STORE in one call (POST /api/v0/ipfs/add_file) end processed", async () => {
    handle = await backend.putBlob(bytes, { name: "smoke.bin" });
    expect(handle.id).toBe(await unixfsCid(bytes));
    expect(handle.itemHash).toMatch(/^[0-9a-f]{64}$/);
    const final =
      handle.status === "processed"
        ? { status: "processed" }
        : await waitForMessage(handle.itemHash, {
            timeout: 180_000,
            interval: 5_000,
          });
    expect(
      describeFinal(`STORE ${handle.itemHash} (cid ${handle.id})`, final),
    ).toBe(`STORE ${handle.itemHash} (cid ${handle.id}): processed`);
  });

  test("the STORE is listed for its owner (GET /api/v0/messages.json)", async () => {
    needUpload();
    // The messages index can trail the decision by a moment.
    let found;
    for (let i = 0; i < 12 && !found; i++) {
      if (i) await new Promise((r) => setTimeout(r, 5_000));
      const { stores } = await listAlephStores({
        owner: address,
        channel: SMOKE_CHANNEL,
        ref: REF,
      });
      found = stores.find((s) => s.itemHash === handle.itemHash);
    }
    expect(found).toMatchObject({ cid: handle.id, size: bytes.length });
  });

  test("the API node serves the file (GET /api/v0/storage/raw/<cid>), verified against the CID", async () => {
    needUpload();
    const url = `${API}/api/v0/storage/raw/${handle.id}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
    expect(`${url} → ${response.status}`).toBe(`${url} → 200`);
    const back = new Uint8Array(await response.arrayBuffer());
    expect(await matchesUnixfsCid(handle.id, back)).toBe(true);
    expect(Buffer.from(back).equals(Buffer.from(bytes))).toBe(true);
  });

  test("the gateway serves the file (https://ipfs.aleph.cloud/ipfs/<cid>), verified against the CID", async () => {
    needUpload();
    // getBlob checks the bytes against the CID and the size itself.
    const back = await backend.getBlob(handle);
    expect(Buffer.from(back).equals(Buffer.from(bytes))).toBe(true);
  });

  test("a FORGET is processed and the STORE is forgotten", async () => {
    needUpload();
    const sent = await forget([handle.itemHash], "smoke test");
    const final =
      sent.status === "processed"
        ? { status: "processed" }
        : await waitForMessage(sent.itemHash, {
            timeout: 180_000,
            interval: 5_000,
          });
    expect(describeFinal(`FORGET ${sent.itemHash}`, final)).toBe(
      `FORGET ${sent.itemHash}: processed`,
    );
    forgotten = true;
    const store = await waitForMessage(handle.itemHash, {
      timeout: 60_000,
      interval: 5_000,
    });
    expect(["forgotten", "removing", "removed"]).toContain(store.status);
  });
});
