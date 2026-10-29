/**
 * @fileoverview The upload itself: one file in a multipart form, with the
 * progress a browser can report, and the CID Aleph will give the file.
 *
 * Two hosts take a file (`./aleph.js` says which is tried when):
 *
 * - the IPFS host's `POST /api/v0/add`, which answers one JSON object per
 *   line, `{ Name, Hash, Size }` for the file and one more for every directory
 *   a name with a path made it create;
 * - an API node's `POST /api/v0/ipfs/add_file`, which answers one object,
 *   `{ status, hash, name, size }`, and takes a signed STORE message in a
 *   `metadata` part beside the file. With the message the node keeps the file
 *   in the same call and lets it be up to 1 GiB; without, 25 MiB
 *   (pyaleph's `max_unauthenticated_upload_file_size`) and a 24-hour grace
 *   period until a STORE names it. The node checks the message's signature
 *   and the account's balance before it pins, and after pinning that the CID
 *   it got is the one the message names — so the CID has to be known before
 *   the upload, which is what `unixfsCid` is for.
 *
 * ## The CID, computed here
 *
 * Both hosts wrap the bytes in UnixFS the way `ipfs add` does by default:
 * CIDv0, dag-pb leaves (no raw leaves), 256 KiB chunks, a balanced tree with
 * up to 174 links a node, a single chunk reduced to the file node itself.
 * `ipfs-unixfs-importer` with those options gave the same CID as the API node
 * for a 16-byte and a 600 KB file (measured 2026-10-27). A file above about
 * 45 MB gets a second level of links; the same defaults cover it, and the live
 * test is where that claim is checked.
 *
 * ## Progress
 *
 * `fetch` says nothing until the last byte is through. Where
 * `XMLHttpRequest` exists (a browser) and progress is asked for, the form goes
 * through it and `onProgress(sent, total)` follows the bytes. Listening to
 * upload progress makes the browser send a CORS preflight first; the API
 * nodes answer it for any origin (measured 2026-10-26), the IPFS host did not
 * (aleph-im/pyaleph#1280) — so on the IPFS host a refused preflight is
 * retried once without progress, by `./aleph.js`.
 *
 * @author @NiKrause
 */

/* global FormData, XMLHttpRequest */

import { importer } from "ipfs-unixfs-importer";
import { CID } from "multiformats/cid";

/**
 * What an API node takes without a signed STORE message: 25 MiB – of the
 * request body, the form around the file included ("Maximum request body
 * size 26214400 exceeded", measured 2026-10-27 with 26.3 MB). So a file this
 * close to it needs `ALEPH_API_FORM_HEADROOM` less.
 */
export const ALEPH_API_UNSIGNED_LIMIT = 25 * 1024 * 1024;

/** Room for the multipart form around the file: its boundaries and headers. */
export const ALEPH_API_FORM_HEADROOM = 4096;

/** What an API node takes with one: 1 GiB (pyaleph's `max_upload_file_size`). */
export const ALEPH_API_SIGNED_LIMIT = 1024 * 1024 * 1024;

/** Two minutes for the host to answer, and the bytes' own time on top. */
const TIMEOUT_MS = 120_000;
/**
 * At least 100 kB/s: a 500 MB file may take its 85 minutes. Two minutes and
 * 1 MB/s were too little for a home uplink — a full backup never went through
 * (Le-Space/belege#505).
 */
const BYTES_PER_MS = 100;

/**
 * The CID Aleph's hosts give `bytes`: UnixFS with `ipfs add`'s defaults.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<string>} a CIDv0, base58btc
 */
export async function unixfsCid(bytes) {
  // The importer writes every block it makes; none is read back, so a sink
  // that keeps nothing is a blockstore enough.
  const sink = {
    put: async (cid) => cid,
    get: async () => {
      throw new Error("unixfsCid keeps no blocks");
    },
    has: async () => false,
  };
  let last;
  for await (const entry of importer([{ content: bytes }], sink, {
    cidVersion: 0,
    rawLeaves: false,
    reduceSingleLeafToSelf: true,
  })) {
    last = entry;
  }
  if (!last) throw new Error("unixfsCid: the importer gave no entry");
  return last.cid.toString();
}

/**
 * Whether `bytes` are the file a UnixFS CID names – one made with `ipfs add`'s
 * defaults, as Aleph's hosts and `unixfsCid` make it. A gateway assembles the
 * file from the DAG, so the bytes themselves hash to nothing the CID says;
 * building the DAG again from them does. Passes a CID this check cannot
 * prove (raw, dag-cbor, another hash, an unparsable string): the raw case is
 * gateway-fetch's own check.
 *
 * What it catches is a download that came back short or damaged. A sealed
 * file then fails to open, and nothing tells that apart from a wrong key
 * (Le-Space/belege, a phone's restore).
 *
 * @param {string} cid
 * @param {Uint8Array} bytes
 * @returns {Promise<boolean>}
 */
export async function matchesUnixfsCid(cid, bytes) {
  let parsed;
  try {
    parsed = CID.parse(String(cid));
  } catch {
    return true;
  }
  // dag-pb, sha-256: what `ipfs add` makes by default.
  if (parsed.code !== 0x70 || parsed.multihash.code !== 0x12) return true;
  const made = CID.parse(await unixfsCid(bytes)).multihash.digest;
  const expected = parsed.multihash.digest;
  if (made.length !== expected.length) return false;
  for (let i = 0; i < made.length; i++)
    if (made[i] !== expected[i]) return false;
  return true;
}

/** Thrown when a host answers that the endpoint is not there (404, 405). */
export class EndpointGoneError extends Error {
  constructor(url, status) {
    super(`${url} answered ${status}: no upload there`);
    this.name = "EndpointGoneError";
    this.status = status;
  }
}

/** Thrown when the browser refused before a byte went: the CORS preflight. */
export class PreflightRefusedError extends Error {
  constructor(url) {
    super(`${url} did not allow this page's preflight`);
    this.name = "PreflightRefusedError";
  }
}

/** The upload took longer than a slow line would. */
export class UploadTimeoutError extends Error {
  constructor(url, ms, size) {
    super(
      `${url} did not answer within ${Math.round(ms / 60_000)} minutes for ${size} bytes`,
    );
    this.name = "UploadTimeoutError";
    this.minutes = Math.round(ms / 60_000);
    this.size = size;
  }
}

/** How long a request for `size` bytes may take. */
export const uploadTimeout = (size, base = TIMEOUT_MS) =>
  Math.ceil(base + size / BYTES_PER_MS);

/**
 * Post `bytes` as the `file` part of a form, with any other string fields
 * beside it, and give back the answer's text.
 *
 * @param {object} params
 * @param {string} params.url
 * @param {Uint8Array} params.bytes
 * @param {string} params.name - the file name, as the host sees it
 * @param {Record<string, string>} [params.fields] - more parts, e.g. `metadata`
 * @param {string} [params.contentType]
 * @param {(sent: number, total: number) => void} [params.onProgress]
 * @param {number} [params.timeout] - ms; default from the size
 * @param {typeof fetch} [params.fetch]
 * @returns {Promise<{ status: number, text: string }>}
 * @throws {EndpointGoneError} 404 or 405
 * @throws {PreflightRefusedError} a browser's preflight was refused (progress asked)
 * @throws {UploadTimeoutError}
 */
export async function postFile({
  url,
  bytes,
  name,
  fields = {},
  contentType = "application/octet-stream",
  onProgress,
  timeout,
  fetch: doFetch,
}) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: contentType }), name);
  for (const [field, value] of Object.entries(fields))
    form.append(field, value);
  const ms = Math.ceil(timeout ?? uploadTimeout(bytes.length));

  if (onProgress && typeof XMLHttpRequest !== "undefined") {
    return postWithProgress({ url, form, size: bytes.length, onProgress, ms });
  }

  const fetchImpl = doFetch || globalThis.fetch;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined,
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new UploadTimeoutError(url, ms, bytes.length);
    }
    throw error;
  }
  if (response.status === 404 || response.status === 405) {
    throw new EndpointGoneError(url, response.status);
  }
  const text = await response.text();
  onProgress?.(bytes.length, bytes.length);
  return { status: response.status, text };
}

/** The same POST through XMLHttpRequest, for the upload events only it reports. */
function postWithProgress({ url, form, size, onProgress, ms }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.timeout = ms;
    let sent = 0;
    xhr.upload.onprogress = (event) => {
      sent = event.loaded;
      onProgress(event.loaded, event.lengthComputable ? event.total : size);
    };
    xhr.onload = () => {
      if (xhr.status === 404 || xhr.status === 405) {
        reject(new EndpointGoneError(url, xhr.status));
        return;
      }
      resolve({ status: xhr.status, text: xhr.responseText });
    };
    // A network error before the first byte went out is, in a browser, the
    // preflight: the host did not allow this origin to count its upload.
    xhr.onerror = () =>
      reject(
        sent === 0
          ? new PreflightRefusedError(url)
          : new Error(`${url} is unreachable`),
      );
    xhr.ontimeout = () => reject(new UploadTimeoutError(url, ms, size));
    xhr.send(form);
  });
}

/**
 * The file's own hash out of the IPFS host's `add` answer: one JSON object
 * per line; the line named like the file, else the first.
 *
 * @param {string} text
 * @param {string} name
 * @returns {string}
 */
export function hashFromAddAnswer(text, name) {
  let entries;
  try {
    entries = text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch {
    throw new Error("Aleph's IPFS host answered something that is not JSON");
  }
  const body = entries.find((entry) => entry?.Name === name) ?? entries[0];
  if (!body?.Hash) throw new Error("Aleph's IPFS host returned no Hash");
  return String(body.Hash);
}
