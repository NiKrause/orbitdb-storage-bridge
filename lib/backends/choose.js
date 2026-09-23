/**
 * @fileoverview One backend from a plain choice — a name and, where a service
 * needs one, a key.
 *
 * `resolveBackend` understands a ready backend or Storacha credentials, which is
 * what a Node caller has. A page has something smaller and less trusting: a
 * reader ticked *Lighthouse* and pasted their own key, and nothing else is
 * known. This turns that into a driver.
 *
 * ## Every vendor module is imported lazily, and that is the point
 *
 * A page that chose Aleph must not ship the Pinata and Lighthouse drivers, and
 * a page that chose none of them must ship no vendor code at all. Each branch
 * therefore `import()`s exactly what it builds — the same reason
 * `resolveBackend` loads Storacha only when it builds one, where the module
 * costs about 88 kB gzipped.
 *
 * ## Several choices are a mirror, not a loop in the caller
 *
 * `kind: ["aleph", "lighthouse"]` builds both and returns
 * {@link ../backends/mirror.js createMirrorBackend} over them, so the caller's
 * code is the same whether one service was ticked or three.
 *
 * ## A gateway belongs to the service it came from
 *
 * Since the public path gateways were retired (#111), the gateway a reader can
 * actually use is usually their own account's — `<name>.mypinata.cloud`,
 * `<name>.lighthouseweb3.xyz` — and those are not interchangeable: Pinata's
 * answers 401 for a Lighthouse CID, Lighthouse's answers 402. So `gateway` is
 * a string only while one service is chosen, and an object keyed by service
 * once several are. Handing one string to three drivers is refused rather than
 * half-working.
 *
 * ## What it refuses
 *
 * A key that is missing is refused here, with the name of the service in the
 * message, rather than at the first upload — a page can then keep the button
 * disabled and say why. Nothing in this module reads an environment variable on
 * a page's behalf: in a browser there is no environment, and a driver that
 * silently finds a key somewhere else is a driver nobody can reason about. The
 * per-driver fallbacks to `process.env` stay where they are, for Node.
 *
 * @author @NiKrause
 * @requires ./types.js - the contract every branch returns
 */

import { BackendError } from "./types.js";

/**
 * Aleph's driver tries a list of `…/ipfs` prefixes, while a reader types a
 * host. Accept either, and a bare domain as https, like the other drivers do.
 */
const alephGateway = (value) => {
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const trimmed = withScheme.replace(/\/+$/, "");
  return trimmed.endsWith("/ipfs") ? trimmed : `${trimmed}/ipfs`;
};

/** The names a caller may ask for. */
export const BACKEND_KINDS = Object.freeze([
  "aleph",
  "pinata",
  "lighthouse",
  "storacha",
  "memory",
]);

/**
 * Build a backend from a choice.
 *
 * @param {object} choice
 * @param {string|string[]} choice.kind - one name, or several for a mirror
 * @param {string} [choice.jwt] - Pinata
 * @param {() => Promise<string>} [choice.getUploadUrl] - Pinata, without a secret in the page
 * @param {string} [choice.apiKey] - Lighthouse
 * @param {"shared"|"user"} [choice.keyOwnership] - Lighthouse: whose key it is,
 *   which is what decides `browserSafeAuth`
 * @param {string|Record<string, string>} [choice.gateway] - retrieval gateway:
 *   a string for a single kind, or `{ pinata: "…", lighthouse: "…" }` for several.
 *   A bare domain is read as https, as each driver already accepts
 * @param {string[]} [choice.gateways] - retrieval gateways, tried in order; wins
 *   over `gateway` where a driver takes a list
 * @param {object} [choice.options] - passed through to the driver, for anything
 *   this signature does not name
 * @param {"one"|"all"} [choice.require] - for several kinds: how many must accept a write
 * @returns {Promise<import("./types.js").StorageBackend>}
 */
export async function createBackendFromChoice(choice = {}) {
  const kinds = Array.isArray(choice.kind) ? choice.kind : [choice.kind];
  const wanted = kinds.filter(Boolean);

  if (wanted.length === 0) {
    throw new BackendError(
      "INVALID_BACKEND",
      `Pick a backend: ${BACKEND_KINDS.join(", ")}`,
    );
  }
  for (const kind of wanted) {
    if (!BACKEND_KINDS.includes(kind)) {
      throw new BackendError(
        "INVALID_BACKEND",
        `Unknown backend "${kind}" — pick one of ${BACKEND_KINDS.join(", ")}`,
      );
    }
  }

  if (wanted.length > 1 && typeof choice.gateway === "string") {
    throw new BackendError(
      "INVALID_BACKEND",
      `A gateway belongs to one service — with several kinds pass an object: ` +
        `{ gateway: { ${wanted.map((k) => `${k}: "…"`).join(", ")} } }`,
    );
  }

  if (wanted.length > 1) {
    const backends = [];
    for (const kind of wanted) {
      backends.push(await createBackendFromChoice({ ...choice, kind }));
    }
    const { createMirrorBackend } = await import("./mirror.js");
    return createMirrorBackend(backends, { require: choice.require ?? "one" });
  }

  const [kind] = wanted;
  const extra = choice.options ?? {};
  const gateway =
    typeof choice.gateway === "string" ? choice.gateway : choice.gateway?.[kind];
  const gateways = choice.gateways ? { gateways: choice.gateways } : {};
  // Pinata and Lighthouse take one gateway; Aleph takes the list it tries in
  // order, so a single choice becomes a list of one.
  const oneGateway = gateway ? { gateway } : {};

  if (kind === "aleph") {
    const { createAlephBackend } = await import("./aleph.js");
    const fromOne =
      gateway && !choice.gateways ? { gateways: [alephGateway(gateway)] } : {};
    return createAlephBackend({ ...gateways, ...fromOne, ...extra });
  }

  if (kind === "pinata") {
    if (
      !choice.jwt &&
      !choice.getUploadUrl &&
      !extra.jwt &&
      !extra.getUploadUrl
    ) {
      throw new BackendError(
        "INVALID_BACKEND",
        "Pinata needs a JWT, or a getUploadUrl function that mints a presigned URL",
      );
    }
    const { createPinataBackend } = await import("./pinata.js");
    return createPinataBackend({
      ...(choice.jwt ? { jwt: choice.jwt } : {}),
      ...(choice.getUploadUrl ? { getUploadUrl: choice.getUploadUrl } : {}),
      ...oneGateway,
      ...gateways,
      ...extra,
    });
  }

  if (kind === "lighthouse") {
    if (!choice.apiKey && !extra.apiKey) {
      throw new BackendError("INVALID_BACKEND", "Lighthouse needs an apiKey");
    }
    const { createLighthouseBackend } = await import("./lighthouse.js");
    return createLighthouseBackend({
      ...(choice.apiKey ? { apiKey: choice.apiKey } : {}),
      // Whose key it is decides browserSafeAuth, and a page should say which it got.
      keyOwnership: choice.keyOwnership ?? "shared",
      ...oneGateway,
      ...gateways,
      ...extra,
    });
  }

  if (kind === "memory") {
    const { createMemoryBackend } = await import("./memory.js");
    return createMemoryBackend(extra);
  }

  const { resolveBackend } = await import("./resolve.js");
  return resolveBackend({ ...choice, ...extra, kind: undefined });
}

export default createBackendFromChoice;
