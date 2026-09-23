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
 * being ingest-only. `relay-button`'s `@le-space/browser` already speaks that
 * API, which is the implementation this hook is shaped for.
 *
 * @author @NiKrause
 * @requires ./types.js - the backend contract
 */

/* global FormData */

import { defineBackend, handleId, BackendError } from "./types.js";
import { fetchFromGateways } from "../gateway-fetch.js";

/**
 * Aleph's own, and only Aleph's own.
 *
 * `dweb.link` and `ipfs.io` were the two fallbacks behind it until Protocol
 * Labs retired them on 2026-09-21; they answer 429 with a `Sunset` header now.
 * Nothing free was found to replace them that will serve an arbitrary CID, so
 * this driver's retrieval depends on one host until the peer path in #112
 * lands. A caller with its own gateway passes `gateways`.
 */
export const ALEPH_GATEWAYS = Object.freeze(["https://ipfs.aleph.cloud/ipfs"]);

const ALEPH_INGEST = "https://ipfs.aleph.cloud/api/v0/add";
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Create an Aleph backend.
 *
 * @param {object} [options]
 * @param {string} [options.ingestUrl] - defaults to Aleph's public IPFS host
 * @param {string[]} [options.gateways] - retrieval, tried in order
 * @param {number} [options.timeout] - per request, in ms
 * @param {(cid: string, meta?: object) => Promise<any>} [options.pin] - make it
 *   stick. Aleph retains what a wallet-signed STORE message names, so this is
 *   the caller's wallet, not ours. Supplying it is what declares `pinByCid`;
 *   without it the driver stores and says plainly that it does not retain.
 * @param {typeof fetch} [options.fetch] - for tests, or a browser with its own
 * @returns {import("./types.js").StorageBackend}
 */
export function createAlephBackend(options = {}) {
  const ingestUrl = options.ingestUrl || ALEPH_INGEST;
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
      delegation: false,
      // The IPFS host offers no listing, and the messages API would need the
      // wallet address this driver deliberately does not hold.
      listing: false,
      // Unpinning is a FORGET message, so it belongs with `pin` rather than
      // here. Claiming deletion the driver cannot perform would be worse than
      // saying no.
      deletion: false,
      minBlobSize: 0,
    },

    async putBlob(bytes, meta = {}) {
      const name = meta.name || "blob";
      const form = new FormData();
      form.append(
        "file",
        new Blob([bytes], { type: meta.contentType || "application/octet-stream" }),
        name,
      );

      let response;
      try {
        response = await doFetch(ingestUrl, {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout ? AbortSignal.timeout(timeout) : undefined,
        });
      } catch (error) {
        throw new BackendError("UNSUPPORTED", `Aleph ingest is unreachable: ${error.message}`);
      }

      if (!response.ok) {
        throw new BackendError(
          "UNSUPPORTED",
          `Aleph ingest answered ${response.status} ${response.statusText}`,
        );
      }

      // `add` answers one JSON object per line. A name with a path in it — and
      // backupDatabase gives every file one — makes the host wrap the file in
      // directories and add a line for each (measured 2026-09-17). The id we
      // keep is the file's own, never a wrapper's.
      let entries;
      try {
        entries = (await response.text())
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));
      } catch {
        throw new BackendError("UNSUPPORTED", "Aleph ingest answered something that is not JSON");
      }
      const body = entries.find((entry) => entry?.Name === name) ?? entries[0];
      if (!body?.Hash) {
        throw new BackendError("UNSUPPORTED", "Aleph ingest returned no Hash");
      }

      return {
        // Aleph's CIDv0 for the UnixFS wrapper it made. Deliberately not
        // reported as `cid`: it names their encoding of our bytes, not ours.
        id: body.Hash,
        backend: "aleph",
        size: bytes.length,
        ...(meta.name ? { name: meta.name } : {}),
        // Said out loud in the handle, because "stored" and "kept" are not the
        // same thing here and a caller should not have to read this file.
        retained: Boolean(pin),
      };
    },

    async getBlob(handle) {
      const id = handleId(handle);
      try {
        return await fetchFromGateways(id, { gateways, timeout });
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
      await pin(cid, meta);
      return { id: cid, cid, backend: "aleph", retained: true, ...(meta.name ? { name: meta.name } : {}) };
    };
  }

  return defineBackend(backend);
}

export default createAlephBackend;
