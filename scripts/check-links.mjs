#!/usr/bin/env node
/**
 * Check every link in every Markdown file in this repository.
 *
 * It exists because two links in the README pointed at a demo that had moved
 * repositories months earlier, and nothing noticed: `npm run lint` covers
 * `{lib,examples,test}/**\/*.js` and `format` the same folders, so Markdown was
 * checked by nobody. A relative link is a fact about this repository, and facts
 * about this repository belong in CI.
 *
 * Three kinds of check, deliberately not equally strict:
 *
 *   - **relative paths** — the file either exists or it does not. Always fatal.
 *   - **anchors** — `#some-heading` is resolved against the target file's
 *     headings, using GitHub's slug rules. Always fatal, because this is how
 *     `#@le-space/orbitdb-storage-bridge` survived a rename in the table of
 *     contents.
 *   - **external URLs** — fatal only on `404`/`410`. A `403` from npmjs.com and
 *     a `429` from a gateway are somebody else's bot policy, not our rot, and a
 *     pipeline that goes red on those is a pipeline everybody learns to ignore.
 *     They are reported, and they do not fail the run.
 *
 * Usage:
 *   node scripts/check-links.mjs              # everything
 *   node scripts/check-links.mjs --offline    # skip the network
 *
 * Silence a host or a URL by adding a substring to `.linkcheckignore`.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve, relative, extname } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OFFLINE = process.argv.includes("--offline");
const SKIP_DIRS = new Set([
  "node_modules", ".git", "build", "dist", ".svelte-kit", "coverage", ".next",
]);
const TIMEOUT_MS = 20_000;
const CONCURRENCY = 8;

/** GitHub's heading slug: lower-cased, punctuation dropped, spaces hyphenated. */
function slug(heading) {
  return heading
    .replace(/`([^`]*)`/g, "$1") // code spans contribute their text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links contribute their label
    .replace(/[*_~]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

/** Every heading slug in a Markdown file, with GitHub's duplicate suffixes. */
async function anchorsOf(file) {
  const seen = new Map();
  const anchors = new Set();
  let fenced = false;
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!m) continue;
    const base = slug(m[2]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

/** Markdown files, minus anything generated or vendored. */
async function markdownFiles(dir = ROOT, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await markdownFiles(join(dir, entry.name), found);
    } else if (extname(entry.name).toLowerCase() === ".md") {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

/** Links in a file, outside fenced code, with the line they sit on. */
async function linksOf(file) {
  const out = [];
  let fenced = false;
  const lines = (await readFile(file, "utf8")).split("\n");
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const patterns = [
      /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, // [text](target)
      /(?<![(\w])<((?:https?:)\/\/[^>\s]+)>/g, //      <https://…>
    ];
    for (const re of patterns) {
      for (const m of line.matchAll(re)) {
        out.push({ target: m[1], line: i + 1 });
      }
    }
  });
  return out;
}

const ignore = existsSync(join(ROOT, ".linkcheckignore"))
  ? (await readFile(join(ROOT, ".linkcheckignore"), "utf8"))
      .split("\n")
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter(Boolean)
  : [];
const ignored = (url) => ignore.some((pattern) => url.includes(pattern));

/** One external URL. `ok` false only when the answer means "gone". */
async function checkExternal(url) {
  for (const method of ["HEAD", "GET"]) {
    try {
      const response = await fetch(url, {
        method,
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          // Some hosts answer a bare client with 403; ask like a browser.
          "user-agent":
            "Mozilla/5.0 (compatible; orbitdb-storage-bridge link check)",
          accept: "*/*",
        },
      });
      if (response.status === 405 && method === "HEAD") continue;
      return {
        ok: response.status !== 404 && response.status !== 410,
        note: `HTTP ${response.status}`,
        tolerated: response.status >= 400,
      };
    } catch (error) {
      if (method === "GET") {
        // A timeout or a DNS hiccup on a runner is not evidence of rot.
        return { ok: true, note: String(error.message || error), tolerated: true };
      }
    }
  }
  return { ok: true, note: "unreachable", tolerated: true };
}

async function main() {
  const files = await markdownFiles();
  const anchorCache = new Map();
  const fatal = [];
  const tolerated = [];
  const external = [];

  for (const file of files) {
    const rel = relative(ROOT, file);
    for (const { target, line } of await linksOf(file)) {
      const where = `${rel}:${line}`;

      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
        if (/^https?:/i.test(target) && !ignored(target)) {
          external.push({ where, target });
        }
        continue; // mailto:, tel:, data: and friends are not ours to verify
      }

      const [path, anchor] = target.split("#");

      if (!path) {
        // Same-file anchor.
        if (!anchorCache.has(file)) anchorCache.set(file, await anchorsOf(file));
        if (anchor && !anchorCache.get(file).has(anchor)) {
          fatal.push(`${where}  no such heading in this file: #${anchor}`);
        }
        continue;
      }

      const resolved = resolve(dirname(file), decodeURIComponent(path));

      if (!resolved.startsWith(ROOT + "/")) {
        // `../../issues/4` and friends: GitHub resolves these against the blob
        // URL rather than the file tree, and they do answer. Not ours to verify.
        tolerated.push(`${where}  ${target}  escapes the repository; GitHub resolves it against the blob URL`);
        continue;
      }

      if (!existsSync(resolved)) {
        fatal.push(`${where}  missing: ${target}`);
        continue;
      }
      if (anchor && extname(resolved).toLowerCase() === ".md") {
        if (!anchorCache.has(resolved)) {
          anchorCache.set(resolved, await anchorsOf(resolved));
        }
        if (!anchorCache.get(resolved).has(anchor)) {
          fatal.push(`${where}  no such heading in ${path}: #${anchor}`);
        }
      } else if (anchor && (await stat(resolved)).isDirectory()) {
        // A directory with a fragment is a GitHub UI affordance, not a file.
      }
    }
  }

  console.log(`Checked ${files.length} Markdown files.`);

  if (!OFFLINE && external.length) {
    const seen = new Map();
    const queue = [...external];
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        if (!seen.has(item.target)) {
          seen.set(item.target, await checkExternal(item.target));
        }
        const result = seen.get(item.target);
        const message = `${item.where}  ${item.target}  ${result.note}`;
        if (!result.ok) fatal.push(message);
        else if (result.tolerated) tolerated.push(message);
      }
    });
    await Promise.all(workers);
    console.log(`Checked ${seen.size} distinct external URLs.`);
  } else if (OFFLINE) {
    console.log(`Skipped ${external.length} external links (--offline).`);
  }

  if (tolerated.length) {
    console.log("\nAnswered, but not with a 2xx — reported, not failing:");
    for (const line of tolerated.sort()) console.log(`  ${line}`);
  }

  if (fatal.length) {
    console.log("\nBroken:");
    for (const line of fatal.sort()) console.log(`  ${line}`);
    console.log(`\n${fatal.length} broken link(s).`);
    process.exit(1);
  }

  console.log("\nNo broken links.");
}

await main();
