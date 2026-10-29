/**
 * Fetching bytes by CID from public IPFS gateways.
 *
 * Extracted from `restore-cid.js` when a second caller appeared. It is not
 * about restoring and it is not about CARs — it is "resolve this name, from
 * whoever will serve it" — and leaving it where it was would have meant a
 * storage driver importing a CAR reader to make an HTTP request.
 *
 * Nothing here imports anything. That is deliberate and worth keeping: this is
 * the module a browser reaches for when it wants one blob and nothing else.
 *
 * @module gateway-fetch
 */

/**
 * Tried in order.
 *
 * This used to be four entries and is now one, because on 2026-09-21 Protocol
 * Labs retired `ipfs.io` and `dweb.link` — they answer 429 with an RFC 8594
 * `Sunset` header — and `w3s.link` and `storacha.link` redirect to `dweb.link`.
 * All four were dead at once, which is what a list of gateways run by one
 * organisation is worth.
 *
 * Measured 2026-09-23: `ipfs.aleph.cloud` answers in 0.2 s with CORS, and no
 * other free path gateway found would serve an arbitrary CID —
 * `gateway.pinata.cloud` answers 403 for content it does not hold,
 * `4everland.io` redirects after 15 s, the rest do not answer at all.
 *
 * One entry is not a fallback chain, and pretending otherwise is how this
 * rotted unnoticed. The replacement is not a longer list: it is fetching from
 * the providers that hold the blocks, over libp2p — see issue #112.
 */

import { CID } from "multiformats/cid";
export const DEFAULT_GATEWAYS = ["https://ipfs.aleph.cloud/ipfs"];

/**
 * Gateways that answer a block request with the block, and say so.
 *
 * `trustless-gateway.link` used to be the entry here. Measured 2026-10-24 it
 * answers `525` to everything, path and trustless alike, so it has followed
 * `ipfs.io` and `dweb.link` out. What is left and healthy is Aleph's, which
 * honours `accept: application/vnd.ipld.raw` and sets the content type to
 * match — 200 in 0.15 s with CORS `*`.
 *
 * Only for a CID whose bytes are one block: a UnixFS file split into chunks
 * needs its DAG walked, which this module deliberately cannot do. And the
 * list is a convenience, never a reason to trust an answer — every byte that
 * comes back is checked against the CID that asked for it.
 */
export const TRUSTLESS_GATEWAYS = ["https://ipfs.aleph.cloud/ipfs"];

/** `accept` for a single block from a trustless gateway. */
export const RAW_BLOCK = "application/vnd.ipld.raw";

/**
 * Quiet by default. A restore reports itself through its return value and its
 * exceptions; anything more is the caller's choice, and importing a logger to
 * offer it would cost more than the feature.
 */
export const SILENT = { info() {}, warn() {}, debug() {} };

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS_PER_GATEWAY = 3;

/**
 * Longest 429 wait worth honouring.
 *
 * A retired gateway asks for 900 s, and three attempts against four of them is
 * most of an afternoon spent waiting for an answer that will not change. Past
 * this, the gateway is not rate-limiting us, it is closed.
 */
export const MAX_BACKOFF_MS = 30_000;

/**
 * A gateway that cannot serve a CID usually says so in HTML, with a 200.
 *
 * That is the trap this guards: the bytes arrive, the status is fine, and what
 * you have is an error page that fails much later as an unreadable CAR. Two
 * cheap checks — the declared type, and what the bytes actually start with,
 * because the header is not always honest.
 */
const looksLikeAnErrorPage = (bytes, contentType = "") => {
  if (contentType.includes("text/html") || contentType.includes("xhtml"))
    return true;
  const start = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, Math.min(100, bytes.length)))
    .trim();
  return (
    start.startsWith("<!DOCTYPE") ||
    start.startsWith("<html") ||
    start.startsWith("<?xml")
  );
};

const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long a 429 wants us to wait, in the order the answer is trustworthy:
 * what the server said, when it says the window resets, then a backoff.
 */
const backoffFor = (response, attempt) => {
  const retryAfter = response.headers?.get?.("Retry-After");
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds)) return seconds * 1000;
    const date = new Date(retryAfter);
    if (!Number.isNaN(date.getTime()))
      return Math.max(0, date.getTime() - Date.now());
  }
  const reset = Number.parseInt(
    response.headers?.get?.("X-RateLimit-Reset") ?? "",
    10,
  );
  if (Number.isFinite(reset)) return Math.max(0, reset * 1000 - Date.now());
  return 2000 * (attempt + 1);
};

/**
 * True unless the CID is a raw sha-256 block whose digest the bytes miss.
 * Anything this cannot check (another codec, another hash, an unparsable
 * string) passes: the check is for the case it can prove, not a gate.
 *
 * @param {string} cid
 * @param {Uint8Array} bytes
 */
export async function matchesRawCid(cid, bytes) {
  let parsed;
  try {
    parsed = CID.parse(String(cid));
  } catch {
    return true;
  }
  if (parsed.code !== 0x55 || parsed.multihash.code !== 0x12) return true;
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", bytes),
  );
  const expected = parsed.multihash.digest;
  if (digest.length !== expected.length) return false;
  for (let i = 0; i < digest.length; i++)
    if (digest[i] !== expected[i]) return false;
  return true;
}

/**
 * The whole body, reporting progress as it arrives when asked to.
 *
 * @param {Response} response
 * @param {((received: number, total: number) => void) | null} onProgress
 * @returns {Promise<Uint8Array>}
 */
async function readBody(response, onProgress) {
  if (!onProgress || !response.body?.getReader) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const total = Number(response.headers?.get?.("content-length") ?? 0) || 0;
  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received, total);
  }
  const bytes = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

/**
 * Fetch the bytes behind a CID, trying each gateway in turn.
 *
 * @param {string} cid
 * @param {Object} [options]
 * @param {string[]} [options.gateways]
 * @param {number} [options.timeout] per request, in ms
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.accept] sent as `Accept`; `RAW_BLOCK` for a single
 *   block from a trustless gateway
 * @param {number} [options.maxBackoff] longest 429 wait to honour, in ms
 * @param {(ms: number) => Promise<void>} [options.sleep] injectable for tests
 * @param {typeof fetch} [options.fetchImpl] injectable for tests
 * @param {(received: number, total: number) => void} [options.onProgress]
 *   called as the bytes arrive, with how many so far and how many the gateway
 *   announced (`Content-Length`; 0 when it did not). A backup of several
 *   hundred MB takes minutes on a phone, and without this a page can only
 *   say "fetching" until the last byte. Aleph's gateway announces the length
 *   and exposes it to browsers (measured 2026-10-29).
 * @returns {Promise<Uint8Array>}
 */
export async function fetchFromGateways(
  cid,
  {
    gateways = DEFAULT_GATEWAYS,
    timeout = DEFAULT_TIMEOUT_MS,
    signal = null,
    log = SILENT,
    accept = null,
    maxBackoff = MAX_BACKOFF_MS,
    sleep = waitFor,
    fetchImpl = fetch,
    onProgress = null,
  } = {},
) {
  let lastError = null;

  for (const gateway of gateways) {
    const url = `${gateway}/${cid}`;
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_GATEWAY; attempt++) {
      const timer = AbortSignal.timeout ? AbortSignal.timeout(timeout) : null;
      try {
        const response = await fetchImpl(url, {
          signal: signal ?? timer ?? undefined,
          ...(accept ? { headers: { Accept: accept } } : {}),
        });

        // An RFC 8594 Sunset header means the gateway is going away or already
        // has. Retrying is pointless, and so is coming back next time.
        const sunset = response.headers?.get?.("Sunset");
        if (sunset && !response.ok) {
          log.warn(`   ⚠️ ${gateway} is retired (Sunset: ${sunset})`);
          break;
        }

        if (response.status === 429 && attempt < MAX_ATTEMPTS_PER_GATEWAY - 1) {
          const wait = backoffFor(response, attempt);
          if (wait > maxBackoff) {
            log.warn(
              `   ⚠️ ${gateway} wants ${Math.round(wait / 1000)}s — treating it as closed`,
            );
            break;
          }
          log.warn(
            `   ⚠️ ${gateway} rate-limited; waiting ${Math.round(wait / 1000)}s`,
          );
          await sleep(wait);
          continue;
        }
        if (!response.ok) {
          log.debug(`   ⚠️ ${gateway} answered ${response.status}`);
          break; // a status this gateway will keep giving — move on
        }

        const bytes = await readBody(response, onProgress);
        if (
          looksLikeAnErrorPage(
            bytes,
            response.headers?.get?.("content-type") ?? "",
          )
        ) {
          log.warn(`   ⚠️ ${gateway} returned an error page with a 200`);
          break;
        }
        // What came back is what was asked for — provable when the CID names
        // the bytes themselves (a raw block, sha-256). A UnixFS CID names a
        // DAG the gateway assembled, and the chunking that made it is the
        // service's; those bytes are trusted as far as the envelope around
        // them goes, which is why a sealed backup refuses plaintext.
        if (!(await matchesRawCid(cid, bytes))) {
          log.warn(`   ⚠️ ${gateway} served bytes that do not hash to ${cid}`);
          break;
        }
        log.info(`   ✅ ${bytes.length} bytes from ${gateway}`);
        return bytes;
      } catch (error) {
        lastError = error;
        log.debug(`   ⚠️ ${gateway} failed: ${error.message}`);
      }
    }
  }

  throw new Error(
    `Could not fetch ${cid} from any gateway${lastError ? `. Last error: ${lastError.message}` : ""}`,
  );
}
