/**
 * @fileoverview Encrypting what goes to a storage service, and decrypting what
 * comes back.
 *
 * A backup leaves the browser as two opaque blobs — a CAR and a small metadata
 * JSON — and the services that hold them neither need nor should have their
 * contents. This wraps a backend so `putBlob` encrypts and `getBlob` decrypts,
 * and **nothing above it changes**: `dehydrate`, `restoreFromCID`, the mirror,
 * the gateway path and the peer path all move opaque bytes either way.
 *
 * ## The keys are the caller's
 *
 * This package knows nothing about passkeys, and should not: it takes two
 * functions, exactly as `createBackendFromChoice` takes `normaliseAddress`
 * rather than importing viem. A browser consumer derives them from the
 * security key's PRF output — `@le-space/orbitdb-identity-provider-webauthn-did`
 * ships `getPrfOutput`, `encryptWithAESGCM` and `decryptWithAESGCM` — and
 * should derive a **separate** key for this, from the same secret with a
 * different info string, so that a compromised backup key is not a signing key.
 *
 * ## The envelope, and why it is not just ciphertext
 *
 * Bytes on the way back can be one of three things: this envelope, a plaintext
 * CAR from before backups were encrypted, or a plaintext CAR written with
 * `dontEncrypt`. A restore has to tell them apart without being told, because
 * a pointer does not carry that knowledge. So every ciphertext starts with a
 * magic number and a version:
 *
 * ```
 * "OSBE" | version | ivLength | iv | ciphertext
 *   4        1          1       ~12     …
 * ```
 *
 * A CAR begins with a varint length and a dag-cbor header, and JSON with `{`,
 * so neither collides with the magic. The version is there for the day the
 * algorithm changes: a backup from before it can then be refused with a
 * reason rather than decrypted into noise.
 *
 * @module backends/encryption
 */

import { defineBackend, BackendError } from "./types.js";

/** `OSBE` — orbitdb-storage-bridge, encrypted. */
// Not frozen: freezing a typed array throws, because its elements live in a
// buffer the engine will not seal.
export const ENVELOPE_MAGIC = new Uint8Array([0x4f, 0x53, 0x42, 0x45]);

/** Bumped when the envelope or the algorithm changes in a way readers must notice. */
export const ENVELOPE_VERSION = 1;

const HEADER_LENGTH = ENVELOPE_MAGIC.length + 2;

/** Do these bytes start with an envelope this module wrote? */
export function isEncrypted(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < HEADER_LENGTH) return false;
  return ENVELOPE_MAGIC.every((byte, index) => bytes[index] === byte);
}

/**
 * Wrap ciphertext and its IV so a reader can recognise both without being told.
 *
 * @param {Uint8Array} ciphertext
 * @param {Uint8Array} iv
 * @returns {Uint8Array}
 */
export function wrapEnvelope(ciphertext, iv) {
  if (!(ciphertext instanceof Uint8Array) || !(iv instanceof Uint8Array)) {
    throw new BackendError("INVALID_BACKEND", "encrypt must return Uint8Array ciphertext and iv");
  }
  if (iv.length > 255) {
    throw new BackendError("INVALID_BACKEND", `An IV of ${iv.length} bytes does not fit the envelope`);
  }
  const out = new Uint8Array(HEADER_LENGTH + iv.length + ciphertext.length);
  out.set(ENVELOPE_MAGIC, 0);
  out[ENVELOPE_MAGIC.length] = ENVELOPE_VERSION;
  out[ENVELOPE_MAGIC.length + 1] = iv.length;
  out.set(iv, HEADER_LENGTH);
  out.set(ciphertext, HEADER_LENGTH + iv.length);
  return out;
}

/**
 * Read an envelope back, refusing a version this build does not know.
 *
 * @param {Uint8Array} bytes
 * @returns {{ ciphertext: Uint8Array, iv: Uint8Array, version: number }}
 */
export function readEnvelope(bytes) {
  if (!isEncrypted(bytes)) {
    throw new BackendError("INVALID_BACKEND", "These bytes are not an encrypted backup");
  }
  const version = bytes[ENVELOPE_MAGIC.length];
  if (version !== ENVELOPE_VERSION) {
    throw new BackendError(
      "INVALID_BACKEND",
      `This backup was written with envelope version ${version}, and this build reads ${ENVELOPE_VERSION}. ` +
        "Upgrade @le-space/orbitdb-storage-bridge to restore it.",
    );
  }
  const ivLength = bytes[ENVELOPE_MAGIC.length + 1];
  const iv = bytes.subarray(HEADER_LENGTH, HEADER_LENGTH + ivLength);
  const ciphertext = bytes.subarray(HEADER_LENGTH + ivLength);
  return { ciphertext, iv, version };
}

/**
 * Encrypt on the way out, decrypt on the way back.
 *
 * @param {import("./types.js").StorageBackend} backend - the one that stores bytes
 * @param {object} options
 * @param {(plaintext: Uint8Array) => Promise<{ciphertext: Uint8Array, iv: Uint8Array}>} options.encrypt
 * @param {(ciphertext: Uint8Array, iv: Uint8Array) => Promise<Uint8Array>} options.decrypt
 * @param {boolean} [options.allowPlaintextReads=true] - restore a backup written
 *   before backups were encrypted, or written with `dontEncrypt`. On by
 *   default: a pointer does not say which kind it names, and refusing would
 *   make yesterday's backups unreadable for no gain in secrecy.
 * @returns {import("./types.js").StorageBackend}
 */
export function withEncryption(backend, { encrypt, decrypt, allowPlaintextReads = true } = {}) {
  if (!backend || typeof backend.putBlob !== "function") {
    throw new BackendError("INVALID_BACKEND", "withEncryption needs a backend to wrap");
  }
  if (typeof encrypt !== "function" || typeof decrypt !== "function") {
    throw new BackendError(
      "INVALID_BACKEND",
      "withEncryption needs encrypt and decrypt functions — this package holds no keys of its own",
    );
  }

  const inner = backend;

  return defineBackend({
    ...inner,
    name: `encrypted(${inner.name})`,
    capabilities: {
      ...inner.capabilities,
      // The stored bytes are an envelope, not a CAR: nothing downstream may
      // treat them as one, and there are no inner CIDs to preserve.
      carImport: false,
      preservesInnerCids: false,
    },

    async putBlob(bytes, meta) {
      const { ciphertext, iv } = (await encrypt(bytes)) ?? {};
      return inner.putBlob(wrapEnvelope(ciphertext, iv), meta);
    },

    async getBlob(handle) {
      const bytes = await inner.getBlob(handle);
      if (!isEncrypted(bytes)) {
        if (allowPlaintextReads) return bytes;
        throw new BackendError(
          "INVALID_BACKEND",
          "This backup is not encrypted, and allowPlaintextReads is off",
        );
      }
      const { ciphertext, iv } = readEnvelope(bytes);
      try {
        return await decrypt(ciphertext, iv);
      } catch (error) {
        // The common cause by far is the wrong key — a different security key,
        // or a key derived with a different info string. Say that, rather than
        // letting an unreadable CAR surface three layers down.
        throw new BackendError(
          "INVALID_BACKEND",
          `Could not decrypt this backup: ${error.message}. ` +
            "It was written with a different key, or by a different derivation.",
          { cause: error },
        );
      }
    },
  });
}

/**
 * Decrypt on the way back, for the path a restore actually takes.
 *
 * `restoreFromCID` does not read through a backend: it takes `fetchBytes(cid)`
 * and gets the bytes from a gateway or from peers, so `withEncryption`'s
 * `getBlob` never runs during a restore. This is the other half — wrap the
 * fetcher, and a backup written through an encrypting backend comes back
 * readable however it was fetched.
 *
 * @param {(cid: string, options?: object) => Promise<Uint8Array>} fetchBytes
 * @param {object} options
 * @param {(ciphertext: Uint8Array, iv: Uint8Array) => Promise<Uint8Array>} options.decrypt
 * @param {boolean} [options.allowPlaintextReads=true]
 * @returns {(cid: string, options?: object) => Promise<Uint8Array>}
 */
export function decryptingFetch(fetchBytes, { decrypt, allowPlaintextReads = true } = {}) {
  if (typeof fetchBytes !== "function") {
    throw new BackendError("INVALID_BACKEND", "decryptingFetch needs a fetcher to wrap");
  }
  if (typeof decrypt !== "function") {
    throw new BackendError("INVALID_BACKEND", "decryptingFetch needs a decrypt function");
  }

  return async function fetchAndDecrypt(cid, options) {
    const bytes = await fetchBytes(cid, options);
    if (!isEncrypted(bytes)) {
      if (allowPlaintextReads) return bytes;
      throw new BackendError(
        "INVALID_BACKEND",
        `The backup at ${cid} is not encrypted, and allowPlaintextReads is off`,
      );
    }
    const { ciphertext, iv } = readEnvelope(bytes);
    try {
      return await decrypt(ciphertext, iv);
    } catch (error) {
      throw new BackendError(
        "INVALID_BACKEND",
        `Could not decrypt the backup at ${cid}: ${error.message}. ` +
          "It was written with a different key, or by a different derivation.",
        { cause: error },
      );
    }
  };
}

/**
 * Recognise an encrypted backup when there is no key to open it.
 *
 * Without this, a restore of an encrypted backup without `decrypt` fails deep
 * inside the CAR reader — "unexpected end of data", or a block that will not
 * verify — and the reason has nothing to do with what actually happened.
 *
 * @param {(cid: string, options?: object) => Promise<Uint8Array>} fetchBytes
 * @returns {(cid: string, options?: object) => Promise<Uint8Array>}
 */
export function explainIfEncrypted(fetchBytes) {
  return async function fetchAndCheck(cid, options) {
    const bytes = await fetchBytes(cid, options);
    if (isEncrypted(bytes)) {
      throw new BackendError(
        "INVALID_BACKEND",
        `The backup at ${cid} is encrypted, and no way to decrypt it was given. ` +
          "Pass `decrypt` to hydrate() — a browser derives it from the security key.",
      );
    }
    return bytes;
  };
}

export default withEncryption;
