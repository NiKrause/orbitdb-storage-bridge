/**
 * The Storacha client, loaded when first needed and never at import time.
 *
 * `@storacha/client` is an optional peer dependency since 0.22.0. A static
 * `import` of it anywhere under lib/ would break a consumer's bundle: Vite and
 * Rollup follow dynamic imports into chunks and resolve their named imports at
 * build time, so even a driver that is only ever `import()`ed — `resolve.js`
 * reaches `backends/storacha.js` that way — fails the build of an application
 * that never chose Storacha. So the client is imported here, dynamically, and
 * nowhere else; without the package the Storacha paths fail at the call, with
 * a message that names it. test/no-static-storacha-import.test.js keeps it so.
 *
 * @returns {Promise<{ Client: typeof import("@storacha/client"), StoreMemory: Function, Signer: { parse: Function }, Proof: { parse: Function } }>}
 */
export async function loadStorachaClient() {
  try {
    const [Client, { StoreMemory }, { Signer }, Proof] = await Promise.all([
      import("@storacha/client"),
      import("@storacha/client/stores/memory"),
      import("@storacha/client/principal/ed25519"),
      import("@storacha/client/proof"),
    ]);
    return { Client, StoreMemory, Signer, Proof };
  } catch (error) {
    if (
      error?.code === "ERR_MODULE_NOT_FOUND" ||
      error?.code === "MODULE_NOT_FOUND"
    ) {
      throw new Error(
        "The Storacha backend needs @storacha/client, an optional peer dependency since 0.22.0: npm install @storacha/client",
        { cause: error },
      );
    }
    throw error;
  }
}
