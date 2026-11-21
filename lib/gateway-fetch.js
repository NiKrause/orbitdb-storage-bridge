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

/* global AbortController */

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
async function readBody(
  response,
  onProgress,
  stillAlive = () => {},
  signal = null,
) {
  if (!response.body?.getReader) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const total = Number(response.headers?.get?.("content-length") ?? 0) || 0;
  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    // A reader that does not watch the signal still stops here.
    if (signal?.aborted) throw signal.reason;
    if (done) break;
    chunks.push(value);
    received += value.length;
    stillAlive();
    onProgress?.(received, total);
  }
  const bytes = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

/** How often one transfer may pick up again where a connection dropped it. */
export const MAX_RESUMES = 20;

/**
 * The bytes behind a CID as they arrive, never all of them at once (#187).
 *
 * {@link fetchFromGateways} assembles the whole file before it returns, which
 * is right for a block and for a manifest, and more than a phone's browser tab
 * may hold for a backup of several hundred MB. This yields each chunk as the
 * gateway sends it; what the caller does not keep is gone.
 *
 * A connection that drops after the first byte is not the end: the next
 * request asks for the rest (`Range: bytes=<received>-`), from the same
 * gateway and then the next. A gateway that ignores the range and sends the
 * file from its start has those bytes passed over. A phone changes cells in
 * the minutes a large file takes.
 *
 * **What is yielded is not yet checked.** The whole-file checks of
 * `fetchFromGateways` can only speak at the end, and by then the bytes are
 * with the caller: a file of another length than `expectedSize`, or one the
 * `verifier` refuses, throws after the last chunk was yielded and before the
 * iteration ends. So a caller acts on chunks only as far as each proves
 * itself (a sealed frame that opens, a block that hashes to its CID), and
 * treats the file as whole only once the iteration finished without an error.
 *
 * @param {string} cid
 * @param {Object} [options] as for {@link fetchFromGateways}, except:
 * @param {number} [options.timeout] idle time in ms. The clock stands still
 *   while the caller is busy with a chunk: only the gateway's silence counts.
 * @param {number} [options.offset] start at this byte: the file from there on
 * @param {((cid: string) => { write(chunk: Uint8Array): void | Promise<void>, done(): Promise<boolean> } | null) | null} [options.verifier]
 *   a check of the whole file that takes it in pieces – the Aleph driver
 *   passes `unixfsCidVerifier`. Not asked when the transfer started at an
 *   `offset`, for it never sees the start.
 * @param {number} [options.maxResumes]
 * @returns {AsyncGenerator<Uint8Array>}
 */
export async function* streamFromGateways(
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
    expectedSize = null,
    verifier = null,
    offset = 0,
    maxResumes = MAX_RESUMES,
  } = {},
) {
  let lastError = null;
  /** Bytes of the file handed on so far, counted from its start. */
  let received = offset;
  /** The file's length, once a gateway announced it. */
  let total = 0;
  let resumes = 0;
  let complete = false;
  const checking = offset === 0 && verifier ? verifier(cid) : null;

  outer: for (const gateway of gateways) {
    const url = `${gateway}/${cid}`;
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_GATEWAY; attempt++) {
      const idle = new AbortController();
      let clock = null;
      const stop = () => {
        if (clock) clearTimeout(clock);
        clock = null;
      };
      const stillAlive = () => {
        stop();
        clock = setTimeout(
          () =>
            idle.abort(new Error(`no bytes from ${gateway} for ${timeout} ms`)),
          timeout,
        );
      };
      const startedAt = received;
      let reader = null;
      stillAlive();
      try {
        const headers = {
          ...(accept ? { Accept: accept } : {}),
          ...(received > 0 ? { Range: `bytes=${received}-` } : {}),
        };
        const response = await fetchImpl(url, {
          signal: signal ?? idle.signal,
          ...(Object.keys(headers).length ? { headers } : {}),
        });
        stillAlive();

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
          stop();
          await sleep(wait);
          continue;
        }
        if (!response.ok) {
          lastError = new Error(`${gateway} answered ${response.status}`);
          log.debug(`   ⚠️ ${lastError.message}`);
          break;
        }
        if (!response.body?.getReader) {
          throw new Error(`${gateway} answered without a body to read`);
        }

        // How much of the answer to pass over: all of what is already with
        // the caller, when the gateway sent the file from its start anyway.
        let skip = 0;
        if (response.status === 206) {
          const range = /bytes (\d+)-\d*\/(\d+|\*)/.exec(
            response.headers?.get?.("content-range") ?? "",
          );
          const from = range ? Number(range[1]) : received;
          if (from > received) {
            throw new Error(
              `${gateway} answered from byte ${from}, asked from ${received}`,
            );
          }
          skip = received - from;
          if (range && range[2] !== "*") total = Number(range[2]);
        } else {
          skip = received;
          const announced =
            Number(response.headers?.get?.("content-length") ?? 0) || 0;
          if (announced) total = announced;
        }
        const contentType = response.headers?.get?.("content-type") ?? "";

        reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (signal?.aborted) throw signal.reason;
          if (idle.signal.aborted) throw idle.signal.reason;
          if (done) break;
          let chunk = value;
          if (skip > 0) {
            const passed = Math.min(skip, chunk.length);
            skip -= passed;
            chunk = chunk.subarray(passed);
            stillAlive();
            if (!chunk.length) continue;
          }
          // An error page with a 200: only the file's first bytes can tell.
          if (received === 0 && looksLikeAnErrorPage(chunk, contentType)) {
            lastError = new Error(
              `${gateway} returned an error page with a 200`,
            );
            log.warn(`   ⚠️ ${lastError.message}`);
            continue outer;
          }
          if (checking) await checking.write(chunk);
          received += chunk.length;
          onProgress?.(received, total || expectedSize || 0);
          // The caller's time with a chunk is not the gateway's silence.
          stop();
          yield chunk;
          stillAlive();
        }
        // A body that ended early without an error: ask for the rest.
        if (total && received < total) {
          throw new Error(
            `${gateway} ended the answer at byte ${received} of ${total}`,
          );
        }
        complete = true;
        log.info(`   ✅ ${received - offset} bytes from ${gateway}`);
        break outer;
      } catch (error) {
        lastError = idle.signal.aborted ? idle.signal.reason : error;
        log.debug(`   ⚠️ ${gateway} failed: ${lastError.message}`);
        if (signal?.aborted) break outer;
        // It moved: this was a dropped connection, not a gateway that cannot
        // serve the file, and the attempts start over, within a budget.
        if (received > startedAt) {
          if (++resumes > maxResumes) break outer;
          attempt = -1;
        }
      } finally {
        stop();
        // Left early, by an error or by the caller: let the connection go.
        if (!complete) await reader?.cancel?.().catch(() => {});
      }
    }
  }

  if (!complete) {
    const error = new Error(
      `Could not fetch ${cid} from any gateway` +
        (received > offset ? ` (it stopped at byte ${received})` : "") +
        (lastError ? `. Last error: ${lastError.message}` : ""),
    );
    // For a caller with another source: where that one may go on.
    error.received = received;
    throw error;
  }
  if (expectedSize != null && received !== expectedSize) {
    throw new Error(
      `The gateways served ${received} bytes of ${cid}, not the ${expectedSize} it has`,
    );
  }
  if (checking && !(await checking.done())) {
    throw new Error(`The gateways served bytes that are not ${cid}`);
  }
}

/**
 * Fetch the bytes behind a CID, trying each gateway in turn.
 *
 * @param {string} cid
 * @param {Object} [options]
 * @param {string[]} [options.gateways]
 * @param {number} [options.timeout] in ms: how long to wait for the first
 *   byte, and from then on for the next one. Not a cap on the whole
 *   transfer – a backup of several hundred MB on a phone's Wi-Fi takes
 *   longer than two minutes and must not be cut off while it is arriving
 *   (measured 2026-10-29: 722 MB at about 10 MB/s from a laptop, slower on
 *   a phone, against a two-minute cap). A caller's `signal` replaces it.
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.accept] sent as `Accept`; `RAW_BLOCK` for a single
 *   block from a trustless gateway
 * @param {number} [options.maxBackoff] longest 429 wait to honour, in ms
 * @param {(ms: number) => Promise<void>} [options.sleep] injectable for tests
 * @param {typeof fetch} [options.fetchImpl] injectable for tests
 * @param {(received: number, total: number) => void} [options.onProgress]
 * @param {number | null} [options.expectedSize] the file's length in bytes
 *   when the caller knows it (an Aleph STORE's `content.size`, say): bytes of
 *   another length are refused and the next gateway asked
 * @param {((cid: string, bytes: Uint8Array) => Promise<boolean>) | null} [options.verify]
 *   a check of the caller's beyond the raw-CID one – the Aleph driver passes
 *   `matchesUnixfsCid`. `false` refuses the bytes and asks the next gateway
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
    expectedSize = null,
    verify = null,
  } = {},
) {
  let lastError = null;

  for (const gateway of gateways) {
    const url = `${gateway}/${cid}`;
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_GATEWAY; attempt++) {
      // Idle, not total: the clock restarts with every chunk that arrives.
      const idle = new AbortController();
      let clock = null;
      const stillAlive = () => {
        if (clock) clearTimeout(clock);
        clock = setTimeout(
          () =>
            idle.abort(new Error(`no bytes from ${gateway} for ${timeout} ms`)),
          timeout,
        );
      };
      stillAlive();
      try {
        const response = await fetchImpl(url, {
          signal: signal ?? idle.signal,
          ...(accept ? { headers: { Accept: accept } } : {}),
        });
        stillAlive();

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

        const bytes = await readBody(
          response,
          onProgress,
          stillAlive,
          idle.signal,
        );
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
        // A download that came back short, or with something else in it,
        // must not pass as the file: sealed, it fails to open later, and
        // nothing then tells it apart from a wrong key. The length first:
        // it costs nothing, and its message says what happened.
        if (expectedSize != null && bytes.length !== expectedSize) {
          lastError = new Error(
            `${gateway} served ${bytes.length} bytes of ${cid}, not the ${expectedSize} it has`,
          );
          log.warn(`   ⚠️ ${lastError.message}`);
          break;
        }
        if (!(await matchesRawCid(cid, bytes))) {
          lastError = new Error(
            `${gateway} served bytes that do not hash to ${cid}`,
          );
          log.warn(`   ⚠️ ${lastError.message}`);
          break;
        }
        if (verify && !(await verify(cid, bytes))) {
          lastError = new Error(`${gateway} served bytes that are not ${cid}`);
          log.warn(`   ⚠️ ${lastError.message}`);
          break;
        }
        log.info(`   ✅ ${bytes.length} bytes from ${gateway}`);
        return bytes;
      } catch (error) {
        lastError = idle.signal.aborted ? idle.signal.reason : error;
        log.debug(`   ⚠️ ${gateway} failed: ${lastError.message}`);
      } finally {
        if (clock) clearTimeout(clock);
      }
    }
  }

  throw new Error(
    `Could not fetch ${cid} from any gateway${lastError ? `. Last error: ${lastError.message}` : ""}`,
  );
}
