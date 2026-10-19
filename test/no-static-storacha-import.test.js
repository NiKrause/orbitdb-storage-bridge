/**
 * @fileoverview No file under lib/ imports `@storacha/client` statically.
 *
 * The package is an optional peer since 0.22.0. Vite and Rollup follow
 * dynamic imports into chunks and resolve their named imports at build time,
 * so one static `import { Signer } from "@storacha/client/..."` anywhere
 * reachable — even in a driver only ever `import()`ed, as resolve.js does
 * with backends/storacha.js — fails the build of an application that never
 * chose Storacha (found by Le-Space/belege on 0.22.0). lib/storacha-client.js
 * is the one place that imports it, dynamically. lib/ucan-bridge.js is
 * Storacha-era, exported nowhere and imported by nothing under lib/; it may
 * keep its static imports until it goes.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const LIB = new URL("../lib/", import.meta.url).pathname;
const ALLOWED = new Set(["ucan-bridge.js"]);

function* files(dir, prefix = "") {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full, `${prefix}${name}/`);
    else if (name.endsWith(".js")) yield [`${prefix}${name}`, full];
  }
}

describe("optional peer @storacha/client", () => {
  test("no file under lib/ imports it statically", () => {
    const offenders = [];
    for (const [rel, full] of files(LIB)) {
      if (ALLOWED.has(rel)) continue;
      const src = readFileSync(full, "utf8");
      const staticImport = /^\s*import\s[^;]*?\sfrom\s+["']@(storacha|ucanto|web3-storage)\//m;
      if (staticImport.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test("the loader is the one dynamic importer", () => {
    const importers = [];
    for (const [rel, full] of files(LIB)) {
      if (ALLOWED.has(rel)) continue;
      if (/import\(\s*["']@storacha\//.test(readFileSync(full, "utf8"))) importers.push(rel);
    }
    expect(importers).toEqual(["storacha-client.js"]);
  });
});
