/**
 * @fileoverview The restored device writes, and the original takes it.
 *
 * P11 step 5 (funkpost#93), and the point the whole phase turns on: a restored
 * copy that can only be *read* is a photograph. Writing means the access
 * controller that named the original writer recognises the device that came
 * back — which it can only do if that device holds the same identity, not a
 * lookalike.
 *
 * The passkey is the application's half and is not here. What it produces is: a
 * signing key that is *derived* rather than generated, so both devices arrive
 * at the same one. That is modelled by seeding both keystores with the same
 * 32 bytes — exactly what `deriveSigningKeyBytes` in
 * `@le-space/orbitdb-identity-provider-webauthn-did` hands an application.
 */

import {
  jest,
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
} from "@jest/globals";
import {
  createOrbitDB,
  Identities,
  KeyStore,
  MemoryStorage,
  IPFSAccessController,
} from "@orbitdb/core";
import { createServer } from "node:http";
import { createHash } from "node:crypto";

import { dehydrate, hydrate } from "../lib/dehydrate.js";
import { createCourierSync } from "../lib/courier-sync.js";
import { createMemoryCourierPair } from "../lib/memory-courier.js";
import { createMemoryBackend } from "../lib/backends/memory.js";
import { createHeliaOrbitDB, cleanupOrbitDBDirectories } from "../lib/utils.js";

jest.setTimeout(180_000);

const TIMEOUT = 120_000;
const OFFLINE = { useBootstrap: false, useDHT: false, autoDial: false };
const IDENTITY_ID = "the-owner";
const SEED = new TextEncoder().encode("one passkey, two devices");

/** What a PRF-derived signing key looks like from here: 32 deterministic bytes. */
const signingKeyFrom = (label) =>
  new Uint8Array(createHash("sha256").update(`signing key: ${label}`).digest());

/**
 * An OrbitDB whose identity is derived rather than generated. Two of these
 * with the same key are the same writer, on machines that never met.
 */
async function nodeWithDerivedIdentity(helia, signingKey, suffix) {
  const keystore = await KeyStore({ storage: await MemoryStorage() });
  // Twice, and the second time is the one that matters. The default provider
  // resolves `id` to the *hex public key* of the key stored under it, and
  // `createIdentity` then looks up a key under that hex id — generating a
  // random one when it finds none. Seeding only the label leaves the identity
  // with a random keypair, which is a different identity on every device even
  // though the seed is the same. (The WebAuthn provider avoids the detour: its
  // id is the DID, and it seeds the key under the DID.)
  await keystore.addKey(IDENTITY_ID, { privateKey: signingKey });
  const seeded = await keystore.getKey(IDENTITY_ID);
  const derivedId = [...seeded.publicKey.raw]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  await keystore.addKey(derivedId, { privateKey: signingKey });
  // `ipfs` matters: without it `Identities` keeps identity documents in memory
  // only, so a node can verify entries written by identities it created itself
  // and no others. A restored database is full of the latter.
  const identities = await Identities({ keystore, ipfs: helia });
  const identity = await identities.createIdentity({ id: IDENTITY_ID });
  const orbitdb = await createOrbitDB({
    ipfs: helia,
    identity,
    identities,
    // `orbitdb-bridge-` so the suite's own cleanup removes it, and a fresh name
    // every run: a directory left behind keeps the log's *heads*, and a head
    // pointing at an entry that is no longer in the blockstore fails the next
    // run with a block that cannot be loaded — from the run before it.
    directory: `./orbitdb-bridge-restored-write-${suffix}-${Date.now()}`,
  });
  return { orbitdb, identity };
}

let first;
let second;
let stranger;
let routing;
let backend;

function startRouting() {
  const records = new Map();
  const server = createServer((request, response) => {
    const name = request.url.split("/").pop();
    if (request.method === "PUT") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        records.set(name, Buffer.concat(chunks));
        response.writeHead(200).end();
      });
      return;
    }
    const record = records.get(name);
    if (!record) {
      response.writeHead(404).end("not found");
      return;
    }
    response
      .writeHead(200, { "content-type": "application/vnd.ipfs.ipns-record" })
      .end(record);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        endpoints: [`http://127.0.0.1:${server.address().port}`],
        stop: () => new Promise((done) => server.close(done)),
      }),
    ),
  );
}

beforeAll(async () => {
  const [a, b, c] = await Promise.all([
    createHeliaOrbitDB("-restored-write-first", OFFLINE),
    createHeliaOrbitDB("-restored-write-second", OFFLINE),
    createHeliaOrbitDB("-restored-write-stranger", OFFLINE),
  ]);
  // The lost phone and its replacement: one key, two machines.
  first = {
    helia: a.helia,
    ...(await nodeWithDerivedIdentity(
      a.helia,
      signingKeyFrom("owner"),
      "first",
    )),
  };
  second = {
    helia: b.helia,
    ...(await nodeWithDerivedIdentity(
      b.helia,
      signingKeyFrom("owner"),
      "second",
    )),
  };
  // Somebody else's key entirely.
  stranger = {
    helia: c.helia,
    ...(await nodeWithDerivedIdentity(
      c.helia,
      signingKeyFrom("stranger"),
      "stranger",
    )),
  };
  routing = await startRouting();
  backend = createMemoryBackend();
}, TIMEOUT);

afterAll(async () => {
  await routing?.stop();
  for (const side of [first, second, stranger]) {
    await side?.orbitdb?.stop?.();
    await side?.helia?.stop?.();
  }
  await cleanupOrbitDBDirectories();
}, TIMEOUT);

describe("P11 step 5 — the device that came back is the writer, not a reader", () => {
  test(
    "a derived identity is the same identity on a machine that never saw the first",
    async () => {
      // Everything below rests on this: the same key, the same identity
      // document, hash for hash — not merely a key that can sign.
      expect(second.identity.id).toBe(first.identity.id);
      expect(second.identity.hash).toBe(first.identity.hash);
      expect(stranger.identity.id).not.toBe(first.identity.id);
    },
    TIMEOUT,
  );

  test(
    "it writes to the restored database, and the original takes the entry",
    async () => {
      // The database only its owner may write to.
      // `sync: false` on both sides: these two devices have no libp2p path to
      // each other, which is the situation the whole phase is about. What
      // carries the entry at the end is the courier, deliberately.
      const original = await first.orbitdb.open("p11-step-5", {
        type: "events",
        sync: false,
        AccessController: IPFSAccessController({ write: [first.identity.id] }),
      });
      await original.add("written before the phone was lost");

      await dehydrate({
        orbitdb: first.orbitdb,
        address: original.address,
        seed: SEED,
        label: "step-5",
        backend,
        // This test is about who may write, not about secrecy.
        dontEncrypt: true,
        endpoints: routing.endpoints,
      });

      // The replacement: the same passkey, the same derived identity, and
      // nothing else at all.
      const restored = await hydrate({
        orbitdb: second.orbitdb,
        seed: SEED,
        label: "step-5",
        endpoints: routing.endpoints,
        open: { sync: false },
        restore: { fetchBytes: (id) => backend.getBlob(id) },
      });
      expect(restored.address).toBe(original.address);

      // Reading is not the question. Writing is.
      const hash = await restored.db.add("written after it came back");
      expect(hash).toBeTruthy();

      // And the original accepts it — which is the access controller saying
      // yes to a device it has never met. The courier carries it because the
      // two nodes hold no connection; what matters is the join at the far end.
      const pair = createMemoryCourierPair();
      const syncFirst = await createCourierSync({
        db: original,
        courier: pair.a,
      });
      const syncSecond = await createCourierSync({
        db: restored.db,
        courier: pair.b,
      });
      await syncFirst.start();
      await syncSecond.start();
      for (let round = 0; round < 25; round += 1) {
        await pair.idle();
        await syncFirst.idle();
        await syncSecond.idle();
      }

      const onTheOriginal = (await original.all()).map((entry) => entry.value);
      expect(onTheOriginal).toContain("written after it came back");

      await syncFirst.stop();
      await syncSecond.stop();
      await restored.db.close();
      await original.close();
    },
    TIMEOUT,
  );

  test(
    "a device with another key is refused, so the acceptance above means something",
    async () => {
      const original = await first.orbitdb.open("p11-step-5-stranger", {
        type: "events",
        sync: false,
        AccessController: IPFSAccessController({ write: [first.identity.id] }),
      });
      await original.add("the owner's entry");

      await dehydrate({
        orbitdb: first.orbitdb,
        address: original.address,
        seed: SEED,
        label: "step-5-stranger",
        backend,
        // This test is about who may write, not about secrecy.
        dontEncrypt: true,
        endpoints: routing.endpoints,
      });

      // Somebody who has the pointer — the seed is the only secret, and this
      // test hands it over on purpose — but not the identity.
      const restored = await hydrate({
        orbitdb: stranger.orbitdb,
        seed: SEED,
        label: "step-5-stranger",
        endpoints: routing.endpoints,
        open: { sync: false },
        restore: { fetchBytes: (id) => backend.getBlob(id) },
      });

      // They can read it. That is what a public backup is.
      expect((await restored.db.all()).map((entry) => entry.value)).toContain(
        "the owner's entry",
      );

      // They cannot write to it, and the refusal happens before anything is
      // stored rather than at the far end.
      await expect(restored.db.add("not yours to write")).rejects.toThrow(
        /not allowed to write/i,
      );

      await restored.db.close();
      await original.close();
    },
    TIMEOUT,
  );
});
