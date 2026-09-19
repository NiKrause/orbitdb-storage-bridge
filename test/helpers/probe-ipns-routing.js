/**
 * @fileoverview Can a browser publish an IPNS record through delegated routing?
 *
 *     node test/helpers/probe-ipns-routing.js [endpoint …]
 *
 * P11 (funkpost#93) needs a pointer a second device can find with nothing but a
 * security key: derive a key from the PRF value, and the IPNS name follows from
 * it, so both devices compute the same name without exchanging anything. What
 * nobody has verified is the other half — whether a record signed in a *page*
 * can be published at all now that `w3name` (Storacha's) is gone.
 *
 * This asks three questions of each endpoint and prints the answers:
 *
 *   1. does `PUT /routing/v1/ipns/{name}` take a record?
 *   2. does `GET /routing/v1/ipns/{name}` give it back, and does it validate
 *      against the name?
 *   3. would a browser be allowed to do either — the CORS preflight, which is
 *      what decides whether this works from a page with no server behind it?
 *
 * The key here is derived from a fixed label, not from anybody's PRF value: the
 * probe tests the road, not an identity, and nothing secret goes near it.
 *
 * `--read-only` publishes nothing and only asks what is still there — which is
 * how to find out, a day later, how long a record survives.
 *
 * **Measured 2026-09-19 against https://delegated-ipfs.dev:** the preflight
 * allows `PUT` from any origin (204, `access-control-allow-origin: *`), the
 * `PUT` is accepted (200), and the `GET` gives the record back byte for byte
 * and it validates against the name. Run from a real browser page on a
 * different origin, both calls answer 200 as well — so a page with no server
 * behind it can publish a pointer and read it back, which is what P11 needed
 * to know.
 *
 * Two things this has **not** established: whether the record travels beyond
 * the endpoint that took it (the public gateways answered 429 and 403, which
 * is no evidence either way), and how long it is kept. Until the first is
 * answered, a recovery over this road depends on that one service.
 *
 * One thing to expect: a **second** publish under the same name was still not
 * being served six minutes later — the endpoint went on handing out the first
 * record. P11 writes a pointer once and reads it back later, so that is
 * tolerable, but nothing may assume an update is visible at once.
 *
 * A note on reading the output: Node sends no `Origin` header, so the
 * `allow-origin` column of the GET line says nothing. The browser run is the
 * real answer about CORS, and it was 200 both ways.
 */

import {
  createIPNSRecord,
  marshalIPNSRecord,
  unmarshalIPNSRecord,
  multihashToIPNSRoutingKey,
} from "ipns";
import { ipnsValidator } from "ipns/validator";
import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { CID } from "multiformats/cid";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const readOnly = args.includes("--read-only");
const given = args.filter((arg) => !arg.startsWith("--"));
const ENDPOINTS =
  given.length > 0
    ? given
    : ["https://delegated-ipfs.dev", "https://cid.contact"];

// Something to point at. Any CID does — the record is what is under test, not
// the data — so this is the empty-directory CID every IPFS node knows.
const TARGET = CID.parse(
  "bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354",
);
const LIFETIME = 48 * 60 * 60 * 1000; // ms, the `ipns` package's unit
const ORIGIN = "https://example.org"; // a page's origin, for the preflight
// Independent resolvers, to see whether a published record leaves the desk it
// was handed in at.
const RESOLVERS = ["https://ipfs.io", "https://dweb.link"];

const seed = createHash("sha256")
  .update("@le-space/orbitdb-storage-bridge ipns routing probe")
  .digest();
const privateKey = await generateKeyPairFromSeed("Ed25519", seed);
const peerId = peerIdFromPrivateKey(privateKey);
const name = CID.createV1(0x72, peerId.toMultihash()).toString(); // libp2p-key, base32 by default

// A sequence that always moves forward, so re-runs are not rejected as stale.
const sequence = BigInt(Math.floor(Date.now() / 1000));
const record = await createIPNSRecord(privateKey, TARGET, sequence, LIFETIME);
const body = marshalIPNSRecord(record);

console.log(`name       ${name}`);
console.log(`points at  ${TARGET}`);
console.log(`record     ${body.length} bytes, sequence ${sequence}`);

const short = (text, max = 160) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

for (const endpoint of ENDPOINTS) {
  const url = `${endpoint.replace(/\/$/, "")}/routing/v1/ipns/${name}`;
  console.log(`\n── ${endpoint}`);

  // 3 · the preflight first: if a browser may not ask, the rest is academic.
  try {
    const preflight = await fetch(url, {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    const allowOrigin = preflight.headers.get("access-control-allow-origin");
    const allowMethods = preflight.headers.get("access-control-allow-methods");
    console.log(
      `preflight  ${preflight.status} · allow-origin ${allowOrigin ?? "—"} · allow-methods ${allowMethods ?? "—"}`,
    );
  } catch (error) {
    console.log(`preflight  failed: ${short(error.message)}`);
  }

  // 1 · the publish
  let published = false;
  if (readOnly) {
    console.log("PUT        skipped (--read-only)");
  } else
    try {
      const put = await fetch(url, {
        method: "PUT",
        headers: {
          "Content-Type": "application/vnd.ipfs.ipns-record",
          Origin: ORIGIN,
        },
        body,
      });
      const text = await put.text().catch(() => "");
      published = put.ok;
      console.log(
        `PUT        ${put.status} ${put.statusText}${text ? ` · ${short(text.trim())}` : ""}`,
      );
    } catch (error) {
      console.log(`PUT        failed: ${short(error.message)}`);
    }

  // 2 · and the read back, validated against the name rather than trusted
  try {
    const get = await fetch(url, {
      headers: { Accept: "application/vnd.ipfs.ipns-record", Origin: ORIGIN },
    });
    const type = get.headers.get("content-type") ?? "—";
    const cors = get.headers.get("access-control-allow-origin") ?? "—";
    if (!get.ok) {
      console.log(
        `GET        ${get.status} ${get.statusText} · content-type ${type} · allow-origin ${cors}`,
      );
      continue;
    }
    const bytes = new Uint8Array(await get.arrayBuffer());
    let verdict = `${bytes.length} bytes`;
    try {
      await ipnsValidator(
        multihashToIPNSRoutingKey(peerId.toMultihash()),
        bytes,
      );
      const back = unmarshalIPNSRecord(bytes);
      verdict += ` · valid · points at ${back.value} · sequence ${back.sequence}`;
      verdict += readOnly
        ? " (whatever is stored — this run published nothing)"
        : back.sequence === sequence
          ? " (ours)"
          : " (an older one: this endpoint has not taken the new record yet)";
    } catch (error) {
      verdict += ` · did NOT validate: ${short(error.message, 80)}`;
    }
    console.log(
      `GET        ${get.status} · content-type ${type} · allow-origin ${cors} · ${verdict}`,
    );
  } catch (error) {
    console.log(`GET        failed: ${short(error.message)}`);
  }

  if (!published) continue;
  console.log("verdict    this endpoint took the record");

  // Handed in at one desk — can it be found from another? A gateway resolves
  // /ipns/ through its own routing, so this says whether the record travelled
  // beyond the endpoint that accepted it, which is what phone B depends on.
  for (const resolver of RESOLVERS) {
    const started = Date.now();
    let answer = "never";
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const res = await fetch(`${resolver}/ipns/${name}`, {
          method: "HEAD",
          redirect: "manual",
          headers: { Origin: ORIGIN },
        });
        if (res.status < 400) {
          answer = `${res.status} after ${Math.round((Date.now() - started) / 1000)} s`;
          break;
        }
        answer = `${res.status}`;
      } catch (error) {
        answer = `failed: ${short(error.message, 60)}`;
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    console.log(`elsewhere  ${resolver} · ${answer}`);
  }
}
