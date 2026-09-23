/**
 * @fileoverview Storacha storage backend for OrbitDB Storage Bridge
 *
 * The original backend, behind the contract the others will implement. It is kept for
 * three reasons even though the public service is gone: the in-memory upload-api in
 * `test/helpers/in-memory-storacha.js` still speaks this protocol, anyone holding
 * credentials against a self-hosted w3up deployment can still use it, and it is the
 * reference for what a UCAN-delegated backend looked like when one existed.
 *
 * Retrieval defaults to a gateway belonging to nobody in this story: `storacha.link`
 * and `w3s.link` answer 301 to `dweb.link`, which Protocol Labs retired on 2026-09-21
 * along with `ipfs.io`. A caller passes its own list — which is what the in-memory
 * service does.
 *
 * @author @NiKrause
 * @requires ./types.js - the backend contract
 * @see {@link ../../docs/STORAGE-BACKENDS.md} for what replaced it
 */

import * as Client from "@storacha/client";
import { StoreMemory } from "@storacha/client/stores/memory";
import { Signer } from "@storacha/client/principal/ed25519";
import * as Proof from "@storacha/client/proof";
import { CID } from "multiformats/cid";
import { defineBackend, handleId, BackendError } from "./types.js";

/**
 * Gateways tried in order by `getBlob()`, unless the caller supplies its own.
 *
 * Storacha's own hosts redirected here, and here was retired on 2026-09-21
 * together with `ipfs.io`. What is left is a gateway belonging to a different
 * service, which will serve a Storacha CID only while somebody still provides
 * those blocks to the network.
 */
export const DEFAULT_GATEWAYS = Object.freeze(["https://ipfs.aleph.cloud"]);

/**
 * Build a Storacha client from key and proof, or adopt one that already exists.
 *
 * @param {object} options
 * @param {string} [options.storachaKey]
 * @param {string} [options.storachaProof]
 * @param {object} [options.client] - a pre-built client, e.g. one authorised over UCAN
 * @param {string} [options.spaceDID] - space to select on a pre-built client
 * @param {object} [options.serviceConf]
 * @param {string|URL} [options.receiptsEndpoint]
 * @returns {Promise<object>}
 */
async function resolveClient(options) {
  if (options.client) {
    if (options.spaceDID) {
      await options.client.setCurrentSpace(options.spaceDID);
    }
    return options.client;
  }

  if (!options.storachaKey || !options.storachaProof) {
    throw new BackendError(
      "INVALID_BACKEND",
      "createStorachaBackend needs either a client or storachaKey + storachaProof",
    );
  }

  const clientOptions = {
    principal: Signer.parse(options.storachaKey),
    store: new StoreMemory(),
  };
  if (options.serviceConf) {
    clientOptions.serviceConf = options.serviceConf;
  }
  if (options.receiptsEndpoint) {
    clientOptions.receiptsEndpoint = options.receiptsEndpoint;
  }

  const client = await Client.create(clientOptions);
  const space = await client.addSpace(await Proof.parse(options.storachaProof));
  await client.setCurrentSpace(space.did());
  return client;
}

/**
 * Create a Storacha backend.
 *
 * @param {object} options - see {@link resolveClient}, plus:
 * @param {string[]} [options.gateways] - retrieval gateways, tried in order
 * @returns {Promise<import("./types.js").StorageBackend>}
 */
export async function createStorachaBackend(options = {}) {
  const client = await resolveClient(options);
  const gateways = (options.gateways || DEFAULT_GATEWAYS).map((gateway) =>
    String(gateway).replace(/\/+$/, ""),
  );

  return defineBackend({
    name: "storacha",

    capabilities: {
      pinByCid: false,
      carImport: false,
      // the client hashes locally and the service stores exactly those bytes —
      // the property this library was built on
      preservesInnerCids: true,
      browserSafeAuth: true,
      delegation: true,
      listing: true,
      deletion: true,
      minBlobSize: 0,
    },

    /** @type {import("./types.js").StorageBackend["putBlob"]} */
    putBlob: async (bytes, meta = {}) => {
      const name = meta.name || "blob";
      const file = new File([bytes], name, {
        type: meta.type || "application/octet-stream",
      });
      const cid = (await client.uploadFile(file)).toString();
      return {
        id: cid,
        cid,
        backend: "storacha",
        size: bytes.length,
        ...(meta.name ? { name } : {}),
      };
    },

    /** @type {import("./types.js").StorageBackend["getBlob"]} */
    getBlob: async (handle) => {
      const id = handleId(handle);
      const failures = [];

      for (const gateway of gateways) {
        try {
          const response = await fetch(`${gateway}/ipfs/${id}`);
          if (!response.ok) {
            failures.push(`${gateway}: HTTP ${response.status}`);
            continue;
          }
          return new Uint8Array(await response.arrayBuffer());
        } catch (error) {
          failures.push(`${gateway}: ${error?.message ?? error}`);
        }
      }

      throw new BackendError(
        "NOT_FOUND",
        `No gateway served ${id} (${failures.join("; ")})`,
      );
    },

    /** @type {import("./types.js").StorageBackend["list"]} */
    list: async (listOptions = {}) => {
      const query = {};
      if (listOptions.size) query.size = listOptions.size;
      if (listOptions.cursor) query.cursor = listOptions.cursor;

      const result = await client.capability.upload.list(query);
      return result.results.map((upload) => ({
        id: upload.root.toString(),
        cid: upload.root.toString(),
        backend: "storacha",
        size:
          upload.shards?.reduce(
            (total, shard) => total + (shard.size || 0),
            0,
          ) || undefined,
        insertedAt: upload.insertedAt,
        updatedAt: upload.updatedAt,
        // Escape hatch: the vendor record, for callers that have not generalised yet.
        raw: upload,
      }));
    },

    /** @type {import("./types.js").StorageBackend["remove"]} */
    remove: async (handle) => {
      await client.capability.upload.remove(CID.parse(handleId(handle)));
    },

    /** The underlying client, for the space and UCAN handling that does not generalise. */
    client,
  });
}

export default createStorachaBackend;
