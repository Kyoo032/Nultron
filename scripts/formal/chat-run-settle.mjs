#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = join(ROOT, "formal", "chat-run-settle", "ChatRunSettle.tla");
const RUNS = join(ROOT, "packages", "host", "src", "runs.ts");
const THREADS = join(ROOT, "packages", "host", "src", "threads.ts");
const DB_CLIENT = join(ROOT, "packages", "db", "src", "client.ts");

const TLC = {
  version: "1.7.4",
  sha256: "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
  url: "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar",
};

const INVARIANTS = [
  "TypeOK",
  "FailedRowHasNoAnswer",
  "AtMostOneUsageRow",
  "NoFailureAfterSuccess",
  "EndsSettled",
  "BilledIsMetered",
];
const PROPERTIES = ["Termination"];
const SWITCHES = [
  "DbYields",
  "StallGuard",
  "GuardAfterInsert",
  "GuardOnCompleted",
  "GuardAfterAttempt",
  "GuardInCatch",
  "SettleFinishes",
  "FinishOnlyFromStreaming",
  "MeterOnce",
  "MeterOnFinish",
  "MeterOnSettledCompletion",
  "MeterAfterAttempt",
  "ClaimOnPersist",
  "CancelYieldsToClaim",
];

class Drift extends Error {}

function between(text, startNeedle, endNeedle, label) {
  const start = text.indexOf(startNeedle);
  if (start < 0) {
    throw new Drift(`${label}: cannot find "${startNeedle}"`);
  }
  const end = text.indexOf(endNeedle, start + startNeedle.length);
  if (end < 0) {
    throw new Drift(`${label}: cannot find "${endNeedle}" after "${startNeedle}"`);
  }
  return text.slice(start, end);
}

function before(text, anchorNeedle, openerNeedle, label) {
  const anchor = text.indexOf(anchorNeedle);
  if (anchor < 0) {
    throw new Drift(`${label}: cannot find "${anchorNeedle}"`);
  }
  const opener = text.lastIndexOf(openerNeedle, anchor);
  if (opener < 0) {
    throw new Drift(`${label}: cannot find "${openerNeedle}" before "${anchorNeedle}"`);
  }
  return text.slice(opener, anchor);
}

function readCode() {
  const runs = readFileSync(RUNS, "utf8").replace(/\r\n/g, "\n");
  const threads = readFileSync(THREADS, "utf8").replace(/\r\n/g, "\n");
  const client = readFileSync(DB_CLIENT, "utf8").replace(/\r\n/g, "\n");
  const settleRun = between(
    runs,
    "const settleRun = (message: string) => {",
    "const stall = armRunStallGuard(",
    "settleRun",
  );
  const onStall = between(runs, "onStall: (message) => {", "const onClientAbort = () => {", "onStall");
  const onClientAbort = between(
    runs,
    "const onClientAbort = () => {",
    'options.abortSignal?.addEventListener("abort", onClientAbort',
    "onClientAbort",
  );
  if (!runs.includes("const persistAssistant = async () => {")) {
    throw new Drift('persistAssistant: cannot find "const persistAssistant = async () => {"');
  }
  const persistCalls = (runs.match(/persistAssistant\(\)/g) ?? []).length;
  if (persistCalls !== 3) {
    throw new Drift(
      `persistAssistant: expected 3 call sites (run.completed handler, after the model call, catch path), found ${persistCalls}; model the new one before trusting a PASS`,
    );
  }
  const meter = between(
    runs,
    "const meterSettledRun = () => {",
    "const persistAssistant = async () => {",
    "meterSettledRun",
  );
  const onCompleted = between(
    runs,
    'if (event.type === "run.completed") {',
    "await persistAssistant();",
    "run.completed handler",
  );
  const afterAttempt = before(
    runs,
    'const finished = await finishRun(options.tenant, run.id, "completed"',
    "await attempt();",
    "after the model call",
  );
  const inCatch = before(runs, "const saved = await persistAssistant();", "} catch (error) {", "catch path");
  const finishRun = between(
    threads,
    "export async function finishRun(",
    "export async function listRunUsage(",
    "finishRun",
  );
  const finishTail = between(
    runs,
    'const finished = await finishRun(options.tenant, run.id, "completed"',
    'if (recordsRetrievals(finished, "completed"))',
    "after finishRun completed",
  );
  if (!runs.includes("runId = run.id;")) {
    throw new Drift('insertRun: cannot find "runId = run.id;"');
  }
  const claimFirst = /const persistAssistant = async \(\) => \{\n\s*finishing = true;/.test(runs);
  const awaitsBeforeClaim = [
    ["the run.completed handler", onCompleted],
    ["the code after the model call", afterAttempt],
    ["the catch path", inCatch],
  ]
    .filter(([, slice]) => awaitBetweenGuardAndPersist(slice))
    .map(([label]) => label);
  const notes = [];
  if (!claimFirst) {
    notes.push("ClaimOnPersist is false: `finishing = true;` is not the first statement of persistAssistant.");
  }
  for (const label of awaitsBeforeClaim) {
    notes.push(`ClaimOnPersist is false: an await sits between \`if (settled) {\` and persistAssistant() in ${label}.`);
  }
  const switches = {
    DbYields: !client.includes('from "drizzle-orm/better-sqlite3"'),
    StallGuard: runs.includes("armRunStallGuard({") && onStall.includes("settleRun(message)"),
    GuardAfterInsert: /runId = run\.id;\s*\n\s*if \(settled\) \{/.test(runs),
    GuardOnCompleted: onCompleted.includes("if (settled) {"),
    GuardAfterAttempt: afterAttempt.includes("if (settled) {"),
    GuardInCatch: inCatch.includes("if (settled) {"),
    SettleFinishes: settleRun.includes('finishRun(options.tenant, runId, "failed"'),
    FinishOnlyFromStreaming: finishRun.includes('eq(runs.status, "streaming")'),
    MeterOnce: meter.includes("settledRunMetered ||") && meter.includes("settledRunMetered = true"),
    MeterOnFinish: finishTail.includes("recordChatRunUsage(options.tenant, run.id, finished, runUsage)"),
    MeterOnSettledCompletion: onCompleted.includes("meterSettledRun();"),
    MeterAfterAttempt: afterAttempt.includes("meterSettledRun();"),
    ClaimOnPersist: claimFirst && awaitsBeforeClaim.length === 0,
    CancelYieldsToClaim:
      /if \(queueClosed \|\| finishing\) \{\s*return;/.test(onStall) &&
      /if \(queueClosed \|\| finishing\) \{\s*return;/.test(onClientAbort),
  };
  return { switches, notes };
}

function awaitBetweenGuardAndPersist(slice) {
  const guard = slice.indexOf("if (settled) {");
  if (guard < 0) {
    return false;
  }
  const call = slice.lastIndexOf("await persistAssistant()");
  return /\bawait\b/.test(slice.slice(guard, call > guard ? call : slice.length));
}

function parseArgs(argv) {
  const args = { hazard: false, breaks: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--hazard") {
      args.hazard = true;
    } else if (arg === "--break") {
      const name = argv[i + 1];
      if (!SWITCHES.includes(name) || name === "DbYields") {
        throw new Error(`--break needs one of: ${SWITCHES.filter((s) => s !== "DbYields").join(", ")}`);
      }
      args.breaks.push(name);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function jarPath() {
  const jar = process.env.TLA2TOOLS_JAR || join(homedir(), ".cache", "nultron-formal", `tla2tools-${TLC.version}.jar`);
  if (!existsSync(jar)) {
    console.error(`TLC ${TLC.version} is not at ${jar}.`);
    console.error(`Fetch it once:  curl -L -o "${jar}" ${TLC.url}`);
    console.error(`Expected sha256: ${TLC.sha256}`);
    process.exit(3);
  }
  const sum = createHash("sha256").update(readFileSync(jar)).digest("hex");
  if (sum !== TLC.sha256) {
    console.error(`${jar} has sha256 ${sum}, expected ${TLC.sha256}. Refusing to run an unpinned TLC.`);
    process.exit(3);
  }
  return jar;
}

function writeConfig(dir, values, invariants, properties) {
  const lines = ["SPECIFICATION Spec", "CONSTANTS"];
  for (const name of SWITCHES) {
    lines.push(`  ${name} = ${values[name] ? "TRUE" : "FALSE"}`);
  }
  if (invariants.length > 0) {
    lines.push(`INVARIANTS ${invariants.join(" ")}`);
  }
  if (properties.length > 0) {
    lines.push(`PROPERTIES ${properties.join(" ")}`);
  }
  writeFileSync(join(dir, "ChatRunSettle.cfg"), `${lines.join("\n")}\n`);
}

function check(jar, values, invariants, properties) {
  const work = mkdtempSync(join(tmpdir(), "chat-run-settle-"));
  try {
    copyFileSync(SPEC, join(work, "ChatRunSettle.tla"));
    writeConfig(work, values, invariants, properties);
    const result = spawnSync(
      "java",
      [
        "-XX:+UseParallelGC",
        "-cp",
        jar,
        "tlc2.TLC",
        "-deadlock",
        "-workers",
        "1",
        "-metadir",
        join(work, "states"),
        "-config",
        "ChatRunSettle.cfg",
        "ChatRunSettle.tla",
      ],
      { cwd: work, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const violations = [...output.matchAll(/Invariant (\S+) is violated/g)].map((m) => m[1].replace(/\.$/, ""));
    if (output.includes("Temporal properties were violated")) {
      violations.push("Termination");
    }
    const passed = violations.length === 0 && output.includes("Model checking completed. No error has been found.");
    const states = output.match(/(\d+) distinct states found/);
    return { output, violations, passed, states: states ? states[1] : "?" };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let code;
  let notes;
  try {
    ({ switches: code, notes } = readCode());
  } catch (error) {
    if (error instanceof Drift) {
      console.error(`DRIFT: ${error.message}`);
      console.error(
        "The covered code changed shape. Re-derive the model from the code (.cursor/skills/chat-run-settle/SKILL.md).",
      );
      process.exit(2);
    }
    throw error;
  }
  const values = { ...code };
  if (args.hazard) {
    values.DbYields = true;
  }
  for (const name of args.breaks) {
    values[name] = false;
  }
  console.log("Read from the code:");
  for (const name of SWITCHES) {
    const forced = values[name] !== code[name] ? `  (forced from ${code[name]})` : "";
    console.log(`  ${name.padEnd(24)} ${values[name]}${forced}`);
  }
  for (const note of notes) {
    console.log(note);
  }
  const jar = jarPath();
  if (args.hazard) {
    const broken = [];
    for (const name of [...INVARIANTS, ...PROPERTIES]) {
      const isProperty = PROPERTIES.includes(name);
      const run = check(jar, values, isProperty ? [] : [name], isProperty ? [name] : []);
      console.log(`  ${name.padEnd(24)} ${run.passed ? "holds" : "VIOLATED"}`);
      if (!run.passed) {
        broken.push(name);
      }
    }
    console.log(broken.length === 0 ? "PASS: nothing breaks" : `FAIL: ${broken.join(", ")}`);
    process.exit(broken.length === 0 ? 0 : 1);
  }
  const run = check(jar, values, INVARIANTS, PROPERTIES);
  if (run.passed) {
    console.log(`PASS: every invariant and Termination hold (${run.states} distinct states).`);
    process.exit(0);
  }
  console.log(run.output);
  console.log(
    `FAIL: ${run.violations.length > 0 ? [...new Set(run.violations)].join(", ") : "TLC did not finish, see the output above"}`,
  );
  process.exit(1);
}

main();
