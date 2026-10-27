/**
 * @fileoverview A stand-in for Aleph's IPFS host.
 *
 * The real one is public, keyless and free, which makes it tempting to point
 * the suite straight at it. That would mean every CI run writes into somebody
 * else's infrastructure and every offline developer sees red, to prove a
 * contract that is about our side of the wire.
 *
 * So: the two endpoints the driver actually uses, with the shapes measured
 * against the live host on 2026-09-09 — `POST /api/v0/add` answering
 * `{ Name, Hash, Size }`, and `GET /ipfs/<id>` returning exactly what went in.
 * The live check lives separately and is opt-in.
 *
 * One more shape, measured on 2026-09-17 after it broke every real backup:
 * `add` answers **one JSON object per line**. A file name with a path in it —
 * which is how `backupDatabase` names every file it writes — makes the host
 * wrap the file in directories and add a line for each. A stub that always
 * answered a single object hid that for as long as no test named a file.
 *
 * The ids it issues are content addresses, which the real host's are not: Aleph
 * returns a CIDv0 for the UnixFS wrapper it makes. That difference does not
 * reach the driver, which treats the id as opaque — and a stub that invented a
 * *less* opaque id would be a worse test, not a better one.
 *
 * Since 2026-10-26 the real IPFS hosts answer every `/api/v0/` call with 404,
 * and uploads go to an API node's `POST /api/v0/ipfs/add_file` instead
 * (measured 2026-10-27): one JSON object `{ status, hash, name, size }`, the
 * hash a UnixFS CIDv0 — here computed as the driver computes it, because the
 * node compares the two; a `metadata` part with a signed STORE message whose
 * content names that CID (else 422), kept at once (`stores`, 200 with `sync`);
 * without one at most 25 MiB (else 413). `ingestGone()` makes `add` answer
 * 404, as the real hosts do now.
 */

import { createServer } from "node:http";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import {
  unixfsCid,
  ALEPH_API_UNSIGNED_LIMIT,
} from "../../lib/backends/aleph-upload.js";

/**
 * Pull the single file part, and the file name it was sent with, out of a
 * multipart body.
 *
 * Deliberately minimal: the driver sends one part, and a general parser here
 * would be a second implementation to get wrong. It finds the blank line that
 * ends the part headers and the boundary that follows the content — which is
 * the whole format, for one part.
 */
function filePart(body, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!match) return null;
  const boundary = Buffer.from(`--${match[1] || match[2]}`);

  const start = body.indexOf(boundary);
  if (start < 0) return null;
  const headerEnd = body.indexOf("\r\n\r\n", start);
  if (headerEnd < 0) return null;

  const contentStart = headerEnd + 4;
  const nextBoundary = body.indexOf(boundary, contentStart);
  if (nextBoundary < 0) return null;

  const headers = body.subarray(start, headerEnd).toString("utf8");
  const filename = /filename="([^"]*)"/i.exec(headers)?.[1] || "blob";
  // The CRLF before the closing boundary belongs to the format, not the file.
  return { bytes: body.subarray(contentStart, nextBoundary - 2), filename };
}

/**
 * Every part of a multipart body, by field name: `add_file` takes the file
 * and, beside it, a `metadata` string.
 */
function parts(body, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!match) return new Map();
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const found = new Map();
  let at = body.indexOf(boundary);
  while (at >= 0) {
    const headerEnd = body.indexOf("\r\n\r\n", at);
    if (headerEnd < 0) break;
    const contentStart = headerEnd + 4;
    const next = body.indexOf(boundary, contentStart);
    if (next < 0) break;
    const headers = body.subarray(at, headerEnd).toString("utf8");
    const name = /name="([^"]*)"/i.exec(headers)?.[1] || "";
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
    found.set(name, { bytes: body.subarray(contentStart, next - 2), filename });
    at = next;
  }
  return found;
}

const readBody = (request) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });

/**
 * Start the stub.
 *
 * @returns {Promise<{ url: string, gatewayUrl: string, ingestUrl: string,
 *   publish: (cid: string, bytes: Uint8Array) => void, count: () => number,
 *   stop: () => Promise<void> }>}
 */
export async function startAlephStub() {
  /** @type {Map<string, Uint8Array>} */
  const store = new Map();
  let uploads = 0;
  /** `add` answers 404, as the real hosts do since 2026-10-26. */
  let gone = false;
  /** The STORE messages that came with an `add_file` upload. */
  const stores = [];

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");

      if (
        request.method === "POST" &&
        url.pathname === "/api/v0/ipfs/add_file"
      ) {
        const body = await readBody(request);
        const found = parts(body, request.headers["content-type"]);
        const file = found.get("file");
        if (!file) {
          response.writeHead(422).end("422: no file part");
          return;
        }
        const bytes = new Uint8Array(file.bytes);
        const metadata = found.get("metadata");
        if (!metadata && bytes.length > ALEPH_API_UNSIGNED_LIMIT) {
          response.writeHead(413).end("413: File too large");
          return;
        }
        let message;
        let sync = false;
        if (metadata) {
          try {
            ({ message, sync } = JSON.parse(metadata.bytes.toString("utf8")));
          } catch {
            response.writeHead(422).end("422: Could not decode metadata");
            return;
          }
          const content = JSON.parse(message.item_content);
          if (content.item_type !== "ipfs") {
            response
              .writeHead(422)
              .end("422: Expected item_type=ipfs in STORE message");
            return;
          }
          if (
            typeof message.signature !== "string" ||
            !message.signature.startsWith("0x")
          ) {
            response.writeHead(403).end("403: signature invalid");
            return;
          }
        }
        const hash = await unixfsCid(bytes);
        if (message) {
          const content = JSON.parse(message.item_content);
          if (content.item_hash !== hash) {
            response
              .writeHead(422)
              .end(
                `422: File hash does not match (${hash} != ${content.item_hash})`,
              );
            return;
          }
          stores.push({
            cid: hash,
            itemHash: message.item_hash,
            sender: message.sender,
            owner: content.address,
            channel: message.channel,
            sync,
          });
        }
        store.set(hash, bytes);
        uploads++;
        response.writeHead(message && !sync ? 202 : 200, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify({
            status: "success",
            hash,
            name: file.filename || "file",
            size: bytes.length,
          }),
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/v0/add") {
        if (gone) {
          response.writeHead(404).end("404 page not found");
          return;
        }
        const body = await readBody(request);
        const part = filePart(body, request.headers["content-type"]);
        if (!part) {
          response.writeHead(400).end("no file part");
          return;
        }
        const bytes = new Uint8Array(part.bytes);
        const id = CID.create(
          1,
          raw.code,
          await sha256.digest(bytes),
        ).toString();
        store.set(id, bytes);
        uploads++;
        // The file first, then every directory its name made the host create,
        // innermost first — one JSON object per line, as the live host answers.
        const lines = [
          { Name: part.filename, Hash: id, Size: String(bytes.length) },
        ];
        const directories = part.filename.split("/").slice(0, -1);
        for (let depth = directories.length; depth > 0; depth--) {
          const name = directories.slice(0, depth).join("/");
          const wrapper = await sha256.digest(
            new TextEncoder().encode(`directory:${name}`),
          );
          lines.push({
            Name: name,
            Hash: CID.create(1, raw.code, wrapper).toString(),
            Size: "0",
          });
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/ipfs/")) {
        const bytes = store.get(url.pathname.slice("/ipfs/".length));
        if (!bytes) {
          response.writeHead(404).end("not found");
          return;
        }
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(Buffer.from(bytes));
        return;
      }

      // Everything else 404s, exactly as the real host does for `dag/import`,
      // `block/put`, `pin/add` and `cat` — so a driver that starts reaching for
      // them fails here rather than in production.
      response.writeHead(404).end("not found");
    } catch (error) {
      response.writeHead(500).end(String(error?.message ?? error));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    ingestUrl: `${url}/api/v0/add`,
    gatewayUrl: `${url}/ipfs`,
    /** Make a CID resolvable without uploading — what `pinCid` then points at. */
    publish: (cid, bytes) => store.set(cid, bytes),
    count: () => uploads,
    /** From now on `add` answers 404, as Aleph's IPFS hosts do since 2026-10-26. */
    ingestGone: (on = true) => {
      gone = on;
    },
    /** The STORE messages that came beside an `add_file` upload. */
    stores,
    stop: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

export default startAlephStub;
