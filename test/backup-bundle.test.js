/**
 * What a browser pays to back up.
 *
 * `backup-car.js` used to import the main entry, which imports
 * `@storacha/client` at the top — so a page that backs up to Aleph carried the
 * whole Storacha SDK. Measured in a real bundle: 88 kB gzipped, a fifth of the
 * mesh demo. Issue #58 fixed the same thing for restoring; this holds the line
 * for backing up.
 *
 * A static walk, not a bundler: what a bundler puts in the page is exactly the
 * graph of static imports, and `await import(...)` is what keeps the
 * Storacha-only paths out of it.
 */
import { describe, test, expect } from "@jest/globals";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const LIB = resolve(dirname(fileURLToPath(import.meta.url)), "../lib");

/** Every module a bundler would pull in for this entry, following static imports only. */
function staticImportGraph(entry) {
  const seen = new Set();
  const queue = [resolve(LIB, entry)];

  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);

    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch (error) {
      // Only our own files are ever queued; a package is recorded by name
      // below and never opened. So an unreadable path is a relative import
      // that no longer resolves, and swallowing it would walk a smaller graph
      // than the bundler builds — which is how the assertions below could
      // pass with nothing to find.
      throw new Error(`${file}: a relative import that does not resolve`, { cause: error });
    }

    // `import … from "x"`, `export … from "x"`, and bare `import "x"`, but not
    // `await import("x")`, which a bundler splits off. The clause may run over
    // several lines — both entries below import their helpers that way — so
    // the gap before `from` spans newlines, and nothing else: no `(`, `=` or
    // `;`, so the match cannot stride from an `export function` into the next
    // file's name.
    const specifiers = [...source.matchAll(/(?:^|\n)\s*(?:import|export)\s[\w$*{},\s]*?from\s*["']([^"']+)["']/g)]
      .map((match) => match[1])
      .concat(
        [...source.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)].map((match) => match[1]),
      );

    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) {
        queue.push(resolve(dirname(file), specifier));
      } else {
        seen.add(specifier); // a package name, kept as itself
      }
    }
  }

  return seen;
}

describe("what the backup path pulls in", () => {
  test("backing up does not reach the Storacha client", () => {
    const graph = staticImportGraph("backup-car.js");
    const storacha = [...graph].filter((id) => id.startsWith("@storacha/") || id.startsWith("@ucanto/"));

    expect(storacha).toEqual([]);
  });

  test("restoring from a CID does not either", () => {
    const graph = staticImportGraph("restore-cid.js");
    const storacha = [...graph].filter((id) => id.startsWith("@storacha/") || id.startsWith("@ucanto/"));

    expect(storacha).toEqual([]);
  });

  test("the walk does find it where it really is", () => {
    // The control, without which the two assertions above would pass for the
    // wrong reason. It was the main entry until #162 made `@storacha/client`
    // an optional peer and #166 moved it behind `loadStorachaClient`: no
    // module in the backup path names the package statically any more, so
    // `ucan-bridge.js` holds the line instead — Storacha-era, imported by
    // nothing under lib/, and the one file
    // test/no-static-storacha-import.test.js still allows a static import of
    // it.
    const graph = staticImportGraph("ucan-bridge.js");

    expect([...graph]).toContain("@storacha/client");
    expect([...graph]).toContain("@ucanto/core/delegation");
  });

  test("and does find the files behind a multi-line import", () => {
    // The other half of the control. A package is only recorded once the file
    // naming it has been opened, so a walk that stopped at the first line of
    // `import {\n  …\n} from "./backup-helpers.js"` would report no Storacha
    // for two modules of the backup path it never read.
    const graph = staticImportGraph("backup-car.js");

    expect([...graph]).toContain(resolve(LIB, "backup-helpers.js"));
    expect([...graph]).toContain(resolve(LIB, "backup-metadata.js"));
  });

  test("the main entry reaches the client through the loader, not directly", () => {
    // Where #162 and #166 left it: the entry still ends at the client, but
    // only through `storacha-client.js`, whose `import(...)` a bundler splits
    // into a chunk a page that never chose Storacha does not load.
    const graph = staticImportGraph("orbitdb-storacha-bridge.js");

    expect([...graph]).toContain(resolve(LIB, "storacha-client.js"));
    expect([...graph].filter((id) => id.startsWith("@storacha/"))).toEqual([]);
  });
});
