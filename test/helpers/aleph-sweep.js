/**
 * @fileoverview FORGET every STORE the smoke-test account still keeps on the
 * smoke channel — what a run that broke halfway left behind — so nothing
 * accumulates and no credits are drawn for it. Runs at the end of every
 * smoke-test job, whatever happened before.
 *
 *     ALEPH_PRIVATE_KEY=0x… node test/helpers/aleph-sweep.js
 *
 * Prints counts and item hashes, never the key.
 */
import {
  createAlephForget,
  forgetAlephStores,
} from "../../lib/backends/aleph-pin.js";
import { createEthSigner } from "./eth-signer.js";
import { SMOKE_CHANNEL } from "../backends/drivers.js";

if (!process.env.ALEPH_PRIVATE_KEY) {
  console.log("No ALEPH_PRIVATE_KEY: nothing to sweep.");
  process.exit(0);
}
const { address, sign } = createEthSigner(process.env.ALEPH_PRIVATE_KEY);
const forget = createAlephForget({ sender: address, sign, channel: SMOKE_CHANNEL });
const result = await forgetAlephStores({
  owner: address,
  channel: SMOKE_CHANNEL,
  forget,
  reason: "smoke test sweep",
  settle: { timeout: 120_000, interval: 5_000 },
});
console.log(
  `Sweep of ${SMOKE_CHANNEL} for ${address}: ${result.forgotten.length} forgotten, ` +
    `${result.pending.length} pending, ${result.rejected.length} rejected, ${result.failed.length} failed`,
);
for (const r of result.rejected)
  console.log(`::warning::FORGET of ${r.itemHash} rejected, error_code ${r.errorCode}`);
for (const f of result.failed)
  console.log(`::warning::FORGET of ${f.itemHash} could not be sent: ${f.error}`);
