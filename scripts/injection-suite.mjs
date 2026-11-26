#!/usr/bin/env node
/**
 * F6 layer 2 (B7) — the injection test suite + report.
 *
 * Runs the guard, judge, spotlight and canary vitest files inside packages/core and
 * writes a report to `.ci-local/injection-suite/<timestamp>/report.{md,json}` — the
 * acceptance record for AC-6.2/6.3/6.4/6.5 without needing the live gateway (the judge
 * path is covered through its injectable call, the live call is fail-open by design).
 *
 * Exit 0 when every suite file reports "Tests N passed"; 1 otherwise.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreDir = path.join(repoRoot, "packages", "core");
const vitest = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");

const SUITES = [
  "src/security/injection-guard.test.ts",
  "src/security/spotlight.test.ts",
  "src/security/canary.test.ts",
  "src/security/injection-judge.test.ts",
  "src/runtime/invoke-guarded.test.ts",
];

if (!existsSync(vitest)) {
  console.error("vitest not installed — run pnpm install first");
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(repoRoot, ".ci-local", "injection-suite", stamp);
mkdirSync(outDir, { recursive: true });

const results = [];
let allPassed = true;
for (const suite of SUITES) {
  const run = spawnSync(process.execPath, [vitest, "run", suite], {
    cwd: coreDir,
    encoding: "utf8",
    env: { ...process.env, AGENTFORGE_DATA_DIR: process.env.AGENTFORGE_DATA_DIR ?? `${outDir}/data` },
  });
  const log = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  const summary = /Tests\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+skipped)?/.exec(log);
  const passed = run.status === 0 && summary !== null && Number(summary[1]) > 0;
  if (!passed) allPassed = false;
  results.push({ suite, ok: passed, tests: summary ? Number(summary[1]) : 0, exit: run.status });
  writeFileSync(path.join(outDir, `${path.basename(suite, ".ts")}.log`), log);
  console.log(`${passed ? "PASS" : "FAIL"} ${suite} (${summary ? summary[1] : "?"} tests)`);
}

const report = {
  when: new Date().toISOString(),
  suites: results,
  verdict: allPassed ? "pass" : "fail",
};
writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
writeFileSync(
  path.join(outDir, "report.md"),
  [
    "# Injection suite (F6 layer 2)",
    "",
    `Verdict: **${allPassed ? "PASS" : "FAIL"}** — ${stamp}`,
    "",
    "| suite | result | tests |",
    "|---|---|---|",
    ...results.map((r) => `| ${r.suite} | ${r.ok ? "pass" : "FAIL"} | ${r.tests} |`),
    "",
  ].join("\n"),
);
console.log(`report: ${outDir}/report.md`);
process.exit(allPassed ? 0 : 1);
