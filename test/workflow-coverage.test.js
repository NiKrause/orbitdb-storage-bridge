/**
 * @fileoverview Every suite under test/ runs in some workflow.
 *
 * 13 of the 35 files here ran in no job at all until #169 — backup-bundle.test.js
 * among them, which had been failing on main since #162 while this pipeline
 * stayed green, because nothing ran it. #169 removed the cause: the no-secrets
 * job names its set by exclusion, so a suite added tomorrow is covered the day
 * it lands. It left one hole. The exclusions assume the five suites they name
 * still have jobs of their own; delete one of those jobs and that suite goes
 * quiet again, with nothing to say so. This says so.
 *
 * It reads the workflows rather than trusting them: for each `run:` that ends
 * in jest, which suites that invocation would collect — resolving `npm run …`
 * through package.json, and honouring `--testPathIgnorePatterns`, which
 * replaces the list in the jest config rather than extending it. A step with
 * `working-directory` runs another package's suite and covers nothing here.
 */
import { describe, test, expect } from "@jest/globals";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");
const SCRIPTS = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;

/**
 * Suites that run in no workflow on purpose. The reason is the point: an entry
 * without one is a suite nobody decided about.
 */
const RUNS_NOWHERE_ON_PURPOSE = new Map([
  [
    "test/access-control-integration.test.js",
    "needs STORACHA_KEY and STORACHA_PROOF; without them its two tests return early, " +
      "after a ten-second live HEAD for a service that shut down on 2026-05-15",
  ],
]);

/** Flags whose value is not a path to match against. */
const TAKES_A_VALUE = new Set(["--maxWorkers", "--testTimeout", "-t", "--testNamePattern", "-w"]);

function testFiles(dir = join(ROOT, "test"), prefix = "test") {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...testFiles(join(dir, entry.name), `${prefix}/${entry.name}`));
    else if (entry.name.endsWith(".test.js")) found.push(`${prefix}/${entry.name}`);
  }
  return found;
}

/** Quote-aware, so `NODE_OPTIONS='a b'` stays one token and a pattern keeps its spaces. */
function tokenize(command) {
  return (command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((token) => token.replace(/["']/g, ""));
}

/** `npm run x` and `npm test -- args`, down to the jest argv they end in. */
function expand(command, depth = 0) {
  const call = /^npm (?:run )?([\w:-]+)(?: -- (.*))?$/.exec(command.trim());
  if (depth > 5 || !call || !SCRIPTS[call[1]]) return command;
  return [expand(SCRIPTS[call[1]], depth + 1), call[2]].filter(Boolean).join(" ");
}

/** The steps of every job, as the text from one `- ` to the next. */
function steps(text) {
  const found = [];
  let job = null;
  let indent = null;
  let current = null;
  const flush = () => {
    if (current) found.push({ job: current.job, text: current.lines.join("\n") });
    current = null;
  };

  for (const line of text.split("\n")) {
    const jobStart = /^ {2}([\w-]+):\s*$/.exec(line);
    if (jobStart) {
      flush();
      job = jobStart[1];
      indent = null;
      continue;
    }
    if (/^ {4}steps:\s*$/.test(line)) {
      flush();
      indent = null;
      continue;
    }
    // A list item at the step indentation starts a step; a deeper one belongs
    // to the step it sits in.
    const item = /^(\s+)- /.exec(line);
    if (item && (indent === null || item[1].length === indent)) {
      indent = item[1].length;
      flush();
      // `- run: …` and `- name: …` become plain keys, so the keys of a step
      // are read the same way wherever the dash fell.
      current = { job, lines: [line.replace(/^(\s*)- /, "$1  ")] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();
  return found;
}

/** The shell command a step runs, written inline or as a block scalar. */
function runCommand(stepText) {
  const lines = stepText.split("\n");
  const at = lines.findIndex((line) => /^\s+run:/.test(line));
  if (at === -1) return null;

  const [, indent, inline] = /^(\s+)run:\s*(.*)$/.exec(lines[at]);
  if (inline && !/^[|>][-+]?$/.test(inline)) return inline;

  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "") continue;
    if (line.search(/\S/) <= indent.length) break;
    body.push(line.trim());
  }
  return body.join("\n");
}

/** Every jest invocation in one workflow's text that runs this package's suites. */
function jestRuns(text) {
  const runs = [];
  for (const step of steps(text)) {
    if (/^\s+working-directory:/m.test(step.text)) continue;
    const command = runCommand(step.text);
    if (!command) continue;
    for (const line of command.split("\n")) {
      const expanded = expand(line.trim());
      if (/(^|\s)(npx\s+)?jest(\s|$)/.test(expanded)) runs.push({ job: step.job, command: expanded });
    }
  }
  return runs;
}

/** Whether `jest …` would collect this file: a positional arg is a regex on the path. */
function collects(command, file) {
  const tokens = tokenize(command);
  const ignored = [];
  const named = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--testPathIgnorePatterns") {
      // Variadic: every following argument until the next flag.
      while (i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) ignored.push(tokens[(i += 1)]);
      continue;
    }
    if (TAKES_A_VALUE.has(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith("-") || token.includes("=") || ["npm", "npx", "jest"].includes(token)) continue;
    named.push(token);
  }

  if (ignored.some((pattern) => new RegExp(pattern).test(file))) return false;
  return named.length === 0 || named.some((pattern) => new RegExp(pattern).test(file));
}

const RUNS = readdirSync(WORKFLOWS)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .flatMap((name) =>
    jestRuns(readFileSync(join(WORKFLOWS, name), "utf8")).map((run) => ({
      ...run,
      where: `${name}:${run.job}`,
    })),
  );

describe("every suite runs somewhere", () => {
  test("no test file is reachable from no workflow", () => {
    const uncovered = testFiles().filter((file) => !RUNS.some(({ command }) => collects(command, file)));

    expect(uncovered.sort()).toEqual([...RUNS_NOWHERE_ON_PURPOSE.keys()].sort());
  });

  test("a step that runs in another package covers nothing here", () => {
    // examples/svelte/recovery has a suite of its own, and `npm test` there
    // collects none of ours. Counting it would make the test above vacuous,
    // because one bare `npm test` looks like coverage of every file.
    const job = [
      "  e2e-tests-recovery:",
      "    steps:",
      "      - name: Run the offline tests - recovery",
      "        run: npm test",
      "        working-directory: examples/svelte/recovery",
    ].join("\n");

    expect(jestRuns(job)).toEqual([]);
    expect(jestRuns(job.replace(/\n.*working-directory.*/, ""))).toHaveLength(1);
  });

  test("a suite a run excludes is not covered by it", () => {
    const [run] = jestRuns(
      [
        "  courier-sync-tests:",
        "    steps:",
        "      - run: npx jest --forceExit --testPathIgnorePatterns 'test/gone\\.test\\.js'",
      ].join("\n"),
    );

    expect(collects(run.command, "test/gone.test.js")).toBe(false);
    expect(collects(run.command, "test/kept.test.js")).toBe(true);
  });
});
