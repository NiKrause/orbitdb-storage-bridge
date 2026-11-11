/**
 * A minimal `personal_sign` for Node, for the live checks only.
 *
 * `createAlephPin` and `createAlephForget` take `sign(address, message)` and
 * never a key; this wraps a hex private key into exactly that shape, with
 * `@noble/curves` and `@noble/hashes` (already in the tree through the
 * libp2p stack), so the live suites need no wallet SDK.
 *
 * Never logs the key.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

const hex = (bytes) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (s) =>
  Uint8Array.from(
    s
      .replace(/^0x/, "")
      .match(/../g)
      .map((b) => parseInt(b, 16)),
  );

/** EIP-55: Aleph keys accounts by the checksummed form. */
function checksum(addressHex) {
  const lower = addressHex.toLowerCase();
  const hash = hex(keccak_256(new TextEncoder().encode(lower)));
  let out = "0x";
  for (let i = 0; i < lower.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

/** A fresh key, for a throwaway account. */
export const randomPrivateKey = () =>
  `0x${hex(secp256k1.utils.randomPrivateKey())}`;

/**
 * @param {string} privateKey - 32 bytes, hex, with or without 0x
 * @returns {{ address: string, sign: (address: string, message: string) => Promise<string> }}
 */
export function createEthSigner(privateKey) {
  const key = fromHex(String(privateKey).trim());
  if (key.length !== 32) {
    throw new Error(
      `an Ethereum private key is 32 bytes of hex; this one has ${key.length}`,
    );
  }
  const publicKey = secp256k1.getPublicKey(key, false).slice(1);
  const address = checksum(hex(keccak_256(publicKey).slice(-20)));
  async function sign(signer, message) {
    if (signer.toLowerCase() !== address.toLowerCase()) {
      throw new Error("asked to sign for an address this key is not");
    }
    const body = new TextEncoder().encode(message);
    const prefix = new TextEncoder().encode(
      `\x19Ethereum Signed Message:\n${body.length}`,
    );
    const digest = keccak_256(new Uint8Array([...prefix, ...body]));
    const signature = secp256k1.sign(digest, key);
    const r = signature.r.toString(16).padStart(64, "0");
    const s = signature.s.toString(16).padStart(64, "0");
    const v = (27 + signature.recovery).toString(16);
    return `0x${r}${s}${v}`;
  }
  return { address, sign };
}
