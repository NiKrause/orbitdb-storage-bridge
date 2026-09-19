/**
 * @fileoverview Does PINATA_GATEWAY serve what this key's account uploads, and how soon?
 *
 *     PINATA_JWT=… PINATA_GATEWAY=… node test/helpers/probe-pinata-gateway.js
 *
 * A dedicated gateway serves only what its owner has pinned. A gateway that belongs
 * to a different account than the key refuses every read with 403 ERR_ID:00006 — and
 * so, possibly, does the right gateway while a fresh upload has not reached it yet.
 * The live suites cannot tell those apart; this can. It uploads a few unique bytes,
 * asks the gateway every 5 s until it serves them or 90 s have passed, and deletes
 * the file again. Prints timings and the gateway's answer, never the key.
 */

import { createPinataBackend } from "../../lib/backends/pinata.js";

const TIMEOUT_MS = 90_000;
const INTERVAL_MS = 5_000;

if (!process.env.PINATA_GATEWAY) {
  console.log("No PINATA_GATEWAY: reads go through the shared gateway, nothing to probe.");
  process.exit(0);
}

const pinata = createPinataBackend({
  jwt: process.env.PINATA_JWT,
  gateway: process.env.PINATA_GATEWAY,
  gatewayRetries: 0,
});
const bytes = new TextEncoder().encode(
  `@le-space/orbitdb-storage-bridge gateway probe ${new Date().toISOString()} ${Math.random()}`,
);

let handle;
try {
  handle = await pinata.putBlob(bytes, { name: "gateway-probe.txt" });
} catch (error) {
  console.log(`::error::The probe could not upload: ${error.message.slice(0, 240)}`);
  process.exit(1);
}

const started = Date.now();
const elapsed = () => Math.round((Date.now() - started) / 1000);
let served = false;
let lastAnswer = "";
try {
  while (Date.now() - started < TIMEOUT_MS) {
    try {
      const back = await pinata.getBlob(handle);
      if (Buffer.from(back).equals(Buffer.from(bytes))) {
        served = true;
        break;
      }
      lastAnswer = "served different bytes";
    } catch (error) {
      lastAnswer = error.message.slice(0, 240);
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
} finally {
  await pinata.remove(handle).catch((error) => {
    console.log(`cleanup could not remove the probe file: ${error.message}`);
  });
}

if (served) {
  console.log(`The gateway served a file this key had just uploaded, after ${elapsed()} s.`);
  process.exit(0);
}
console.log(
  `::error::PINATA_GATEWAY did not serve a file this key had just uploaded, for ${elapsed()} s. Last answer: ${lastAnswer}`,
);
console.log(
  "::error::A dedicated gateway serves only its own account's files. Check in Pinata that the gateway and the API key belong to the same account.",
);
process.exit(1);
