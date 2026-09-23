/**
 * @fileoverview A backup that the service holding it cannot read.
 *
 * Offline, and deliberately two kinds of test: a stub cipher for the envelope
 * and the failure paths, and real AES-GCM through WebCrypto for the round
 * trip, because an envelope that only works against a stub proves nothing.
 *
 * The keys are the caller's — this package holds none — so what is asserted
 * here is that the bytes leaving the backend are unreadable, that the bytes
 * coming back are exactly what went in, and that everything which can go wrong
 * says what went wrong.
 */

import { describe, test, expect } from "@jest/globals";
import { webcrypto } from "node:crypto";

import { createMemoryBackend } from "../../lib/backends/memory.js";
import { defineBackend } from "../../lib/backends/types.js";
import {
  withEncryption,
  isEncrypted,
  readEnvelope,
  wrapEnvelope,
  decryptingFetch,
  explainIfEncrypted,
  ENVELOPE_VERSION,
} from "../../lib/backends/encryption.js";

const PLAINTEXT = new TextEncoder().encode("a CAR file would be here, and it is nobody else's business");

/** A stand-in cipher: reversible, obviously not secret, and easy to break on purpose. */
const stubCipher = (marker = 7) => ({
  encrypt: async (bytes) => ({
    ciphertext: Uint8Array.from(bytes, (b) => b ^ marker),
    iv: new Uint8Array([1, 2, 3, 4]),
  }),
  decrypt: async (ciphertext) => Uint8Array.from(ciphertext, (b) => b ^ marker),
});

/** The real thing, as a browser would do it with a key derived from the passkey. */
async function aesCipher(secret = "the security key's own secret") {
  const raw = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const key = await webcrypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return {
    encrypt: async (bytes) => {
      const iv = webcrypto.getRandomValues(new Uint8Array(12));
      const ciphertext = new Uint8Array(
        await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes),
      );
      return { ciphertext, iv };
    },
    decrypt: async (ciphertext, iv) =>
      new Uint8Array(await webcrypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext)),
  };
}

describe("a backup the service cannot read", () => {
  test("what is stored is not what was given, and what comes back is", async () => {
    const store = createMemoryBackend();
    const backend = withEncryption(store, stubCipher());

    const handle = await backend.putBlob(PLAINTEXT);
    const stored = await store.getBlob(handle);
    const back = await backend.getBlob(handle);

    expect(Buffer.from(stored).equals(Buffer.from(PLAINTEXT))).toBe(false);
    expect(isEncrypted(stored)).toBe(true);
    expect(Buffer.from(back).equals(Buffer.from(PLAINTEXT))).toBe(true);
  });

  test("round trip through real AES-GCM", async () => {
    const store = createMemoryBackend();
    const backend = withEncryption(store, await aesCipher());

    const handle = await backend.putBlob(PLAINTEXT);
    const back = await backend.getBlob(handle);

    expect(Buffer.from(back).equals(Buffer.from(PLAINTEXT))).toBe(true);
  });

  test("two backups of the same bytes are different bytes", async () => {
    // A fresh IV each time: no dedup, and nothing to learn from comparing two
    // uploads of a database that did not change.
    const store = createMemoryBackend();
    const backend = withEncryption(store, await aesCipher());

    const first = await store.getBlob(await backend.putBlob(PLAINTEXT));
    const second = await store.getBlob(await backend.putBlob(PLAINTEXT));

    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
  });

  test("the wrong key is refused with the reason, not with an unreadable CAR", async () => {
    const store = createMemoryBackend();
    const written = withEncryption(store, await aesCipher("one key"));
    const read = withEncryption(store, await aesCipher("a different key"));

    const handle = await written.putBlob(PLAINTEXT);

    await expect(read.getBlob(handle)).rejects.toThrow(/different key|derivation/i);
  });
});

describe("bytes that are not ours", () => {
  test("a plaintext backup from before this change still restores", async () => {
    // A pointer does not say which kind it names, and refusing would make
    // yesterday's backups unreadable for no gain in secrecy.
    const store = createMemoryBackend();
    const handle = await store.putBlob(PLAINTEXT);
    const backend = withEncryption(store, stubCipher());

    const back = await backend.getBlob(handle);

    expect(Buffer.from(back).equals(Buffer.from(PLAINTEXT))).toBe(true);
  });

  test("a caller who wants only encrypted reads can say so", async () => {
    const store = createMemoryBackend();
    const handle = await store.putBlob(PLAINTEXT);
    const backend = withEncryption(store, { ...stubCipher(), allowPlaintextReads: false });

    await expect(backend.getBlob(handle)).rejects.toThrow(/not encrypted/i);
  });

  test("a CAR does not look like an envelope", () => {
    // The magic has to be distinguishable from what a CAR and a JSON start
    // with, or a plaintext restore would try to decrypt.
    const car = new Uint8Array([0x3a, 0xa2, 0x65, 0x72, 0x6f, 0x6f, 0x74, 0x73]);
    const json = new TextEncoder().encode('{"manifest":"zdpu…"}');

    expect(isEncrypted(car)).toBe(false);
    expect(isEncrypted(json)).toBe(false);
    expect(isEncrypted(new Uint8Array(2))).toBe(false);
  });
});

describe("the envelope", () => {
  test("carries the IV, since the metadata blob is encrypted too", async () => {
    const iv = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 11, 12]);
    const envelope = wrapEnvelope(new Uint8Array([1, 2, 3]), iv);

    const read = readEnvelope(envelope);

    expect(Buffer.from(read.iv).equals(Buffer.from(iv))).toBe(true);
    expect(Array.from(read.ciphertext)).toEqual([1, 2, 3]);
    expect(read.version).toBe(ENVELOPE_VERSION);
  });

  test("a version this build does not know is refused by name", () => {
    const envelope = wrapEnvelope(new Uint8Array([1]), new Uint8Array([2]));
    envelope[4] = 99;

    expect(() => readEnvelope(envelope)).toThrow(/version 99/);
  });
});

describe("what it tells the rest of the package", () => {
  test("the stored blob is not a CAR and has no inner CIDs", async () => {
    // Wrapping a backend that *does* import CARs and preserve inner CIDs:
    // through encryption it must report neither, or something downstream will
    // hand ciphertext to a CAR reader.
    const store = createMemoryBackend();
    const capable = defineBackend({
      ...store,
      name: "capable",
      capabilities: { ...store.capabilities, carImport: true, preservesInnerCids: true },
    });

    expect(capable.capabilities.carImport).toBe(true);

    const backend = withEncryption(capable, stubCipher());

    expect(backend.capabilities.carImport).toBe(false);
    expect(backend.capabilities.preservesInnerCids).toBe(false);
  });

  test("it refuses to pretend it has keys", () => {
    expect(() => withEncryption(createMemoryBackend(), {})).toThrow(/encrypt and decrypt/);
    expect(() => withEncryption(null, stubCipher())).toThrow(/backend to wrap/);
  });
});

describe("the path a restore actually takes", () => {
  test("decryptingFetch reads what an encrypting backend wrote", async () => {
    // restoreFromCID never touches the backend: it fetches from a gateway or
    // from peers. Without this half, an encrypted backup restores as noise.
    const store = createMemoryBackend();
    const cipher = await aesCipher();
    const backend = withEncryption(store, cipher);
    const handle = await backend.putBlob(PLAINTEXT);

    const fromTheNetwork = async () => store.getBlob(handle); // what a gateway returns
    const fetchBytes = decryptingFetch(fromTheNetwork, cipher);

    const back = await fetchBytes("bafy…");

    expect(Buffer.from(back).equals(Buffer.from(PLAINTEXT))).toBe(true);
  });

  test("a plaintext backup still restores through it", async () => {
    const fetchBytes = decryptingFetch(async () => PLAINTEXT, stubCipher());

    const back = await fetchBytes("bafy…");

    expect(Buffer.from(back).equals(Buffer.from(PLAINTEXT))).toBe(true);
  });

  test("the wrong key names the CID it failed on", async () => {
    const store = createMemoryBackend();
    const handle = await withEncryption(store, await aesCipher("one")).putBlob(PLAINTEXT);
    const fetchBytes = decryptingFetch(async () => store.getBlob(handle), await aesCipher("other"));

    await expect(fetchBytes("bafyTheOne")).rejects.toThrow(/bafyTheOne/);
  });
});

describe("when there is no key at hand", () => {
  test("an encrypted backup says so, instead of failing inside the CAR reader", async () => {
    const store = createMemoryBackend();
    const handle = await withEncryption(store, stubCipher()).putBlob(PLAINTEXT);
    const fetchBytes = explainIfEncrypted(async () => store.getBlob(handle));

    await expect(fetchBytes("bafyEncrypted")).rejects.toThrow(/encrypted.*decrypt/is);
  });

  test("a plaintext backup passes through untouched", async () => {
    const fetchBytes = explainIfEncrypted(async () => PLAINTEXT);

    expect(Buffer.from(await fetchBytes("bafy…")).equals(Buffer.from(PLAINTEXT))).toBe(true);
  });
});
