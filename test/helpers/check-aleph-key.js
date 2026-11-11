/**
 * @fileoverview Is ALEPH_PRIVATE_KEY usable, and does its account have credit?
 * Checked before the signed suites, so a missing secret or an empty account
 * fails once, with a reason. Prints the address and balance, never the key.
 *
 *     ALEPH_PRIVATE_KEY=0x… node test/helpers/check-aleph-key.js
 */
import { createEthSigner } from "./eth-signer.js";
import { alephCredits } from "../../lib/backends/aleph-pin.js";

const raw = process.env.ALEPH_PRIVATE_KEY ?? "";
if (!raw.trim()) {
  console.log(
    "::error::ALEPH_PRIVATE_KEY is empty. Add the private key of a dedicated Aleph test account as a repository secret.",
  );
  process.exit(1);
}
let address;
try {
  ({ address } = createEthSigner(raw));
} catch (error) {
  console.log(`::error::ALEPH_PRIVATE_KEY: ${error.message}`);
  process.exit(1);
}
// The library's own reading of the balance, so this checks what the library does.
const credits = await alephCredits(address);
const endpoint = `https://api2.aleph.im/api/v0/addresses/${address}/balance`;
if (credits === null) {
  console.log(
    `::error::Aleph did not report credits for ${address} (${endpoint}): the API is unreachable, or answers without credit_balance.`,
  );
  process.exit(1);
}
console.log(`account ${address}: ${credits} credits`);
if (credits <= 0) {
  console.log(
    `::error::Aleph account ${address} has no credits: STOREs paid in credit will be rejected (402 / error_code 6). Top it up.`,
  );
  process.exit(1);
}
