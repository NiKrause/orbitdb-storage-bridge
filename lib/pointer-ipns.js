/**
 * A pointer a second device can find with nothing but a key.
 *
 * The problem this solves is not storage — a backup's CID is enough to fetch
 * it from anywhere — but *naming*: a device that has lost everything cannot be
 * told a CID, because there is nobody left to tell it. So the name has to be
 * computable from the one thing that survived. Derive a key from a seed, and
 * the IPNS name follows from the key; two devices holding the same seed
 * compute the same name without ever exchanging anything.
 *
 * The seed is the caller's business. A passkey's PRF output is the case this
 * was written for (funkpost#93), and it never passes through here as anything
 * but bytes to stretch.
 *
 * Publication goes over **delegated routing** — `PUT /routing/v1/ipns/{name}`
 * — because a browser cannot join the DHT, and `w3name`, which used to stand
 * in for this, was Storacha's and Storacha is gone. Measured against
 * `delegated-ipfs.dev` on 2026-09-19, from Node and from a page on a foreign
 * origin: the preflight allows `PUT` from anywhere, the PUT is accepted, and
 * the GET returns the record byte for byte
 * (`test/helpers/probe-ipns-routing.js`).
 *
 * Two things that probe could not establish, and this module therefore does
 * not promise: that a record travels beyond the endpoint that accepted it, and
 * how long it is kept. Publish to more than one endpoint where that matters,
 * and treat a pointer as a shortcut for a device that comes back soon rather
 * than as an archive.
 */

import {
  createIPNSRecord,
  marshalIPNSRecord,
  unmarshalIPNSRecord,
  multihashToIPNSRoutingKey,
} from "ipns";
import { ipnsValidator } from "ipns/validator";
import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey, peerIdFromString } from "@libp2p/peer-id";
import { CID } from "multiformats/cid";
import { base36 } from "multiformats/bases/base36";
import logger from "./logger.js";

const log = logger.child ? logger.child({ module: "pointer-ipns" }) : logger;

/** libp2p-key, the codec an IPNS name is a CID of. */
const LIBP2P_KEY_CODEC = 0x72;

/**
 * Bumping this changes every name a seed produces, so treat it as a breaking
 * change: pointers published under the old one become unfindable.
 */
export const POINTER_INFO = "orbitdb-storage-bridge:pointer-ipns:v1";

/** Public endpoints that speak delegated routing v1. */
export const DEFAULT_ENDPOINTS = ["https://delegated-ipfs.dev"];

const DEFAULT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // what a record claims for itself
const DEFAULT_TIMEOUT_MS = 30_000;
const RECORD_CONTENT_TYPE = "application/vnd.ipfs.ipns-record";

/**
 * Stretch a seed into the key whose name the pointer lives under.
 *
 * HKDF-SHA256, with `label` mixed into the info string so one seed can name
 * several pointers without their keys being related in any usable way.
 *
 * @param {Uint8Array} seed Secret bytes — a PRF output, say. Never published.
 * @param {Object} [options]
 * @param {string} [options.label=""] Distinguishes pointers of one seed.
 * @param {string} [options.info=POINTER_INFO] Domain separation.
 * @returns {Promise<Object>} A libp2p Ed25519 private key.
 */
export async function derivePointerKey(
  seed,
  { label = "", info = POINTER_INFO } = {},
) {
  if (!(seed instanceof Uint8Array) || seed.length === 0) {
    throw new Error("derivePointerKey needs seed bytes");
  }
  const base = await globalThis.crypto.subtle.importKey(
    "raw",
    seed,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(label ? `${info}:${label}` : info),
    },
    base,
    256,
  );
  return generateKeyPairFromSeed("Ed25519", new Uint8Array(bits));
}

/**
 * The IPNS name of a key, as routing endpoints and gateways spell it.
 *
 * @param {Object} key A libp2p private or public key.
 * @returns {string} base36 `k51…`
 */
export function pointerName(key) {
  const publicKey = key.publicKey ?? key;
  const peerId = key.publicKey
    ? peerIdFromPrivateKey(key)
    : (publicKey.toPeerId?.() ?? publicKey);
  return CID.createV1(LIBP2P_KEY_CODEC, peerId.toMultihash()).toString(base36);
}

const multihashOfName = (name) => peerIdFromString(name).toMultihash();

/**
 * Put a CID under the name this key derives, at every endpoint given.
 *
 * Resolves as soon as one endpoint has taken it; the rest are still tried, and
 * what each of them said comes back in `results` — a pointer that reached one
 * endpoint is published, and a pointer that reached three is more likely to be
 * found later.
 *
 * @param {Object} params
 * @param {Object} params.privateKey From `derivePointerKey`.
 * @param {string|Object} params.cid What the pointer points at.
 * @param {string[]} [params.endpoints]
 * @param {bigint|number} [params.sequence] Must only ever grow for a name.
 *   Seconds since the epoch by default, which is monotonic enough for a
 *   pointer written by hand and readable in a log.
 * @param {number} [params.lifetimeMs]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{name: string, sequence: bigint, results: Array<{endpoint: string, ok: boolean, status?: number, error?: string}>}>}
 */
export async function publishPointer({
  privateKey,
  cid,
  endpoints = DEFAULT_ENDPOINTS,
  sequence = BigInt(Math.floor(Date.now() / 1000)),
  lifetimeMs = DEFAULT_LIFETIME_MS,
  signal,
}) {
  const value = typeof cid === "string" ? CID.parse(cid) : cid;
  const record = await createIPNSRecord(
    privateKey,
    value,
    BigInt(sequence),
    lifetimeMs,
  );
  const body = marshalIPNSRecord(record);
  const name = pointerName(privateKey);

  const results = await Promise.all(
    endpoints.map(async (endpoint) => {
      try {
        const response = await fetch(pointerUrl(endpoint, name), {
          method: "PUT",
          headers: { "Content-Type": RECORD_CONTENT_TYPE },
          body,
          signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        });
        return { endpoint, ok: response.ok, status: response.status };
      } catch (error) {
        return { endpoint, ok: false, error: error.message };
      }
    }),
  );

  if (!results.some((result) => result.ok)) {
    const reasons = results
      .map((result) => `${result.endpoint}: ${result.error ?? result.status}`)
      .join("; ");
    throw new Error(`no endpoint took the pointer (${reasons})`);
  }
  log.info?.("📍 pointer %s → %s", name, value.toString());
  return { name, sequence: BigInt(sequence), results };
}

/**
 * Read a pointer back, from whichever endpoint answers with a valid record.
 *
 * Every record is checked against the name it was asked for before it is
 * believed: the name is the hash of the key that signs, so an endpoint cannot
 * hand back somebody else's pointer, or an altered one, without being caught.
 *
 * @param {Object} params
 * @param {string} [params.name] The name, if the caller has it.
 * @param {Object} [params.privateKey] Or the key, and the name follows.
 * @param {string[]} [params.endpoints]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{name: string, cid: string, sequence: bigint, validity: string|undefined}>}
 */
export async function resolvePointer({
  name,
  privateKey,
  endpoints = DEFAULT_ENDPOINTS,
  signal,
}) {
  const pointer = name ?? (privateKey ? pointerName(privateKey) : null);
  if (!pointer) throw new Error("resolvePointer needs a name or a key");
  const routingKey = multihashToIPNSRoutingKey(multihashOfName(pointer));

  const failures = [];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(pointerUrl(endpoint, pointer), {
        headers: { Accept: RECORD_CONTENT_TYPE },
        signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      if (!response.ok) {
        failures.push(`${endpoint}: ${response.status}`);
        continue;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      try {
        await ipnsValidator(routingKey, bytes); // signed by this name, or nothing
      } catch (error) {
        failures.push(`${endpoint}: ${whatCameBack(response, bytes, error)}`);
        continue;
      }
      const record = unmarshalIPNSRecord(bytes);
      return {
        name: pointer,
        cid: String(record.value).replace(/^\/ipfs\//, ""),
        sequence: record.sequence,
        validity: record.validity,
      };
    } catch (error) {
      failures.push(`${endpoint}: ${error.message}`);
    }
  }
  throw new Error(
    `no endpoint had a valid pointer for ${pointer} (${failures.join("; ")})`,
  );
}

/**
 * Why a 200 held no pointer.
 *
 * `delegated-ipfs.dev` answers a miss with **200 and a sentence** — `delegate
 * error: routing: not found`, as `text/plain` — where a 404 would be the
 * obvious thing. Handing that to the record parser produces "invalid wire type
 * 4 at offset 1", which describes our parser rather than what happened, and
 * cost an afternoon of looking for a protocol fault that was a missing record.
 *
 * So: when the body is text, say what the endpoint said. When it is bytes that
 * do not validate, the validator's own message is the right one — that is a
 * record for the wrong name, or a tampered one, and worth reading as such.
 */
function whatCameBack(response, bytes, error) {
  if (bytes.length === 0) return `${response.status}, an empty body`;
  if (/^text\//.test(response.headers.get("content-type") ?? "")) {
    const said = new TextDecoder().decode(bytes.subarray(0, 200)).trim();
    return `${response.status}, ${said || "an empty body"}`;
  }
  return error.message;
}

function pointerUrl(endpoint, name) {
  return `${endpoint.replace(/\/$/, "")}/routing/v1/ipns/${name}`;
}
