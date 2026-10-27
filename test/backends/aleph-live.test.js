/**
 * @fileoverview The Aleph driver against the real host. Opt-in.
 *
 * `ALEPH_LIVE=true npm test -- test/backends/aleph-live.test.js`
 *
 * The stub in the conformance table proves the contract; this proves the
 * *assumptions the stub was built on*, which is a different question and the
 * one that goes stale. Every claim in `lib/backends/aleph.js` about what the
 * live host does came from probing it by hand on 2026-09-09, and a hand probe
 * is a fact with no expiry date attached. This is that probe, made repeatable.
 *
 * Not in CI on purpose: it writes into public infrastructure that costs
 * somebody else something, and it would fail for anyone working offline. Run
 * it when the driver changes, or when Aleph does.
 */

import { jest, describe, test, expect } from "@jest/globals";
import { IPFSAccessController } from "@orbitdb/core";
import {
  createAlephBackend,
  ALEPH_GATEWAYS,
} from "../../lib/backends/aleph.js";
import { backupDatabase } from "../../lib/orbitdb-storacha-bridge.js";
import { restoreFromCID } from "../../lib/restore-cid.js";
import {
  createHeliaOrbitDB,
  cleanupOrbitDBDirectories,
} from "../../lib/utils.js";

jest.setTimeout(180_000);

const live = process.env.ALEPH_LIVE === "true";
const maybe = live ? describe : describe.skip;

if (!live) {
  console.log(
    "⏭️  Skipping the live Aleph check — set ALEPH_LIVE=true to run it",
  );
}

maybe("the real Aleph host, as the driver assumes it", () => {
  test("a CAR-shaped binary blob survives byte for byte, with no key at any point", async () => {
    const backend = createAlephBackend();

    // Random bytes, so nothing can succeed by returning something plausible.
    const bytes = new Uint8Array(4096);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) % 256;

    const handle = await backend.putBlob(bytes, {
      name: "conformance.car",
      contentType: "application/vnd.ipld.car",
    });

    // The claim the driver's design rests on: the id is Aleph's, not ours.
    expect(handle.id).toBeTruthy();
    expect(handle.cid).toBeUndefined();
    expect(handle.retained).toBe(false); // ingest without a wallet keeps nothing

    const back = await backend.getBlob(handle);
    expect(Buffer.from(back).equals(Buffer.from(bytes))).toBe(true);
  });

  // Measured 2026-10-27: the IPFS hosts answer `/api/v0/add` with 404, and the
  // API node takes the file and gives the CID `unixfsCid` computed beforehand.
  test("the API node takes an unsigned file up to 25 MiB, and its CID is the one computed here", async () => {
    const { unixfsCid } = await import("../../lib/backends/aleph-upload.js");
    const backend = createAlephBackend({ ingestUrl: null });
    const bytes = new Uint8Array(600_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + 3) % 256;
    const handle = await backend.putBlob(bytes, { name: "live-api.bin" });
    expect(handle.id).toBe(await unixfsCid(bytes));
    expect(handle.retained).toBe(false);
    const back = await backend.getBlob(handle);
    expect(Buffer.from(back).equals(Buffer.from(bytes))).toBe(true);
  });

  test("an empty blob is a blob here too", async () => {
    const backend = createAlephBackend();
    const handle = await backend.putBlob(new Uint8Array(0));
    const back = await backend.getBlob(handle);
    expect(back.length).toBe(0);
  });

  test("without a wallet it declares no pinning, rather than pretending", async () => {
    const backend = createAlephBackend();
    expect(backend.capabilities.pinByCid).toBe(false);
    expect(backend.pinCid).toBeUndefined();
  });

  // The chain P9 and P11 stand on, end to end: a database goes up to Aleph as
  // a CAR with no key, and a node that has never seen it gets it back from its
  // metadata CID over plain HTTPS — no Aleph client, no account, no libp2p —
  // with every block checked against its own CID on the way in.
  test("a database backed up to Aleph comes back into a fresh node from its metadata CID alone", async () => {
    const OFFLINE = { useBootstrap: false, useDHT: false, autoDial: false };
    const source = await createHeliaOrbitDB("-aleph-live-source", OFFLINE);
    const target = await createHeliaOrbitDB("-aleph-live-target", OFFLINE);
    try {
      const db = await source.orbitdb.open(`aleph-live-${Date.now()}`, {
        type: "keyvalue",
        AccessController: IPFSAccessController({ write: ["*"] }),
      });
      await db.put("milk", { text: "Milch kaufen", done: false });
      await db.put("bread", { text: "Brot", done: true });
      await db.put("milk", { text: "Hafermilch kaufen", done: false });

      const backup = await backupDatabase(source.orbitdb, db.address, {
        backend: createAlephBackend(),
      });
      expect(backup.error).toBeUndefined();
      expect(backup.method).toBe("car-timestamped");
      const { metadataCID } = backup.backupFiles;

      const restored = await restoreFromCID(target.orbitdb, {
        metadataCID,
        gateways: ALEPH_GATEWAYS,
      });
      expect(restored.address).toBe(db.address);
      expect(await restored.database.get("milk")).toEqual({
        text: "Hafermilch kaufen",
        done: false,
      });
      expect(await restored.database.get("bread")).toEqual({
        text: "Brot",
        done: true,
      });
      // Three writes, three entries: the history came back, not only the state.
      expect((await restored.database.log.values()).length).toBe(3);

      await restored.database.close();
      await db.close();
    } finally {
      for (const node of [source, target]) {
        await node?.orbitdb?.stop?.();
        await node?.helia?.stop?.();
      }
      await cleanupOrbitDBDirectories();
    }
  });
});
