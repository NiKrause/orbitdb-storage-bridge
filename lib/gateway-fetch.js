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
export const DEFAULT_GATEWAYS = ["https://ipfs.aleph.cloud/ipfs"];

/**
 * Gateways that serve **verifiable** responses only: a single block, or a CAR.
 *
 * `trustless-gateway.link` was still healthy when the path gateways were
 * retired, and it answers with CORS — but it refuses an ordinary path request
 * with a 406, so it is only usable with `accept` set, and only for a CID whose
 * bytes are one block. A UnixFS file split into chunks needs its DAG walked,
 * which this module deliberately cannot do.
 */
export const TRUSTLESS_GATEWAYS = ["https://trustless-gateway.link/ipfs"];

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
  if (contentType.includes("text/html") || contentType.includes("xhtml")) return true;
  const start = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, Math.min(100, bytes.length)))
    .trim();
  return start.startsWith("<!DOCTYPE") || start.startsWith("<html") || start.startsWith("<?xml");
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
    if (!Number.isNaN(date.getTime())) return Math.max(0, date.getTime() - Date.now());
  }
  const reset = Number.parseInt(response.headers?.get?.("X-RateLimit-Reset") ?? "", 10);
  if (Number.isFinite(reset)) return Math.max(0, reset * 1000 - Date.now());
  return 2000 * (attempt + 1);
};

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
 * @returns {Promise<Uint8Array>}
 */
export async function fetchFromGateways(cid, { gateways = DEFAULT_GATEWAYS, timeout = DEFAULT_TIMEOUT_MS, signal = null, log = SILENT, accept = null, maxBackoff = MAX_BACKOFF_MS, sleep = waitFor, fetchImpl = fetch } = {}) {
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
            log.warn(`   ⚠️ ${gateway} wants ${Math.round(wait / 1000)}s — treating it as closed`);
            break;
          }
          log.warn(`   ⚠️ ${gateway} rate-limited; waiting ${Math.round(wait / 1000)}s`);
          await sleep(wait);
          continue;
        }
        if (!response.ok) {
          log.debug(`   ⚠️ ${gateway} answered ${response.status}`);
          break; // a status this gateway will keep giving — move on
        }

        const bytes = new Uint8Array(await response.arrayBuffer());
        if (looksLikeAnErrorPage(bytes, response.headers?.get?.("content-type") ?? "")) {
          log.warn(`   ⚠️ ${gateway} returned an error page with a 200`);
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
