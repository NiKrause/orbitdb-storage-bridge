/**
 * @fileoverview The probe page says which endpoints it talks to. So do the
 * drivers. These have to be the same endpoints.
 *
 * The page is static and has no build step, which is what lets a reader open
 * it from a file and trust what they see — and also means it cannot import the
 * drivers' constants. So it repeats them, and a repetition that nobody checks
 * drifts. When it does, the page measures something the package does not do,
 * which is worse than not measuring at all.
 *
 * Also asserted here: the page carries no GPL. It came from a GPL-3.0
 * application (funkpost), was relicensed by its author for this repository,
 * and the brand module it used to import did **not** come with it.
 */

import { describe, test, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(repo, path), "utf8");

const page = read("examples/browser/storage-probe/index.html");
const ui = read("examples/browser/storage-probe/probe-ui.js");

/** `const NAME = "value";`, the only shape these constants are written in. */
function constantIn(source, name) {
  const match = source.match(
    new RegExp(`const ${name}\\s*=\\s*\\n?\\s*"([^"]+)"`, "m"),
  );
  return match?.[1] ?? null;
}

describe("the page and the drivers name the same endpoints", () => {
  test.each([
    ["ALEPH_GATEWAY", "lib/backends/aleph.js", "ALEPH_GATEWAYS"],
    ["PINATA_UPLOAD", "lib/backends/pinata.js", "DEFAULT_UPLOAD_URL"],
    ["PINATA_GATEWAY", "lib/backends/pinata.js", "DEFAULT_GATEWAY"],
    ["LIGHTHOUSE_GATEWAY", "lib/backends/lighthouse.js", "DEFAULT_GATEWAY"],
  ])("%s matches %s's %s", (pageName, driverPath, driverName) => {
    const inPage = constantIn(page, pageName);
    expect(inPage).toBeTruthy();

    const driver = read(driverPath);
    // ALEPH_GATEWAYS is a frozen list; the others are single strings.
    const inDriver =
      constantIn(driver, driverName) ??
      driver.match(new RegExp(`${driverName} = Object.freeze\\(\\["([^"]+)"`))?.[1];

    expect(inDriver).toBeTruthy();
    expect(inPage).toBe(inDriver);
  });

  test("the Lighthouse upload URL is that driver's node, with its query", () => {
    const inPage = constantIn(page, "LIGHTHOUSE_UPLOAD");
    const node = constantIn(read("lib/backends/lighthouse.js"), "DEFAULT_NODE");

    expect(inPage).toBeTruthy();
    expect(node).toBeTruthy();
    expect(inPage.startsWith(node)).toBe(true);
  });

  test("no gateway retired on 2026-09-21 is named anywhere on the page", () => {
    // #111: these answered until they did not, and a probe that asks a dead
    // host reports a broken network instead of a retired gateway.
    for (const host of ["dweb.link", "ipfs.io", "w3s.link", "storacha.link"]) {
      expect(page).not.toContain(host);
    }
  });
});

describe("what the move left behind", () => {
  test("the page is MIT, like the package", () => {
    expect(page).toContain("SPDX-License-Identifier: MIT");
    expect(page).not.toContain("GPL");
  });

  test("nothing GPL came with it", () => {
    // The brand module it used to import is GPL-3.0 and stayed where it was.
    expect(page).not.toContain("brand/brand.css");
    expect(page).not.toContain("brand/brand.js");
    expect(page).not.toContain("funkpost-brand");
    expect(ui).toContain("SPDX-License-Identifier: MIT");
  });

  test("it still works offline, as one page and one module", () => {
    // No bundler, no CDN, no import map: what the file references is what is
    // next to it. A reader can open it from a file:// URL and see the same
    // thing the deployed copy does.
    const scriptSources = [...page.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    const imports = [...page.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);

    expect(scriptSources).toEqual([]);
    for (const specifier of imports) {
      expect(specifier.startsWith("./")).toBe(true);
    }
  });

  test("both languages are in the page, and the CSS hides one", () => {
    expect(page).toContain('data-lang="de"');
    expect(page).toContain('data-lang="en"');
    // Without this rule the page shows every string twice — it used to come
    // from the brand stylesheet, which did not travel.
    expect(page).toMatch(/\[data-lang\][^{]*\{\s*display:\s*none/);
  });
});
