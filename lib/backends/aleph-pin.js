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
 * The wallet **signs a string**. Aleph then checks that the account the STORE
 * is for has enough credit to cover what it is being asked to keep. There is no
 * transaction, no gas and no transfer at that moment: credits are drawn from the
 * account by the hour, afterwards. Worth stating because "pay for storage with a
 * wallet" reads as the opposite.
 *
 * ## Paid in credits
 *
 * Measured against `api2.aleph.im` on 2026-10-03, with throwaway accounts and
 * 2 MiB of random bytes:
 *
 * - A STORE whose content names no `payment` is booked as **`hold`**: ALEPH
 *   tokens locked on the account, a model Aleph has deprecated. It was
 *   processed at once for an account holding nothing, so "processed" says
 *   nothing about cover there.
 * - With `payment: { type: "credit" }` — what Aleph's own CLI sends by default —
 *   Aleph wants credit for at least a day (`min_runtime_days: 1`) and rejects
 *   the STORE otherwise: 107.8 credits for 2 MiB, about 54 per MiB and day.
 * - It is the account in `content.address` whose credit is checked and to
 *   which the cost is booked, not the sender: a delegate with no credit at all
 *   stored for a funded owner, and the cost appeared on the owner.
 *
 * So {@link buildStoreMessage} pays in credits unless told otherwise.
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

/** How a STORE may be paid for; `null` leaves `payment` out, which Aleph books as `hold`. */
export const STORE_PAYMENTS = Object.freeze(["credit", "hold"]);

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
 * @param {"credit" | "hold" | null} [args.payment] - `credit` by default; `null`
 *   sends no `payment`, as every version up to 0.16.1 did, which Aleph books as
 *   `hold`
 * @param {number} [args.now] - seconds; injected so a test is not a clock
 * @param {(payload: string) => Promise<string>} [args.hasher]
 */
export async function buildStoreMessage({
  sender,
  owner,
  cid,
  channel = DEFAULT_ALEPH_CHANNEL,
  payment = "credit",
  now,
  hasher = sha256Hex,
}) {
  if (payment !== null && !STORE_PAYMENTS.includes(payment)) {
    throw new BackendError(
      "INVALID_BACKEND",
      `a STORE is paid by "credit" or "hold", or names no payment (null), not ${JSON.stringify(payment)}`,
    );
  }
  const time = now ?? Date.now() / 1000;
  const content = {
    // Whose STORE this is. Equal to the sender unless the owner's `security`
    // aggregate authorizes the sender to send it on the owner's behalf.
    address: owner || sender,
    // "the thing to keep is an IPFS CID" — not the envelope's item_type
    item_type: "ipfs",
    item_hash: cid,
    // How that account pays. Without it Aleph books the STORE as `hold`, and an
    // account funded with credits covers nothing (see the file's header).
    ...(payment ? { payment: { type: payment } } : {}),
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
 * @param {"credit" | "hold" | null} [options.payment] - see {@link buildStoreMessage}
 * @param {(payload: string) => Promise<string>} [options.hasher]
 * @param {typeof fetch} [options.fetch]
 * @param {() => number} [options.now] - seconds
 * @returns {(cid: string, meta?: object) => Promise<{ itemHash: string, status: string }>}
 *   `status` is what Aleph answered: `processed`, or `pending` until it has
 *   checked the signature, the authorization and the credit — follow a pending
 *   one with {@link waitForMessage}.
 */
export function createAlephPin(options = {}) {
  const { sender, sign, owner } = options;
  const apiHost = options.apiHost || DEFAULT_ALEPH_API_HOST;
  const channel = options.channel || DEFAULT_ALEPH_CHANNEL;
  const payment = options.payment === undefined ? "credit" : options.payment;
  const hasher = options.hasher || sha256Hex;
  const doFetch = options.fetch || globalThis.fetch;
  const now = options.now;

  if (!sender) throw new BackendError("INVALID_BACKEND", "createAlephPin needs the wallet address as `sender`");
  if (typeof sign !== "function") throw new BackendError("INVALID_BACKEND", "createAlephPin needs a `sign` function");
  if (typeof doFetch !== "function") throw new BackendError("INVALID_BACKEND", "createAlephPin needs fetch");

  return async function pin(cid) {
    const unsigned = await buildStoreMessage({ sender, owner, cid, channel, payment, hasher, now: now?.() });
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

/** Statuses after which a message no longer changes by itself. */
const SETTLED = new Set(["processed", "rejected", "removing", "removed", "forgotten"]);

/**
 * Follow a message until Aleph has decided about it.
 *
 * A STORE answered with 202 is `pending`: Aleph has taken it, and checks the
 * signature, the authorization and the account's credit afterwards. A
 * rejected one says why. For a credit STORE without enough credit,
 * `details.errors[0]` names `account_credits`, `required_credits` and
 * `min_runtime_days`, with `errorCode` 6 (measured 2026-10-03).
 *
 * Never throws for what Aleph answers: a message still pending when the time is
 * up comes back as `{ status: "pending", timedOut: true }`, for the caller to
 * report as exactly that.
 *
 * @param {string} itemHash
 * @param {object} [options]
 * @param {string} [options.apiHost]
 * @param {typeof fetch} [options.fetch]
 * @param {number} [options.timeout] - ms in all; default 60 000
 * @param {number} [options.interval] - ms between asks; default 2 000
 * @param {(ms: number) => Promise<void>} [options.sleep] - injected so a test is not a clock
 * @returns {Promise<{ itemHash: string, status: string, errorCode?: number, details?: unknown, timedOut?: true }>}
 */
export async function waitForMessage(itemHash, options = {}) {
  const apiHost = options.apiHost || DEFAULT_ALEPH_API_HOST;
  const doFetch = options.fetch || globalThis.fetch;
  const timeout = options.timeout ?? 60_000;
  const interval = options.interval ?? 2_000;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  if (!itemHash) throw new BackendError("INVALID_BACKEND", "waitForMessage needs the message's item hash");
  if (typeof doFetch !== "function") throw new BackendError("INVALID_BACKEND", "waitForMessage needs fetch");

  // Counted in asks rather than read off a clock, so an injected `sleep` is enough for a test.
  const asks = Math.max(1, Math.floor(timeout / interval) + 1);
  let status = "pending";
  for (let ask = 0; ask < asks; ask++) {
    if (ask > 0) await sleep(interval);
    let response;
    try {
      response = await doFetch(`${apiHost}/api/v0/messages/${itemHash}`);
    } catch {
      continue; // the network, not Aleph's answer: ask again
    }
    // 404: not known on this node yet. Anything else not ok: ask again.
    if (!response.ok) continue;
    const body = await response.json().catch(() => ({}));
    if (typeof body?.status === "string") status = body.status;
    if (SETTLED.has(status)) {
      return {
        itemHash,
        status,
        ...(body.error_code != null ? { errorCode: body.error_code } : {}),
        ...(body.details != null ? { details: body.details } : {}),
      };
    }
  }
  return { itemHash, status, timedOut: true };
}

/**
 * The STORE messages kept for an account, newest first: its own, and those a
 * delegate sent for it.
 *
 * This is how an empty device finds a backup with nothing but the paying
 * account's public address. Aleph's `addresses` filter matches the *sender*,
 * so it misses a delegate's STORE; `owners` matches `content.address`, the
 * account the STORE is for (measured 2026-10-03).
 *
 * @param {object} options
 * @param {string} options.owner - the paying account, EIP-55 checksummed (Aleph
 *   keys accounts by that form)
 * @param {string} [options.channel] - one channel; every channel when absent
 * @param {string} [options.apiHost]
 * @param {typeof fetch} [options.fetch]
 * @param {number} [options.pagination] - per page; default 50
 * @param {number} [options.page] - from 1
 * @returns {Promise<{ stores: Array<{ cid: string, itemHash: string, sender: string, owner: string, time: number, channel?: string, payment?: string }>, total: number | null }>}
 *   `cid` is what the STORE keeps — for an upload through `createAlephBackend`,
 *   the handle's `id`
 */
export async function listAlephStores(options = {}) {
  const { owner, channel } = options;
  const apiHost = options.apiHost || DEFAULT_ALEPH_API_HOST;
  const doFetch = options.fetch || globalThis.fetch;
  if (!owner) throw new BackendError("INVALID_BACKEND", "listAlephStores needs the paying account's address as `owner`");
  if (typeof doFetch !== "function") throw new BackendError("INVALID_BACKEND", "listAlephStores needs fetch");

  const url = new URL(`${apiHost}/api/v0/messages.json`);
  url.searchParams.set("owners", owner);
  url.searchParams.set("msgTypes", "STORE");
  if (channel) url.searchParams.set("channels", channel);
  url.searchParams.set("pagination", String(options.pagination ?? 50));
  url.searchParams.set("page", String(options.page ?? 1));

  const response = await doFetch(url.toString());
  if (!response.ok) {
    throw new BackendError("UNSUPPORTED", `Aleph did not list the STORE messages: ${response.status}`);
  }
  const body = await response.json().catch(() => ({}));
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const stores = messages
    .map((m) => ({
      cid: String(m?.content?.item_hash ?? ""),
      itemHash: String(m?.item_hash ?? ""),
      sender: String(m?.sender ?? ""),
      owner: String(m?.content?.address ?? ""),
      time: Number(m?.content?.time ?? m?.time ?? 0),
      ...(m?.channel ? { channel: m.channel } : {}),
      ...(m?.content?.payment?.type ? { payment: m.content.payment.type } : {}),
    }))
    // Aleph answers what it was asked; keeping only this owner's costs nothing
    // and keeps a misread filter from handing back someone else's files.
    .filter((store) => store.cid && store.itemHash && same(store.owner, owner))
    .sort((a, b) => b.time - a.time);
  return { stores, total: Number.isFinite(body?.pagination_total) ? body.pagination_total : null };
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
 * Aleph's documentation does not say whose credit pays for a STORE a delegate
 * sends. Measured on 2026-10-03: the owner's, the account in `content.address`
 * (see the file's header).
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
