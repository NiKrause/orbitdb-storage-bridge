// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// The version of the package this demo is for, not of the demo.
const bridgePkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));

export default defineConfig({
  define: {
    __BUILD_INFO__: JSON.stringify({
      version: `orbitdb-storage-bridge ${bridgePkg.version}`,
      commit: (process.env.GITHUB_SHA ?? "local").slice(0, 7),
      builtAt: `${new Date().toISOString().slice(0, 16)}Z`,
    }),
  },
  base: process.env.PAGES_BASE ?? "/",
  // @orbitdb/core reaches for node's `events`; the bridge's CAR handling for
  // `buffer`. No Meshtastic here — this page never touches a radio.
  plugins: [
    svelte(),
    nodePolyfills({ include: ["events", "buffer", "process", "util"] }),
  ],
  server: { port: 5178 },
  resolve: {
    // The bridge is linked from the repository root (`file:../../../`), so its
    // files resolve imports from the root, where the polyfill plugin is not
    // installed — and the plugin adds shim imports to them too. Resolve it
    // from this example instead. simple-backup-restore needs the same line,
    // and records that marking the shims external builds but leaves the page
    // blank, because the browser cannot resolve them either.
    dedupe: ["vite-plugin-node-polyfills"],
  },
});
