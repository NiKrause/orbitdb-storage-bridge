/**
 * @fileoverview Every storage driver the suites hold to the contract.
 *
 * A plain module rather than part of a test file, so that a second suite can
 * iterate the same list without importing — and therefore re-running — the
 * first one. Adding a backend stays one entry, and it is then asked both
 * questions: does it keep bytes (`conformance.test.js`), and does it bring a
 * database back (`restore.test.js`).
 */

import { createMemoryBackend } from "../../lib/backends/memory.js";
import { createStorachaBackend } from "../../lib/backends/storacha.js";
import { createAlephBackend } from "../../lib/backends/aleph.js";
import { createPinataBackend } from "../../lib/backends/pinata.js";
import { createLighthouseBackend } from "../../lib/backends/lighthouse.js";
import {
  startInMemoryStorachaService,
  stopInMemoryStorachaService,
} from "../helpers/in-memory-storacha.js";
import { startAlephStub } from "../helpers/aleph-stub.js";
import {
  createAlephPin,
  createAlephForget,
  waitForMessage,
} from "../../lib/backends/aleph-pin.js";
import { createEthSigner } from "../helpers/eth-signer.js";

/** The channel every live STORE goes to, so a FORGET of leftovers finds them all. */
export const SMOKE_CHANNEL = "ORBITDB-STORAGE-BRIDGE-SMOKE";

export const drivers = [
  {
    name: "memory",
    async setUp() {
      // A resolver turns the memory backend into a pin-by-CID backend, so the
      // pinCid path is exercised by something rather than only declared.
      const published = new Map();
      const backend = createMemoryBackend({
        resolve: async (cid) => published.get(cid) || null,
      });
      return { backend, publish: (cid, bytes) => published.set(cid, bytes) };
    },
    async tearDown() {},
  },
  {
    name: "storacha (in-memory upload-api)",
    async setUp() {
      const service = await startInMemoryStorachaService();
      const backend = await createStorachaBackend({
        storachaKey: service.storachaKey,
        storachaProof: service.storachaProof,
        serviceConf: service.serviceConf,
        receiptsEndpoint: service.receiptsEndpoint,
        gateways: [service.gatewayUrl],
      });
      return { backend, service };
    },
    async tearDown(context) {
      await stopInMemoryStorachaService(context?.service);
    },
  },
  {
    name: "aleph (stub host)",
    async setUp() {
      const stub = await startAlephStub();
      const backend = createAlephBackend({
        ingestUrl: stub.ingestUrl,
        gateways: [stub.gatewayUrl],
        // Stands in for the wallet-signed STORE message. A no-op is faithful
        // rather than lazy: pinning tells Aleph to keep content that is already
        // on IPFS, so what the caller does beforehand — `publish` here — is the
        // part that makes it resolvable. The wallet only says "keep it".
        pin: async () => {},
      });
      return { backend, stub, publish: stub.publish };
    },
    async tearDown(context) {
      await context?.stub?.stop();
    },
  },
  // A real Pinata account: real files and a real bill. It joins the table only
  // when a run opts in twice — a JWT in the environment is not consent to spend
  // on every test run — and everything it stores is deleted again afterwards,
  // because a suite that leaves litter in a paid account gets switched off.
  ...(process.env.PINATA_LIVE === "true" && process.env.PINATA_JWT
    ? [
        {
          name: "pinata (live account)",
          async setUp() {
            const real = createPinataBackend({
              jwt: process.env.PINATA_JWT,
              gateway: process.env.PINATA_GATEWAY || undefined,
            });
            const created = [];
            const backend = {
              ...real,
              putBlob: async (bytes, meta) => {
                const handle = await real.putBlob(bytes, meta);
                created.push(handle);
                return handle;
              },
            };
            // No publish: Pinata pins only what the public IPFS network can
            // serve, and an in-process map is not that. The pin-by-CID path is
            // exercised by pinata-live.test.js with a block put on IPFS first.
            return { backend, real, created, publish: null };
          },
          async tearDown(context) {
            for (const handle of context?.created || []) {
              await context.real.remove(handle).catch(() => {});
            }
          },
        },
      ]
    : []),
  // A real Lighthouse account, on the same terms as Pinata above: opted into
  // twice, and everything it stores deleted again. Lighthouse is paid for once
  // and meant to keep files forever, which is exactly why a test must not.
  ...(process.env.LIGHTHOUSE_LIVE === "true" && process.env.LIGHTHOUSE_API_KEY
    ? [
        {
          name: "lighthouse (live account)",
          async setUp() {
            const real = createLighthouseBackend({
              apiKey: process.env.LIGHTHOUSE_API_KEY,
              gateway: process.env.LIGHTHOUSE_GATEWAY || undefined,
            });
            const created = [];
            const backend = {
              ...real,
              putBlob: async (bytes, meta) => {
                const handle = await real.putBlob(bytes, meta);
                created.push(handle);
                return handle;
              },
            };
            // Lighthouse has no pin-by-CID, so there is nothing to publish to.
            return { backend, real, created, publish: null };
          },
          async tearDown(context) {
            for (const handle of context?.created || []) {
              await context.real.remove(handle).catch((error) => {
                console.log(`   cleanup could not remove ${handle.id}: ${error.message}`);
              });
            }
          },
        },
      ]
    : []),
  // A real Aleph account, signing real STORE messages paid in credits: a few
  // KB each, a day's minimum runtime. Upload and STORE are one call to the API
  // node (the path a pin that signs takes since 0.27.3); a STORE Aleph has not
  // processed fails the test with its error code, and everything is FORGOTTEN
  // again in tearDown.
  ...(process.env.ALEPH_LIVE === "true" && process.env.ALEPH_PRIVATE_KEY
    ? [
        {
          name: "aleph (live account, signed STORE)",
          async setUp() {
            const { address, sign } = createEthSigner(
              process.env.ALEPH_PRIVATE_KEY,
            );
            const pin = createAlephPin({
              sender: address,
              sign,
              channel: SMOKE_CHANNEL,
              ref: "conformance",
            });
            const forget = createAlephForget({
              sender: address,
              sign,
              channel: SMOKE_CHANNEL,
            });
            const real = createAlephBackend({ pin });
            const created = [];
            const backend = {
              ...real,
              putBlob: async (bytes, meta) => {
                const handle = await real.putBlob(bytes, meta);
                if (handle.itemHash) created.push(handle.itemHash);
                if (handle.status !== "processed") {
                  const final = await waitForMessage(handle.itemHash, {
                    timeout: 180_000,
                    interval: 5_000,
                  });
                  if (final.status !== "processed") {
                    throw new Error(
                      `Aleph STORE ${handle.itemHash} for ${handle.id} via /api/v0/ipfs/add_file: ${final.status}` +
                        (final.errorCode != null
                          ? `, error_code ${final.errorCode}`
                          : "") +
                        (final.timedOut ? " after 180 s" : "") +
                        (final.details
                          ? ` — ${JSON.stringify(final.details).slice(0, 300)}`
                          : ""),
                    );
                  }
                  return { ...handle, retained: true, status: "processed" };
                }
                return handle;
              },
            };
            // No publish: pinCid asks Aleph's nodes to fetch from the public
            // network, which an in-process map is not.
            return { backend, real, created, forget, publish: null };
          },
          async tearDown(context) {
            if (!context?.created?.length) return;
            const sent = await context.forget(context.created, "smoke test");
            const final = await waitForMessage(sent.itemHash, {
              timeout: 120_000,
              interval: 5_000,
            });
            console.log(
              `   FORGET ${sent.itemHash} of ${context.created.length} STORE(s): ${final.status}`,
            );
          },
        },
      ]
    : []),
  // A real Storacha space, on the same terms: opted into twice, and every
  // upload removed again.
  ...(process.env.STORACHA_LIVE === "true" &&
  process.env.STORACHA_KEY &&
  process.env.STORACHA_PROOF
    ? [
        {
          name: "storacha (live space)",
          async setUp() {
            const real = await createStorachaBackend({
              storachaKey: process.env.STORACHA_KEY,
              storachaProof: process.env.STORACHA_PROOF,
            });
            const created = [];
            const backend = {
              ...real,
              putBlob: async (bytes, meta) => {
                const handle = await real.putBlob(bytes, meta);
                created.push(handle);
                return handle;
              },
            };
            return { backend, real, created, publish: null };
          },
          async tearDown(context) {
            for (const handle of context?.created || []) {
              await context.real.remove(handle).catch((error) => {
                console.log(`   cleanup could not remove ${handle.id}: ${error.message}`);
              });
            }
          },
        },
      ]
    : []),
];
