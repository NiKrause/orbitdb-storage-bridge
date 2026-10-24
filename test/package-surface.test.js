/**
 * @fileoverview What the package promises, against what it ships.
 *
 * Two Svelte components sat in `exports` for months while importing four
 * files no release contained. Nothing noticed, because nothing here looks at
 * the manifest: the suites import `../lib/…` by relative path, which works
 * whatever `exports` and `files` say. These tests read the manifest.
 */

import { describe, test, expect } from "@jest/globals";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const targets = Object.entries(manifest.exports).filter(([name]) => !name.includes("*"));

describe("the package surface", () => {
  test("every export points at a file that exists", () => {
    // `dist/components/` is built by `prepublishOnly`, so a target there is
    // checked against the source it is copied from.
    const missing = targets
      .map(([name, target]) => {
        const built = String(target).replace(/^\.\/dist\/components\//, "./src/components/");
        return existsSync(join(root, built)) ? null : `${name} → ${target}`;
      })
      .filter(Boolean);
    expect(missing).toEqual([]);
  });

  test("no Svelte component is exported", () => {
    // None has ever built in a consumer — see docs/STORACHA-UI-HISTORY.md.
    // Exporting one again means making it importable first, and proving it.
    expect(targets.filter(([, target]) => String(target).endsWith(".svelte"))).toEqual([]);
  });

  test("a component that is not exported is not shipped either", () => {
    const exported = new Set(targets.map(([, t]) => String(t).replace(/^\.\//, "")));
    const excluded = new Set(
      (manifest.files ?? [])
        .filter((entry) => entry.startsWith("!"))
        .map((entry) => entry.slice(1)),
    );
    const shippedButUnreachable = ["StorachaAuth", "StorachaIntegration", "StorachaTest"]
      .map((name) => `dist/components/${name}.svelte`)
      .filter((path) => !exported.has(path) && !excluded.has(path));
    expect(shippedButUnreachable).toEqual([]);
  });

  test("the svelte field is gone with them", () => {
    // It pointed at a directory with no `.svelte` file in it, and with no
    // matching export condition it made vite-plugin-svelte warn in every
    // consumer that built this package.
    expect(manifest.svelte).toBeUndefined();
  });
});
