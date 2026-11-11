/**
 * @fileoverview Is ALEPH_PRIVATE_KEY usable, and does its account have credit?
 * Checked before the signed suites, so a missing secret or an empty account
 * fails once, with a reason. Prints the address and balance, never the key.
 *
 *     ALEPH_PRIVATE_KEY=0x… node test/helpers/check-aleph-key.js
 */
import { createEthSigner } from "./eth-signer.js";

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
const url = `https://api2.aleph.im/api/v0/addresses/${address}/balance`;
let body = {};
let status;
try {
  const response = await fetch(url);
  status = response.status;
  body = await response.json().catch(() => ({}));
} catch (error) {
  status = `no response (${error.message})`;
}
const credits = body.credit_balance ?? body.credits ?? null;
console.log(`account ${address}: ${url} → ${status}; balance ${JSON.stringify(body).slice(0, 200)}`);
if (status === 200 && credits !== null && Number(credits) <= 0) {
  console.log(`::error::Aleph account ${address} has no credits: STOREs paid in credit will be rejected (402 / error_code 6). Top it up.`);
  process.exit(1);
}
