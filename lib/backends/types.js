/**
 * @fileoverview Storage backend contract for OrbitDB Storage Bridge
 *
 * The backend is the volatile part of this library: Storacha switched off writes on
 * 2026-05-15 and its endpoints were gone by September, while every line of block
 * extraction, CID bridging and CAR packing around it kept working. This module is the
 * seam that admission of that fact requires — one contract, several drivers, no single
 * service that can take the library with it.
 *
 * Backends differ in who computes the CID, and the contract has to admit all three shapes:
 *
 *   - **pin-by-CID** — we publish through Helia and the service fetches what is already
 *     ours, so hashes cannot drift. `pinCid()`, declared by `capabilities.pinByCid`.
 *   - **blob push** — we push a CAR and get an opaque handle back. `putBlob()`.
 *   - **file push** — the service hashes what we send. Only safe when what we send is a
 *     CAR, which turns it back into the case above.
 *
 * Capabilities are declared rather than discovered, so the bridge can pick a strategy and
 * the conformance suite can skip what a driver never claimed to do.
 *
 * @author @NiKrause
 * @see {@link ../../docs/STORAGE-BACKENDS.md} for the evaluation behind these distinctions
 */

/**
 * @typedef {object} BackendCapabilities
 * @property {boolean} pinByCid - `pinCid()` is implemented: content is fetched from IPFS by CID
 * @property {boolean} carImport - CAR files are unpacked by the service and the inner blocks indexed
 * @property {boolean} preservesInnerCids - stored bytes come back under the CID we computed
 * @property {boolean} browserSafeAuth - no shared secret has to reach the browser
 * @property {boolean} delegation - access can be handed on, scoped and time-bounded
 * @property {boolean} listing - `list()` is implemented
 * @property {boolean} deletion - `remove()` by handle is implemented. A service whose
 *   release is a signed message (Aleph's FORGET) says false here and documents the message
 *   elsewhere
 * @property {number} minBlobSize - smallest accepted upload in bytes; 0 when there is no minimum
 */

/**
 * @typedef {object} BackendHandle
 * @property {string} id - what this backend needs to get the bytes back
 * @property {string} backend - the `name` of the backend that issued it
 * @property {string} [cid] - set when the id is, or carries, a content identifier
 * @property {number} [size] - stored size in bytes, when the backend reports one
 * @property {boolean} [retained] - whether the service keeps it: a backend whose upload is
 *   only ingest (Aleph) says false until `pinCid` has made it stick; absent means stored is kept
 * @property {string} [status] - the service's own word for where a pin stands (Aleph: `processed`, `pending`, `rejected`)
 * @property {string} [itemHash] - the message that keeps it (Aleph), to follow with `waitForMessage`
 */

/**
 * @typedef {object} StorageBackend
 * @property {string} name
 * @property {BackendCapabilities} capabilities
 * @property {(bytes: Uint8Array, meta?: object) => Promise<BackendHandle>} putBlob
 * @property {(handle: BackendHandle|string, options?: { onProgress?: (received: number, total: number) => void }) => Promise<Uint8Array>} getBlob
 *   `onProgress`: as the bytes arrive, where the driver can tell (the Aleph
 *   driver can; others may ignore it)
 * @property {((cid: string, meta?: object) => Promise<BackendHandle>)} [pinCid]
 * @property {((options?: object) => Promise<BackendHandle[]>)} [list]
 * @property {((handle: BackendHandle|string) => Promise<void>)} [remove]
 * @property {(() => Promise<void>)} [close]
 */

/** Capability defaults. A driver states what it can do; anything unstated is a no. */
export const DEFAULT_CAPABILITIES = Object.freeze({
  pinByCid: false,
  carImport: false,
  preservesInnerCids: false,
  browserSafeAuth: false,
  delegation: false,
  listing: false,
  deletion: false,
  minBlobSize: 0,
});

/** Methods every driver must provide. */
export const REQUIRED_METHODS = Object.freeze(["putBlob", "getBlob"]);

/** Optional methods, and the capability flag that must agree with each. */
export const OPTIONAL_METHODS = Object.freeze({
  pinCid: "pinByCid",
  list: "listing",
  remove: "deletion",
});

/**
 * Error raised by the contract itself, so a caller can tell "this backend cannot"
 * from "this backend failed".
 */
export class BackendError extends Error {
  /**
   * @param {string} code - UNSUPPORTED, TOO_SMALL, NOT_FOUND or INVALID_BACKEND
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "BackendError";
    this.code = code;
  }
}

/**
 * Normalise a handle, so drivers can accept either the object they issued or a bare id.
 *
 * @param {BackendHandle|string} handle
 * @returns {string}
 */
export function handleId(handle) {
  const id = typeof handle === "string" ? handle : handle?.id;
  if (!id) {
    throw new BackendError("NOT_FOUND", "A backend handle or id is required");
  }
  return id;
}

/**
 * Validate a driver against the contract and return it hardened.
 *
 * The wrapper is thin on purpose — it fills in capability defaults, rejects a driver
 * whose methods and flags disagree, and enforces `minBlobSize` before the bytes leave
 * the process. That last one matters: Filecoin Onchain Cloud rejects anything under
 * 127 bytes, and an OrbitDB block is routinely smaller, so this turns a vendor error
 * arriving mid-backup into a contract error raised on the first block.
 *
 * @param {StorageBackend} backend
 * @returns {StorageBackend}
 */
export function defineBackend(backend) {
  if (!backend || typeof backend.name !== "string" || !backend.name) {
    throw new BackendError("INVALID_BACKEND", "A backend needs a name");
  }

  for (const method of REQUIRED_METHODS) {
    if (typeof backend[method] !== "function") {
      throw new BackendError(
        "INVALID_BACKEND",
        `Backend "${backend.name}" is missing ${method}()`,
      );
    }
  }

  const capabilities = Object.freeze({
    ...DEFAULT_CAPABILITIES,
    ...(backend.capabilities || {}),
  });

  for (const [method, flag] of Object.entries(OPTIONAL_METHODS)) {
    const implemented = typeof backend[method] === "function";
    if (implemented !== Boolean(capabilities[flag])) {
      throw new BackendError(
        "INVALID_BACKEND",
        `Backend "${backend.name}" declares ${flag}=${capabilities[flag]} but ` +
          `${implemented ? "implements" : "does not implement"} ${method}()`,
      );
    }
  }

  const putBlob = backend.putBlob.bind(backend);

  return Object.freeze({
    ...backend,
    capabilities,
    putBlob: async (bytes, meta) => {
      if (!(bytes instanceof Uint8Array)) {
        throw new BackendError(
          "INVALID_BACKEND",
          "putBlob expects a Uint8Array",
        );
      }
      if (bytes.length < capabilities.minBlobSize) {
        throw new BackendError(
          "TOO_SMALL",
          `Backend "${backend.name}" needs at least ${capabilities.minBlobSize} bytes, got ${bytes.length}. ` +
            "Pack blocks into a CAR before uploading.",
        );
      }
      return putBlob(bytes, meta);
    },
  });
}

/**
 * Raise a consistent error for something a driver deliberately does not do.
 *
 * @param {string} name - backend name
 * @param {string} operation
 * @returns {never}
 */
export function unsupported(name, operation) {
  throw new BackendError(
    "UNSUPPORTED",
    `Backend "${name}" does not support ${operation}`,
  );
}
