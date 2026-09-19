/**
 * @fileoverview Pinata's pin-by-CID against the real service. Opt-in.
 *
 *     PINATA_LIVE=true PINATA_JWT=… npm test -- test/backends/pinata-live.test.js
 *
 * or the "Live backends" workflow, which takes the JWT from a repository
 * secret so it never sits on a laptop.
 *
 * Uploads, listing, deletion and a whole database round trip run in the shared
 * table (conformance.test.js, restore.test.js) when PINATA_LIVE is set. What
 * the table cannot do is pin by CID: Pinata fetches the content itself, from
 * the public IPFS network, and an in-process map is not that.
 *
 * Pin by CID is a paid-plan feature — the free plan answered 403 on 2026-09-17 —
 * so which check runs depends on the account:
 *
 *   - PINATA_PAID_PLAN=true: put a block on IPFS through Aleph, which needs no
 *     key, then ask Pinata to pin that CID, list it and serve it back.
 *   - otherwise: ask anyway, and require the refusal to arrive as UNSUPPORTED
 *     saying why, rather than as a missing file.
 */

import { jest, describe, test, expect } from "@jest/globals";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { createPinataBackend } from "../../lib/backends/pinata.js";
import { createAlephBackend } from "../../lib/backends/aleph.js";

const PIN_TIMEOUT_MS = 10 * 60_000;
jest.setTimeout(PIN_TIMEOUT_MS + 120_000);

const live = process.env.PINATA_LIVE === "true" && Boolean(process.env.PINATA_JWT);
const paid = process.env.PINATA_PAID_PLAN === "true";
const maybe = live ? describe : describe.skip;

if (!live) {
  console.log("⏭️  Skipping the live Pinata check — set PINATA_LIVE=true and PINATA_JWT to run it");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pinata = () =>
  createPinataBackend({
    jwt: process.env.PINATA_JWT,
    gateway: process.env.PINATA_GATEWAY || undefined,
    pinByCid: true,
  });

/** Unique bytes, so the CID has never been pinned before. */
const uniqueBytes = (label) =>
  new TextEncoder().encode(
    `@le-space/orbitdb-storage-bridge pinata ${label} ${new Date().toISOString()} ${Math.random()}`,
  );

/** Withdraw a pin request that never became a file, or it lands in the account later. */
const cancelPinRequest = async (requestId) => {
  if (!requestId) return;
  const response = await fetch(
    `https://api.pinata.cloud/v3/files/public/pin_by_cid/${requestId}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${process.env.PINATA_JWT}` } },
  ).catch((error) => ({ ok: false, status: error.message }));
  if (!response.ok) console.log(`   cleanup could not cancel request ${requestId}: ${response.status}`);
};

maybe("Pinata pin-by-CID, against the real service", () => {
  (paid ? test : test.skip)(
    "on a paid plan, a CID that is on IPFS gets pinned, listed, served back byte for byte, and removed",
    async () => {
      const backend = pinata();
      const bytes = uniqueBytes("pin check");
      const onIpfs = await createAlephBackend().putBlob(bytes, { name: "pinata-live-check.txt" });
      const cid = onIpfs.id;

      const handle = await backend.pinCid(cid, { name: "pinata-live-check" });
      let file;
      try {
        expect(handle.cid).toBe(cid);
        console.log(`   pin request ${handle.requestId} for ${cid}: ${handle.status ?? "(no status)"}`);

        // Pinata accepts the job at once and retrieves in the background; wait
        // until its own listing shows the file, then read it back.
        const started = Date.now();
        while (Date.now() - started < PIN_TIMEOUT_MS) {
          file = (await backend.list({ cid })).find((entry) => entry.cid === cid);
          if (file) break;
          await sleep(15_000);
        }
        expect(file?.cid).toBe(cid);
        console.log(`   listed after ${Math.round((Date.now() - started) / 1000)} s as file ${file.fileId}`);

        const back = await backend.getBlob(cid);
        expect(Buffer.from(back).equals(Buffer.from(bytes))).toBe(true);
      } finally {
        if (file) {
          await backend.remove(file).catch((error) => {
            console.log(`   cleanup could not remove ${cid}: ${error.message}`);
          });
        } else {
          await cancelPinRequest(handle.requestId);
        }
      }
    },
  );

  (paid ? test.skip : test)(
    "on the free plan, pin by CID is refused as UNSUPPORTED, saying why",
    async () => {
      const bytes = uniqueBytes("free plan probe");
      const cid = CID.create(1, raw.code, await sha256.digest(bytes)).toString();

      let handle;
      try {
        handle = await pinata().pinCid(cid);
      } catch (error) {
        console.log(`   refused: ${error.message.slice(0, 200)}`);
        expect(error.code).toBe("UNSUPPORTED");
        expect(error.message).toMatch(/paid-plan feature/);
        return;
      }
      // Accepted: this account has the feature after all.
      await cancelPinRequest(handle.requestId);
      throw new Error(
        "This Pinata account can pin by CID — set the repository variable PINATA_PAID_PLAN=true to run the full check",
      );
    },
  );
});
