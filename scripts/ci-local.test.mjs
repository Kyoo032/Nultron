import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkVitestLog,
  exitCodeFor,
  formatDuration,
  formatSummary,
  judgeStep,
  parseArgs,
  selectSteps,
  stripAnsi,
  workspaceGlobs,
} from "./ci-local.mjs";

const STEPS = [
  { group: "install", name: "install", required: true },
  { group: "lint", name: "lint", required: true },
  { group: "tsc", name: "tsc:packages/core", required: true },
  { group: "tsc", name: "tsc:apps/web", required: true },
  { group: "audit", name: "audit:workspace", required: false },
  { group: "e2e", name: "e2e:playwright", required: true },
];
const names = (steps) => steps.map((s) => s.name);

test("parseArgs reads repeatable --only/--skip in both spellings and the opt-in flags", () => {
  const args = parseArgs(["--only", "lint", "--only=tsc", "--skip", "tsc:apps/web", "--e2e", "--install"]);
  assert.deepEqual(args.only, ["lint", "tsc"]);
  assert.deepEqual(args.skip, ["tsc:apps/web"]);
  assert.equal(args.e2e, true);
  assert.equal(args.install, true);
});

test("parseArgs refuses unknown flags and a missing step name", () => {
  assert.throws(() => parseArgs(["--bogus"]), /unknown argument/);
  assert.throws(() => parseArgs(["--only"]), /needs a step name/);
  assert.throws(() => parseArgs(["--only", "--e2e"]), /needs a step name/);
  assert.throws(() => parseArgs(["--skip="]), /needs a step name/);
});

test("selectSteps leaves install and e2e out unless asked for", () => {
  assert.deepEqual(names(selectSteps(STEPS, parseArgs([]))), [
    "lint",
    "tsc:packages/core",
    "tsc:apps/web",
    "audit:workspace",
  ]);
  assert.deepEqual(names(selectSteps(STEPS, parseArgs(["--e2e", "--install"]))), names(STEPS));
});

test("selectSteps matches --only by group or by full name, and --only enables an opt-in step", () => {
  assert.deepEqual(names(selectSteps(STEPS, parseArgs(["--only", "tsc"]))), ["tsc:packages/core", "tsc:apps/web"]);
  assert.deepEqual(names(selectSteps(STEPS, parseArgs(["--only", "tsc:apps/web", "--only", "e2e"]))), [
    "tsc:apps/web",
    "e2e:playwright",
  ]);
});

test("selectSteps applies --skip after --only", () => {
  assert.deepEqual(names(selectSteps(STEPS, parseArgs(["--only", "tsc", "--skip", "tsc:packages/core"]))), [
    "tsc:apps/web",
  ]);
  assert.deepEqual(names(selectSteps(STEPS, parseArgs(["--e2e", "--skip", "e2e"]))), [
    "lint",
    "tsc:packages/core",
    "tsc:apps/web",
    "audit:workspace",
  ]);
});

test("exitCodeFor fails only on a required step", () => {
  assert.equal(exitCodeFor([]), 0);
  assert.equal(
    exitCodeFor([
      { required: true, status: "pass" },
      { required: false, status: "fail" },
    ]),
    0,
  );
  assert.equal(
    exitCodeFor([
      { required: true, status: "fail" },
      { required: false, status: "pass" },
    ]),
    1,
  );
});

test("formatSummary is a markdown table with a verdict line", () => {
  const summary = formatSummary([
    { name: "lint", required: true, status: "pass", durationMs: 1500 },
    { name: "tsc:apps/web", required: true, status: "fail", durationMs: 61_000 },
    { name: "audit:workspace", required: false, status: "fail", durationMs: 200 },
  ]);
  const lines = summary.split("\n");
  assert.equal(lines[0], "| step | status | duration |");
  assert.equal(lines[2], "| lint | pass | 1.5 s |");
  assert.equal(lines[3], "| tsc:apps/web | FAIL | 1m 1s |");
  assert.equal(lines[4], "| audit:workspace | warn (advisory) | 200 ms |");
  assert.equal(lines.at(-1), "FAIL: 1 required step(s) failed, 1 advisory warning(s).");
  assert.match(
    formatSummary([{ name: "lint", required: true, status: "pass", durationMs: 1 }]),
    /OK: every required step passed\.$/,
  );
});

test("formatDuration picks a readable unit", () => {
  assert.equal(formatDuration(999), "999 ms");
  assert.equal(formatDuration(12_340), "12.3 s");
  assert.equal(formatDuration(125_000), "2m 5s");
});

test("workspaceGlobs reads pnpm-workspace.yaml entries, quoted or not", () => {
  assert.deepEqual(workspaceGlobs("packages:\n  - \"apps/*\"\n  - packages/*\n  - 'tools' # comment\n"), [
    "apps/*",
    "packages/*",
    "tools",
  ]);
});

// ---------------------------------------------------------------------------------------------
// A vitest step that ran nothing must not read as a pass
// ---------------------------------------------------------------------------------------------
//
// 2026-10-01: `apps/portal` run under an admin token could not start its embedded Postgres, vitest
// logged "No test files found ... Unhandled Error" and still exited 0, and ci-local printed `pass`.
// Exit code alone says "the process ended", not "tests ran", so a vitest step also needs the
// `Tests  N passed` summary line in its own log. The fixtures below are lines copied from real logs.

const ESC = String.fromCharCode(27);
const ansi = (code, text) => `${ESC}[${code}m${text}${ESC}[0m`;
/** The summary exactly as vitest 3 prints it when FORCE_COLOR is on (a real core log, 2026-10-01). */
const COLOURED_SUMMARY = `${ESC}[2m      Tests ${ESC}[22m ${ESC}[1m${ESC}[32m2795 passed${ESC}[39m${ESC}[22m${ESC}[2m | ${ESC}[22m${ESC}[33m1 skipped${ESC}[39m${ESC}[90m (2796)${ESC}[39m`;
const FILES_ONLY = " Test Files  1 passed (1)";

test("stripAnsi removes colour codes and leaves the text", () => {
  assert.equal(stripAnsi(`${ansi(31, "red")} and ${ansi("1;42", "bold")}`), "red and bold");
  assert.equal(stripAnsi("plain"), "plain");
});

test("checkVitestLog accepts the summary with one space or two, plain or coloured", () => {
  assert.deepEqual(checkVitestLog("      Tests  41 passed (41)\n"), { ok: true, passed: 41 });
  assert.deepEqual(checkVitestLog("Tests 7 passed (7)\n"), { ok: true, passed: 7 });
  assert.deepEqual(checkVitestLog(`${COLOURED_SUMMARY}\n`), { ok: true, passed: 2795 });
});

test("checkVitestLog reads the passed count out of a mixed summary", () => {
  assert.equal(checkVitestLog(" Tests  1 failed | 40 passed (41)\n").passed, 40);
  assert.equal(checkVitestLog(" Tests  1 failed | 2 skipped | 40 passed | 1 todo (44)\n").passed, 40);
  assert.equal(checkVitestLog(" Tests  40 passed | 1 skipped (41)\n").passed, 40);
});

test("checkVitestLog fails the portal log that found no tests and still exited 0", () => {
  const portal = [
    "$ node vitest.mjs run",
    `${ESC}[1m${ESC}[46m RUN ${ESC}[49m${ESC}[22m ${ESC}[36mv3.2.7 ${ESC}[39m`,
    "Execution of PostgreSQL by a user with administrative permissions is not",
    `${ESC}[31mNo test files found, exiting with code 1`,
    `${ESC}[31m${ESC}[1m Unhandled Error ${ESC}[22m`,
    "[ci-local] exit 0",
  ].join("\n");
  const verdict = checkVitestLog(portal);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.passed, 0);
  assert.match(verdict.reason, /no tests ran/i);
  assert.match(verdict.reason, /Tests N passed/);
});

test("checkVitestLog fails an empty log, a files-only line and an all-skipped run", () => {
  assert.equal(checkVitestLog("").ok, false);
  assert.equal(checkVitestLog(FILES_ONLY).ok, false);
  assert.equal(checkVitestLog(" Tests  3 skipped (3)\n").ok, false);
  assert.equal(checkVitestLog(" Tests  0 passed (0)\n").ok, false);
});

test("checkVitestLog does not take a test title that mentions the word for the summary", () => {
  const log = " ✓ src/a.test.ts (2 tests) 5ms\n  Tests the retry. 5 passed through\n[ci-local] exit 0\n";
  assert.equal(checkVitestLog(log).ok, false);
});

test("checkVitestLog tolerates CRLF line endings", () => {
  assert.equal(checkVitestLog(" Test Files  1 passed (1)\r\n      Tests  9 passed (9)\r\n").passed, 9);
});

test("judgeStep passes a clean vitest step with a summary, and fails it without one", () => {
  const withSummary = judgeStep({ exitCodes: [0], requireTestSummary: true, logText: COLOURED_SUMMARY });
  assert.deepEqual(withSummary, { status: "pass" });

  const portal = judgeStep({
    exitCodes: [0],
    requireTestSummary: true,
    logText: "No test files found\n[ci-local] exit 0\n",
  });
  assert.equal(portal.status, "fail");
  assert.match(portal.reason, /no tests ran/i);
});

test("judgeStep leaves every other kind of step to its exit code", () => {
  assert.deepEqual(judgeStep({ exitCodes: [0], logText: "no summary line here" }), { status: "pass" });
  assert.deepEqual(judgeStep({ exitCodes: [0, 0], requireTestSummary: false, logText: "" }), { status: "pass" });
});

test("judgeStep says why a step failed: the exit code, or a tool that was not installed", () => {
  assert.deepEqual(judgeStep({ exitCodes: [0, 2], logText: "" }), { status: "fail", reason: "exit code 2" });
  assert.deepEqual(judgeStep({ exitCodes: [], note: "vitest not installed", logText: "" }), {
    status: "fail",
    reason: "vitest not installed",
  });
  // A failing vitest run already failed on its exit code; the missing summary is not piled on top.
  assert.deepEqual(judgeStep({ exitCodes: [1], requireTestSummary: true, logText: "" }), {
    status: "fail",
    reason: "exit code 1",
  });
});

test("formatSummary lists the reason a step failed under the table and keeps the verdict last", () => {
  const summary = formatSummary([
    { name: "lint", required: true, status: "pass", durationMs: 1 },
    {
      name: "test:apps/portal",
      required: true,
      status: "fail",
      durationMs: 25_600,
      reason: "vitest printed no `Tests N passed` summary line, so no tests ran",
    },
  ]);
  const lines = summary.split("\n");
  assert.equal(lines[3], "| test:apps/portal | FAIL | 25.6 s |");
  assert.ok(lines.includes("- test:apps/portal: vitest printed no `Tests N passed` summary line, so no tests ran"));
  assert.equal(lines.at(-1), "FAIL: 1 required step(s) failed.");
  // And a run with no failures carries no reasons block at all.
  assert.ok(!formatSummary([{ name: "lint", required: true, status: "pass", durationMs: 1 }]).includes("Reasons"));
});

test("--help lists sandbox:integration as a required step beside the advisory manifest check", () => {
  const help = execFileSync(process.execPath, [fileURLToPath(new URL("./ci-local.mjs", import.meta.url)), "--help"], {
    encoding: "utf8",
  });
  const rows = help.split("\n").filter((line) => line.trim().startsWith("sandbox"));
  const integration = rows.find((line) => line.includes("sandbox:integration"));
  assert.ok(integration, `no sandbox:integration row in:\n${help}`);
  assert.ok(!integration.includes("(advisory)"), "the engine run must be required");
  assert.ok(rows.some((line) => line.includes("sandbox:manifest") && line.includes("(advisory)")));
});
