/**
 * @fileoverview Making Aleph keep something: the STORE message, and nothing else.
 *
 * `createAlephBackend` stores without a key and says plainly that it does not
 * retain. This is the other half — and it is deliberately a separate module,
 * because the two have different requirements and only one of them needs a
 * wallet. An application that only ever reads, or only ever uploads, should
 * never have to load this file.
 *
 * ## No tokens move
 *
 * The wallet **signs a string**. Aleph then checks that the signing address has
 * enough balance or credit to cover what it is being asked to keep. There is no
 * transaction, no gas and no transfer: the token is the evidence, not the
 * payment. Worth stating because "pay for storage with a wallet" reads as the
 * opposite.
 *
 * ## Injected, not imported
 *
 * `sign` has the shape of `personal_sign` — `(address, message) => signature` —
 * which is what a browser wallet provides and what a Node signer can wrap. So
 * this module imports no wallet, no SDK and no key, and **no key ever passes
 * through the library**. In a browser the key never leaves the wallet at all.
 *
 * ## The format, and where each part was established
 *
 * The envelope, the hash and the signing payload are taken from `relay-button`,
 * which posts INSTANCE and AGGREGATE messages through the same route:
 *
 *     item_content = JSON.stringify(content)
 *     item_hash    = sha256hex(item_content)
 *     signed       = sign(sender, [chain, sender, type, item_hash].join("\n"))
 *
 * The STORE *content* is the one part not in that codebase, and was confirmed
 * against `api2.aleph.im` on 2026-09-09 — a correctly shaped message with a
 * deliberately invalid signature is accepted with **202** and left pending,
 * which separates "the schema is wrong" from "the signature is wrong".
 *
 * One trap, since it costs nothing to name: the content carries its *own*
 * `item_type` and `item_hash`, and they mean something different from the
 * envelope's. In the envelope they say "the message body is inline". In the
 * content they say "the thing to keep is this IPFS CID".
 *
 * @author @NiKrause
 * @requires ./aleph.js - the backend this supplies `pin` to
 */

import { BackendError } from "./types.js";

export const DEFAULT_ALEPH_API_HOST = "https://api2.aleph.im";
export const DEFAULT_ALEPH_CHANNEL = "ALEPH-CLOUDSOLUTIONS";

/** Hex sha-256 of a string, via WebCrypto — present in browsers and in Node 18+. */
async function sha256Hex(payload) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build the unsigned STORE message for a CID.
 *
 * Exported so it can be tested without a wallet, and read without running one.
 *
 * @param {object} args
 * @param {string} args.sender - the wallet address that signs
 * @param {string} [args.owner] - the account the STORE is for, when the sender
 *   signs on its behalf (see {@link createAlephAuthorizer}); the sender itself
 *   by default
 * @param {string} args.cid - what to keep
 * @param {string} [args.channel]
 * @param {number} [args.now] - seconds; injected so a test is not a clock
 * @param {(payload: string) => Promise<string>} [args.hasher]
 */
export async function buildStoreMessage({ sender, owner, cid, channel = DEFAULT_ALEPH_CHANNEL, now, hasher = sha256Hex }) {
  const time = now ?? Date.now() / 1000;
  const content = {
    // Whose STORE this is. Equal to the sender unless the owner's `security`
    // aggregate authorizes the sender to send it on the owner's behalf.
    address: owner || sender,
    // "the thing to keep is an IPFS CID" — not the envelope's item_type
    item_type: "ipfs",
    item_hash: cid,
    time,
  };
  const item_content = JSON.stringify(content);

  return {
    sender,
    chain: "ETH",
    type: "STORE",
    item_hash: await hasher(item_content),
    item_type: "inline",
    item_content,
    time,
    channel,
  };
}

/** What the wallet actually puts its name to. */
export const signaturePayload = (message) =>
  [message.chain, message.sender, message.type, message.item_hash].join("\n");

/**
 * A `pin` function for {@link createAlephBackend}.
 *
 * @param {object} options
 * @param {string} options.sender - the wallet address that signs
 * @param {string} [options.owner] - the account the STORE is for, when it has
 *   authorized `sender` (a delegate) to send STORE messages on its behalf
 * @param {(address: string, message: string) => Promise<string>} options.sign -
 *   `personal_sign`, or anything shaped like it. The library never sees a key.
 * @param {string} [options.apiHost]
 * @param {string} [options.channel]
 * @param {(payload: string) => Promise<string>} [options.hasher]
 * @param {typeof fetch} [options.fetch]
 * @param {() => number} [options.now] - seconds
 * @returns {(cid: string, meta?: object) => Promise<{ itemHash: string, status: string }>}
 */
export function createAlephPin(options = {}) {
  const { sender, sign, owner } = options;
  const apiHost = options.apiHost || DEFAULT_ALEPH_API_HOST;
  const channel = options.channel || DEFAULT_ALEPH_CHANNEL;
  const hasher = options.hasher || sha256Hex;
  const doFetch = options.fetch || globalThis.fetch;
  const now = options.now;

  if (!sender) throw new BackendError("INVALID_BACKEND", "createAlephPin needs the wallet address as `sender`");
  if (typeof sign !== "function") throw new BackendError("INVALID_BACKEND", "createAlephPin needs a `sign` function");
  if (typeof doFetch !== "function") throw new BackendError("INVALID_BACKEND", "createAlephPin needs fetch");

  return async function pin(cid) {
    const unsigned = await buildStoreMessage({ sender, owner, cid, channel, hasher, now: now?.() });
    const signature = await sign(sender, signaturePayload(unsigned));
    const message = {
      ...unsigned,
      signature: signature.startsWith("0x") ? signature : `0x${signature}`,
    };

    const response = await doFetch(`${apiHost}/api/v0/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, sync: true }),
    });

    // 202 means Aleph took the message, not that it kept the file: the
    // signature and the balance are checked afterwards. Reporting it as done
    // would be the exact lie this module exists to avoid, so the caller gets
    // the status it was given.
    if (!response.ok && response.status !== 202) {
      const detail = await response.text().catch(() => "");
      throw new BackendError(
        "UNSUPPORTED",
        `Aleph refused the STORE message: ${response.status} ${detail.slice(0, 200)}`,
      );
    }

    const body = await response.json().catch(() => ({}));
    return {
      itemHash: unsigned.item_hash,
      status: body?.message_status ?? "pending",
    };
  };
}

/** The reserved channel and aggregate key Aleph keeps permissions in. */
export const SECURITY = "security";

/**
 * @typedef {object} AlephAuthorization one entry of an owner's `security.authorizations`
 * @property {string} address - the delegate, which may then send on the owner's behalf
 * @property {string[]} [types] - e.g. `["STORE"]`; every type when absent
 * @property {string[]} [channels] - e.g. `["BELEGE-BACKUP"]`; every channel when absent
 * @property {string} [chain] - only the delegate's address on this chain, e.g. `"ETH"`
 * @property {string[]} [post_types]
 * @property {string[]} [aggregate_keys]
 */

/**
 * Build the unsigned AGGREGATE that sets an owner's authorizations.
 *
 * Aleph keeps permissions in the owner's `security` aggregate, written only by
 * the owner itself (`sender == content.address`) on the `security` channel. An
 * aggregate key is replaced as a whole, so `authorizations` is the **complete**
 * list after the change, not an addition: {@link createAlephAuthorizer} reads
 * the current list first.
 *
 * @param {object} args
 * @param {string} args.owner - the account granting, and signing
 * @param {AlephAuthorization[]} args.authorizations
 * @param {number} [args.now] - seconds
 * @param {(payload: string) => Promise<string>} [args.hasher]
 */
export async function buildAuthorizationMessage({ owner, authorizations, now, hasher = sha256Hex }) {
  if (!owner) throw new BackendError("INVALID_BACKEND", "an authorization needs the owner's address");
  if (!Array.isArray(authorizations) || authorizations.some((a) => typeof a?.address !== "string" || !a.address)) {
    throw new BackendError("INVALID_BACKEND", "every authorization needs the delegate's address");
  }
  const time = now ?? Date.now() / 1000;
  const item_content = JSON.stringify({
    address: owner,
    key: SECURITY,
    content: { authorizations },
    time,
  });
  return {
    sender: owner,
    chain: "ETH",
    type: "AGGREGATE",
    item_hash: await hasher(item_content),
    item_type: "inline",
    item_content,
    time,
    channel: SECURITY,
  };
}

/**
 * Let other keys send STORE messages for an account: read, grant and revoke its
 * authorizations.
 *
 * The use it was built for: one funded account pays for keeping backups, and
 * the keys that actually sign them are others — a key derived from a passkey in
 * the browser, one per person or device. Each is granted only what it needs
 * (`types: ["STORE"]`, one channel), and revoked on its own. The owner signs
 * these grants; the delegates then pass `owner` to {@link createAlephPin}.
 *
 * Which balance Aleph charges for a STORE sent by a delegate is not stated in
 * its documentation; measure it before relying on it.
 *
 * Aleph keys accounts by their EIP-55 checksummed address; pass `owner` in that
 * form, or `read()` finds nothing.
 *
 * @param {object} options
 * @param {string} options.owner - the account granting
 * @param {(address: string, message: string) => Promise<string>} options.sign - the owner's `personal_sign`
 * @param {string} [options.apiHost]
 * @param {typeof fetch} [options.fetch]
 * @param {() => number} [options.now] - seconds
 * @param {(payload: string) => Promise<string>} [options.hasher]
 */
export function createAlephAuthorizer(options = {}) {
  const { owner, sign } = options;
  const apiHost = options.apiHost || DEFAULT_ALEPH_API_HOST;
  const hasher = options.hasher || sha256Hex;
  const doFetch = options.fetch || globalThis.fetch;
  if (!owner) throw new BackendError("INVALID_BACKEND", "createAlephAuthorizer needs the owner's address");
  if (typeof sign !== "function") throw new BackendError("INVALID_BACKEND", "createAlephAuthorizer needs a `sign` function");
  if (typeof doFetch !== "function") throw new BackendError("INVALID_BACKEND", "createAlephAuthorizer needs fetch");

  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

  /** @returns {Promise<AlephAuthorization[]>} */
  async function read() {
    const response = await doFetch(`${apiHost}/api/v0/aggregates/${owner}.json?keys=${SECURITY}`);
    if (response.status === 404) return [];
    if (!response.ok) {
      throw new BackendError("UNSUPPORTED", `Aleph did not answer the owner's permissions: ${response.status}`);
    }
    const body = await response.json().catch(() => ({}));
    const list = body?.data?.[SECURITY]?.authorizations;
    return Array.isArray(list) ? list : [];
  }

  /** @param {AlephAuthorization[]} authorizations */
  async function write(authorizations) {
    const unsigned = await buildAuthorizationMessage({ owner, authorizations, hasher, now: options.now?.() });
    const signature = await sign(owner, signaturePayload(unsigned));
    const response = await doFetch(`${apiHost}/api/v0/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: { ...unsigned, signature: signature.startsWith("0x") ? signature : `0x${signature}` },
        sync: true,
      }),
    });
    if (!response.ok && response.status !== 202) {
      const detail = await response.text().catch(() => "");
      throw new BackendError("UNSUPPORTED", `Aleph refused the authorization: ${response.status} ${detail.slice(0, 200)}`);
    }
    const body = await response.json().catch(() => ({}));
    return { itemHash: unsigned.item_hash, status: body?.message_status ?? "pending", authorizations };
  }

  return {
    read,
    write,
    /** Grant, or replace the grant of the same address. @param {AlephAuthorization} authorization */
    async authorize(authorization) {
      const others = (await read()).filter((a) => !same(a.address, authorization?.address));
      return write([...others, authorization]);
    },
    /** Take one address's grant away; the others stay. @param {string} address */
    async revoke(address) {
      return write((await read()).filter((a) => !same(a.address, address)));
    },
  };
}

export default createAlephPin;
