/**
 * One decision about where a backup goes: a ready backend is used as-is, and
 * credentials or a UCAN client build a Storacha one.
 *
 * Its own module, and the Storacha backend is loaded only when it is actually
 * built, because that module pulls `@storacha/client` — about 88 kB gzipped in
 * a browser bundle. A page that backs up to Aleph should not carry a client
 * for a service it never calls.
 */

import { logger } from "../logger.js";

/**
 * Resolve the storage backend for a call.
 *
 * Six copies of this decision used to sit inline in this file and in backup-car.js,
 * which is how a vendor ends up welded to a library. Now there is one: pass a ready
 * backend and it is used as-is, pass a UCAN client or credentials and a Storacha
 * backend is built around them.
 *
 * @param {Object} [config] - call options
 * @param {Object} [config.backend] - any driver implementing the backend contract
 * @param {string|string[]} [config.kind] - a backend by name, or several for a
 *   mirror, with the credentials each needs. What a page has, since a reader
 *   ticks a service and pastes a key rather than handing over a driver.
 * @param {Object} [config.ucanClient] - a Storacha client authorised over UCAN
 * @param {string} [config.spaceDID]
 * @param {string} [config.storachaKey] - falls back to STORACHA_KEY
 * @param {string} [config.storachaProof] - falls back to STORACHA_PROOF
 * @param {Object} [config.serviceConf]
 * @param {string|URL} [config.receiptsEndpoint]
 * @param {string[]} [config.gateways] - retrieval gateways for the Storacha backend
 * @returns {Promise<import("./backends/types.js").StorageBackend>}
 * @see {@link ./backends/types.js} for the contract
 */
export async function resolveBackend(config = {}) {
  if (config.backend) {
    return config.backend;
  }

  // A name and a key: loaded here so that one decision stays one decision, and
  // lazily so a caller that never names a vendor never bundles one.
  if (config.kind) {
    const { createBackendFromChoice } = await import("./choose.js");
    return createBackendFromChoice(config);
  }

  const gateways = config.gateways;

  if (config.ucanClient) {
    logger.info("🔐 Using UCAN authentication...");
    const { createStorachaBackend } = await import("./storacha.js");
    return createStorachaBackend({
      client: config.ucanClient,
      spaceDID: config.spaceDID,
      ...(gateways ? { gateways } : {}),
    });
  }

  const storachaKey =
    config.storachaKey ||
    (typeof process !== "undefined" ? process.env?.STORACHA_KEY : undefined);
  const storachaProof =
    config.storachaProof ||
    (typeof process !== "undefined" ? process.env?.STORACHA_PROOF : undefined);

  if (!storachaKey || !storachaProof) {
    throw new Error(
      "Storacha authentication required: pass storachaKey + storachaProof OR ucanClient in options",
    );
  }

  logger.info("🔑 Using credential authentication...");
  const { createStorachaBackend } = await import("./storacha.js");
  return createStorachaBackend({
    storachaKey,
    storachaProof,
    serviceConf: config.serviceConf,
    receiptsEndpoint: config.receiptsEndpoint,
    ...(gateways ? { gateways } : {}),
  });
}
