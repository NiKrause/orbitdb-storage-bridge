/**
 * @fileoverview Turns the smoke test's Jest results into a short report: which
 * test failed, and the first lines of why. Written to the job summary and to
 * `smoke/report.md`, which the issue step quotes.
 *
 *     node test/helpers/smoke-report.js <Provider> [dir=smoke]
 */
import { readdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const provider = process.argv[2] || "provider";
const dir = process.argv[3] || "smoke";
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

const lines = [`### ${provider}`, ""];
const info = [];
let failed = 0;
let passed = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  // `info-*`: a step that may fail without failing the job. Reported apart, never counted.
  const out = file.startsWith("info-") ? info : lines;
  const count = out === lines;
  let result;
  try {
    result = JSON.parse(readFileSync(join(dir, file), "utf8"));
  } catch {
    out.push(`- \`${file}\`: no readable result (the step did not get as far as Jest)`);
    continue;
  }
  for (const suite of result.testResults || []) {
    const assertions = suite.assertionResults || [];
    // Failed with no failing test: it did not run, or a hook (beforeAll, afterAll) threw.
    if (suite.status === "failed" && !assertions.some((a) => a.status === "failed")) {
      if (count) failed++;
      out.push(
        `- ❌ \`${file.replace(/\.json$/, "")}\`: ${assertions.length ? "a hook failed" : "the suite did not run"}`,
        "", "```",
        // eslint-disable-next-line no-control-regex
        String(suite.message).replace(/\u001b\[[0-9;]*m/g, "").slice(0, 1200), "```",
      );
    }
    for (const a of suite.assertionResults || []) {
      if (a.status === "passed" && count) passed++;
      if (a.status !== "failed") continue;
      if (count) failed++;
      const why = (a.failureMessages || []).join("\n")
        // eslint-disable-next-line no-control-regex
        .replace(/\u001b\[[0-9;]*m/g, "")
        .split("\n")
        .filter((l) => !/^\s+at /.test(l))
        .slice(0, 12)
        .join("\n");
      out.push(`- ${count ? "❌" : "⚠️"} ${a.ancestorTitles.join(" › ")} › **${a.title}**`, "", "```", why.slice(0, 1500), "```");
    }
  }
}
lines.splice(2, 0, `${passed} passed, ${failed} failed`, "");
if (info.length) lines.push("", "Informational (does not fail the job):", "", ...info);
const text = `${lines.join("\n")}\n`;
writeFileSync(join(dir, "report.md"), text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
console.log(text);
