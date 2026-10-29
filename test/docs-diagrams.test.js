/**
 * @fileoverview A semicolon in a sequence diagram's text breaks the diagram.
 *
 * Mermaid reads `;` as a statement separator, so `A->>B: kept = f(x); rest`
 * ends the message at the semicolon and tries to parse ` rest` as a statement
 * of its own. GitHub then prints "Parse error on line 19" where the diagram
 * should be, and nothing else notices: `lint` is eslint on JavaScript,
 * `check:links` reads links, and a Markdown file has no build. Four of the
 * four diagrams in this repository were broken this way at once, two of them
 * since the day they were written.
 *
 * This is the one failure mode that has actually bitten, not a Mermaid parser:
 * running the real one would mean carrying Mermaid and a DOM in the test
 * suite, for a rule that fits in a line. Flowcharts are left alone, because
 * there `;` is a legal separator.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const SKIP = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "orbitdb-shared-identities",
]);

function* markdown(dir, prefix = "") {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory())
      yield* markdown(full, `${prefix}${name}/`);
    else if (name.endsWith(".md")) yield [`${prefix}${name}`, full];
  }
}

/** Every ```mermaid block, with the line it starts on. */
function* diagrams(source) {
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("```mermaid")) continue;
    const body = [];
    let j = i + 1;
    for (; j < lines.length && !lines[j].trim().startsWith("```"); j++)
      body.push(lines[j]);
    yield { kind: (body[0] ?? "").trim(), body, from: i + 2 };
    i = j;
  }
}

describe("the diagrams in the documentation", () => {
  test("no sequence diagram carries a semicolon in its text", () => {
    const offenders = [];
    for (const [rel, full] of markdown(ROOT)) {
      for (const { kind, body, from } of diagrams(readFileSync(full, "utf8"))) {
        if (kind !== "sequenceDiagram") continue;
        body.forEach((line, n) => {
          if (line.includes(";"))
            offenders.push(`${rel}:${from + n}  ${line.trim()}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
