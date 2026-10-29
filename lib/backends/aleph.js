/**
 * @fileoverview Aleph Cloud storage backend
 *
 * The keyless one. `POST https://ipfs.aleph.cloud/api/v0/add` takes a file with
 * **no API key at any point** and answers `access-control-allow-origin: *`, so
 * a browser posts to it directly — no proxy, no bearer token, nothing on the
 * device that would be an account takeover if it leaked. For an application
 * that has to store something from wherever it happens to be running, that is
 * a different category from every other driver here.
 *
 * Measured against the live host on 2026-09-09, because a driver written from
 * a description is a guess:
 *
 * - a 4 KB `application/vnd.ipld.car` upload came back **byte-identical**, so
 *   there is none of the "binary files case by case" hedging other services
 *   attach to CARs;
 * - an empty blob is accepted, and answers with the well-known empty-file CID;
 * - retrieval through Aleph's own gateway is exact.
 *
 * ## What it cannot do, and why the shape follows
 *
 * **Only `add` exists.** `dag/import`, `block/put`, `dag/put`, `pin/add` and
 * `cat` all 404 on that host. So there is no CAR import and no way to write a
 * dag-cbor block under its own CID — which since 0.5.2 costs nothing, because
 * the CAR goes up as one opaque file anyway and the inner CIDs come back when
 * we unpack it ourselves.
 *
 * **The id is Aleph's, not ours.** `add` wraps the file in UnixFS and returns
 * *its* CIDv0 for the wrapper. That is not the CID of our bytes, and the handle
 * says so by carrying an `id` and no `cid`. This is exactly the distinction the
 * contract exists for: a caller that treated the two as interchangeable would
 * eventually restore something that was never backed up.
 *
 * **`add` is ingest, not persistence.** Retention comes from a wallet-signed
 * STORE message with the `ipfs` engine, posted to `api2.aleph.im`. That needs a
 * wallet and an SDK, so it is **injected rather than imported**: pass `pin` and
 * the driver declares `pinByCid`; leave it out and the driver is honest about
 * being ingest-only. `./aleph-pin.js` is that implementation: `createAlephPin`
 * builds and signs the STORE, and is what a caller passes as `pin`.
 *
 * @author @NiKrause
 * @requires ./types.js - the backend contract
 */

import { defineBackend, handleId, BackendError } from "./types.js";
import { fetchFromGateways } from "../gateway-fetch.js";
import {
  ALEPH_API_FORM_HEADROOM,
  ALEPH_API_SIGNED_LIMIT,
  ALEPH_API_UNSIGNED_LIMIT,
  EndpointGoneError,
  PreflightRefusedError,
  hashFromAddAnswer,
  postFile,
  unixfsCid,
  uploadTimeout,
} from "./aleph-upload.js";

/**
 * Aleph's own, and only Aleph's own.
 *
 * `dweb.link` and `ipfs.io` were the two fallbacks behind it until Protocol
 * Labs retired them on 2026-09-21; they answer 429 with a `Sunset` header now.
 * Nothing free was found to replace them that will serve an arbitrary CID, so
 * this driver's retrieval over HTTP depends on one host; `peer-fetch` (since
 * 0.12.0) is the other path, over libp2p. A caller with its own gateway passes
 * `gateways`.
 */
export const ALEPH_GATEWAYS = Object.freeze(["https://ipfs.aleph.cloud/ipfs"]);

const ALEPH_INGEST = "https://ipfs.aleph.cloud/api/v0/add";
/**
 * Where an upload goes when the IPFS host takes none: an API node's
 * `/api/v0/ipfs/add_file`. Since 2026-10-26 every `/api/v0/` call on Aleph's
 * IPFS hosts answers 404 (they serve the gateway only); the API nodes still
 * take a file, with the limits `./aleph-upload.js` names.
 */
export const DEFAULT_ALEPH_API_HOST = "https://api2.aleph.im";
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Create an Aleph backend.
 *
 * @param {object} [options]
 * @param {string | null} [options.ingestUrl] - defaults to Aleph's public IPFS
 *   host; `null` skips it and uploads through the API node from the start
 * @param {string} [options.apiHost] - an Aleph API node, for when the IPFS host
 *   takes no uploads (404); defaults to `api2.aleph.im`
 * @param {string[]} [options.gateways] - retrieval, tried in order
 * @param {number} [options.timeout] - per request, in ms; an upload gets its
 *   bytes' own time on top (`aleph-upload.js`)
 * @param {(cid: string, meta?: object) => Promise<any>} [options.pin] - make it
 *   stick. Aleph retains what a wallet-signed STORE message names, so this is
 *   the caller's wallet, not ours. Supplying it is what declares `pinByCid`;
 *   without it the driver stores and says plainly that it does not retain.
 *   A pin with a `sign(cid, meta)` method (`createAlephPin` has one) lets an
 *   upload through the API node carry its STORE message: the node keeps the
 *   file in the same call, up to 1 GiB, and the handle says `retained`.
 * @param {typeof fetch} [options.fetch] - for tests, or a browser with its own
 * @returns {import("./types.js").StorageBackend}
 */
export function createAlephBackend(options = {}) {
  const ingestUrl = options.ingestUrl === null ? null : options.ingestUrl || ALEPH_INGEST;
  const apiHost = (options.apiHost || DEFAULT_ALEPH_API_HOST).replace(/\/+$/, "");
  const gateways = options.gateways || ALEPH_GATEWAYS;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const pin = options.pin;
  const doFetch = options.fetch || globalThis.fetch;

  if (typeof doFetch !== "function") {
    throw new BackendError(
      "INVALID_BACKEND",
      "The aleph backend needs fetch — pass one in `options.fetch` on a runtime without it",
    );
  }

  /** The IPFS host answered 404 or 405 once: it takes no uploads, not asked again. */
  let ingestGone = false;

  /**
   * The IPFS host's `add`. With progress once; a browser whose preflight the
   * host refuses (it allows its own console only, aleph-im/pyaleph#1280) sends
   * again without, and the host is not asked for progress a second time.
   */
  let ingestUnmeasured = false;
  async function viaIngest({ bytes, name, contentType, onProgress }) {
    const ms = uploadTimeout(bytes.length, timeout);
    const post = (progress) =>
      postFile({
        url: ingestUrl,
        bytes,
        name,
        contentType,
        onProgress: progress,
        timeout: ms,
        fetch: doFetch,
      });
    let answer;
    if (onProgress && !ingestUnmeasured) {
      try {
        answer = await post(onProgress);
      } catch (error) {
        if (!(error instanceof PreflightRefusedError)) throw error;
        ingestUnmeasured = true;
      }
    }
    if (!answer) answer = await post(undefined);
    if (answer.status < 200 || answer.status >= 300) {
      throw new BackendError(
        "UNSUPPORTED",
        `Aleph ingest answered ${answer.status} ${answer.text.slice(0, 200)}`,
      );
    }
    return hashFromAddAnswer(answer.text, name);
  }

  const backend = {
    name: "aleph",

    capabilities: {
      // Follows from `pin`, rather than being claimed: the contract checks that
      // the flag and the method agree, and this is where they come from.
      pinByCid: Boolean(pin),
      carImport: false,
      // A CAR goes up as one opaque file and comes back byte for byte —
      // measured, not assumed, and the conformance suite re-checks it on every
      // run by verifying each block against its own CID.
      preservesInnerCids: true,
      // No key exists to leak.
      browserSafeAuth: true,
      // Aleph's `security` aggregate (`createAlephAuthorizer` in ./aleph-pin.js)
      // lets a paying account authorise another key for STORE on a channel, and
      // revoke it — but never for a time, and the contract's `delegation` means
      // scoped *and* time-bounded. So: no, with the grant documented there.
      delegation: false,
      // The IPFS host offers no listing, and the messages API needs the paying
      // account's address, which this driver deliberately does not hold:
      // `listAlephStores` in ./aleph-pin.js takes it.
      listing: false,
      // Unpinning is a FORGET message signed by the paying account:
      // `createAlephForget` / `forgetAlephStores` in ./aleph-pin.js. `remove()`
      // would need a key this driver does not hold, and claiming a deletion it
      // cannot perform would be worse than saying no.
      deletion: false,
      minBlobSize: 0,
    },

    async putBlob(bytes, meta = {}) {
      const name = meta.name || "blob";
      const contentType = meta.contentType || "application/octet-stream";
      const onProgress = typeof meta.onProgress === "function" ? meta.onProgress : undefined;
      const handle = {
        backend: "aleph",
        size: bytes.length,
        ...(meta.name ? { name: meta.name } : {}),
      };

      // The IPFS host first, while it answers at all: an upload there is
      // free of any limit below 1 GiB and needs no message. A 404 or 405 says
      // it takes none, and is remembered for this backend's lifetime.
      if (ingestUrl && !ingestGone) {
        try {
          const id = await viaIngest({ bytes, name, contentType, onProgress });
          // Said out loud in the handle, because "stored" and "kept" are not
          // the same thing here and a caller should not have to read this
          // file. An upload here is never kept by itself, `pin` or not:
          // keeping is a STORE, which `pinCid` sends.
          return { ...handle, id, retained: false };
        } catch (error) {
          if (!(error instanceof EndpointGoneError)) throw error;
          ingestGone = true;
        }
      }

      // The API node. With a signed STORE message beside the file the node
      // keeps it in the same call; without one it takes at most 25 MiB and
      // keeps it for a day, until a STORE names it.
      const signed = typeof pin?.sign === "function";
      // The node measures the request body, the form around the file included.
      const limit =
        (signed ? ALEPH_API_SIGNED_LIMIT : ALEPH_API_UNSIGNED_LIMIT) - ALEPH_API_FORM_HEADROOM;
      if (bytes.length > limit) {
        const error = new BackendError(
          "UNSUPPORTED",
          signed
            ? `Aleph's API takes at most ${limit} bytes in one upload; this blob has ${bytes.length}`
            : `Aleph's IPFS host takes no uploads, and its API takes at most ${limit} bytes without a signed STORE message; this blob has ${bytes.length}. Pass a pin with \`sign\` (createAlephPin) to upload up to 1 GiB`,
        );
        // For a caller that wants to say it in its own words.
        error.reason = signed ? "signed-limit" : "unsigned-limit";
        error.limit = limit;
        error.size = bytes.length;
        throw error;
      }
      const fields = {};
      let itemHash;
      if (signed) {
        // The node checks, after pinning, that the CID it made is the one the
        // message names: so the CID is computed here first, the way the node
        // computes it (aleph-upload.js `unixfsCid`).
        const cid = await unixfsCid(bytes);
        const message = await pin.sign(cid, meta);
        itemHash = message.item_hash;
        fields.metadata = JSON.stringify({ message, sync: true });
      }
      const { status, text } = await postFile({
        url: `${apiHost}/api/v0/ipfs/add_file`,
        bytes,
        name,
        fields,
        contentType,
        onProgress,
        timeout: uploadTimeout(bytes.length, timeout),
        fetch: doFetch,
      });
      if (status < 200 || status >= 300) {
        throw new BackendError(
          "UNSUPPORTED",
          `Aleph's API answered ${status} ${text.slice(0, 200)}`,
        );
      }
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new BackendError("UNSUPPORTED", "Aleph's API answered something that is not JSON");
      }
      if (typeof body?.hash !== "string" || !body.hash) {
        throw new BackendError("UNSUPPORTED", "Aleph's API returned no hash");
      }
      // A signed upload answers with the message's status (200 processed,
      // 202 pending); a plain one is stored, not kept, as on the IPFS host.
      const messageStatus = signed ? (status === 200 ? "processed" : "pending") : undefined;
      return {
        ...handle,
        id: body.hash,
        retained: messageStatus === "processed",
        ...(messageStatus ? { status: messageStatus } : {}),
        ...(itemHash ? { itemHash } : {}),
      };
    },

    async getBlob(handle, options = {}) {
      const id = handleId(handle);
      try {
        return await fetchFromGateways(id, {
          gateways,
          timeout,
          ...(typeof options?.onProgress === "function" ? { onProgress: options.onProgress } : {}),
        });
      } catch (error) {
        throw new BackendError("NOT_FOUND", `No blob for ${id}: ${error.message}`);
      }
    },
  };

  if (pin) {
    /**
     * Ask Aleph to keep something already on IPFS.
     *
     * Class 1 for the pin, class 2 for the bytes — the split the evaluation
     * predicted, and the reason `pinCid` here does not upload anything.
     */
    backend.pinCid = async (cid, meta = {}) => {
      const kept = await pin(cid, meta);
      // A pin that reports Aleph's answer (createAlephPin does) is believed:
      // retained only once the STORE is processed, and a pending one says so,
      // with the item hash to follow it by (waitForMessage). A pin that
      // reports nothing keeps the old answer.
      const status = typeof kept?.status === "string" ? kept.status : undefined;
      return {
        id: cid,
        cid,
        backend: "aleph",
        retained: status === undefined || status === "processed",
        ...(status ? { status } : {}),
        ...(kept?.itemHash ? { itemHash: kept.itemHash } : {}),
        ...(meta.name ? { name: meta.name } : {}),
      };
    };
  }

  return defineBackend(backend);
}

export default createAlephBackend;
