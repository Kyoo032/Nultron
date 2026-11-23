#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const CHECKS = {
  gate: {
    dir: "packages/core",
    files: [
      "src/runtime/media-permission.property.test.ts",
      "src/runtime/media-permission.test.ts",
      "src/runtime/invoke-guarded.test.ts",
    ],
  },
  reach: {
    dir: "packages/host",
    files: [
      "src/paid-media-reach.property.test.ts",
      "src/paid-media-body.test.ts",
      "src/runs-paid-media.test.ts",
    ],
  },
};

const BREAKS = [
  {
    id: "grant-never-spent",
    proves: "a Run press starts the same request again and again",
    file: "packages/core/src/runtime/media-permission.ts",
    find: "        open.set(key, left - 1);\n",
    replace: "",
    catchers: ["gate"],
  },
  {
    id: "any-grant-opens",
    proves: "a grant for one request lets a different request through",
    file: "packages/core/src/runtime/media-permission.ts",
    find: "      if (left > 0) {",
    replace: "      if (left > 0 || open.size > 0) {",
    catchers: ["gate"],
  },
  {
    id: "key-ignores-model",
    proves: "a Run on a cheap model lets the same prompt run on a dearer one",
    file: "packages/core/src/runtime/media-permission.ts",
    find: "  const pairs = Object.keys(picked)\n",
    replace: '  const pairs = Object.keys(picked).filter((field) => field !== "model")\n',
    catchers: ["gate"],
  },
  {
    id: "model-extras-run",
    proves: "the call runs with the model's own fields, not the card's",
    file: "packages/core/src/runtime/media-permission.ts",
    find: "return isPaidMediaTool(toolKey) ? mediaRequestArgs(toolKey, args) : args;",
    replace: "return args;",
    catchers: ["gate"],
  },
  {
    id: "gate-skipped",
    proves: "the choke point stops asking the gate",
    file: "packages/core/src/runtime/invoke-guarded.ts",
    find: "const permissionRefusal = permission?.beforeCall(tool.key, rawArgs);",
    replace: "const permissionRefusal = permission ? null : undefined;",
    catchers: ["gate"],
  },
  {
    id: "delegate-keeps-media",
    proves: "a delegated run can bind the paid tools, with nobody to press Run",
    file: "packages/core/src/agents/delegation.ts",
    find: '  "image_generate",\n  "video_generate",\n]);',
    replace: "]);",
    catchers: ["gate"],
  },
  {
    id: "gate-built-per-closure",
    proves: "the gate is built somewhere other than once, directly in the runtime's stream (a rebuild per attempt would hand a grant out again)",
    file: "packages/core/src/runtime/ai-sdk-runtime.ts",
    find: "const mediaPermission = createMediaPermission(input.mediaPermission, hostMediaModel);",
    replace: "const mediaPermission = (() => createMediaPermission(input.mediaPermission, hostMediaModel))();",
    catchers: ["reach"],
  },
  {
    id: "body-turns-gate-off",
    proves: "the request body can switch the gate off",
    file: "packages/host/src/paid-media-body.ts",
    find: "  return { ask: true, grants };",
    replace: "  return { ask: false, grants };",
    catchers: ["reach"],
  },
  {
    id: "body-grants-uncapped",
    proves: "a hand-made body carries any number of grants",
    file: "packages/host/src/paid-media-body.ts",
    find: "    if (grants.length >= PAID_MEDIA_GRANTS_MAX) {",
    replace: "    if (false) {",
    catchers: ["reach"],
  },
  {
    id: "run-without-gate",
    proves: "the chat run starts without the gate",
    file: "packages/host/src/runs.ts",
    find: "            history,\n            mediaPermission,\n",
    replace: "            history,\n",
    catchers: ["reach"],
  },
  {
    id: "new-run-entry",
    proves: "a new way to start a run (a channel, a routine) appears with no word on how it holds the gate",
    create: "packages/host/src/zz-scratch-run-entry.ts",
    content: "export const scratch = (runtime: { execute(input: unknown): unknown }) => runtime.execute({ bindings: [] });\n",
    catchers: ["reach"],
  },
];

const ANSI = /\u001b\[[0-9;]*m/g;

function vitestEntry(dir) {
  const entry = path.join(repoRoot, dir, "node_modules", "vitest", "vitest.mjs");
  return existsSync(entry) ? entry : null;
}

const propertyOnly = process.argv.includes("--property-only");

function runCheck(name) {
  const check = CHECKS[name];
  const entry = vitestEntry(check.dir);
  if (!entry) {
    return { name, ok: false, reason: `vitest is not installed in ${check.dir}; run pnpm install`, failed: [], passed: 0 };
  }
  const files = propertyOnly ? check.files.slice(0, 1) : check.files;
  const result = spawnSync(process.execPath, [entry, "run", ...files], {
    cwd: path.join(repoRoot, check.dir),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.replace(ANSI, "");
  const summary = /Tests\s+(?:(\d+) failed \| )?(\d+) passed/.exec(text);
  const failedCount = Number(/Tests\s+(\d+) failed/.exec(text)?.[1] ?? 0);
  const passed = summary ? Number(summary[2]) : 0;
  const failed = [...text.matchAll(/^\s*(?:×|✗|FAIL)\s+(.+)$/gm)].map((match) => (match[1] ?? "").trim()).slice(0, 4);
  const failedFiles = [...new Set([...text.matchAll(/^\s*FAIL\s+(\S+\.test\.ts)/gm)].map((match) => path.basename(match[1] ?? "")))];
  const ok = result.status === 0 && passed > 0 && failedCount === 0;
  let reason = "";
  if (!ok) {
    reason =
      passed === 0 && failedCount === 0
        ? "no test ran (vitest crashed or found nothing)"
        : failedCount > 0
          ? `${failedCount} test(s) failed`
          : `exit code ${result.status}`;
  }
  return { name, ok, reason, failed, failedFiles, failedCount, passed, text };
}

function show(result) {
  const mark = result.ok ? "pass" : "FAIL";
  console.log(`${mark}  ${result.name}: ${result.ok ? `${result.passed} tests` : result.reason}`);
  if (!result.ok) {
    for (const line of result.failed) console.log(`        ${line}`);
  }
}

function applyBreak(item) {
  if (item.create) {
    const target = path.join(repoRoot, item.create);
    if (existsSync(target)) throw new Error(`${item.create} already exists`);
    writeFileSync(target, item.content);
    return () => rmSync(target, { force: true });
  }
  const target = path.join(repoRoot, item.file);
  const original = readFileSync(target, "utf8");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const fitLineEndings = (text) => text.replace(/\r?\n/g, eol);
  const find = fitLineEndings(item.find);
  const replacement = fitLineEndings(item.replace);
  const count = original.split(find).length - 1;
  if (count !== 1) {
    throw new Error(
      `${item.file}: the text for break "${item.id}" occurs ${count} times, not once. The code changed shape: update BREAKS in this script, then run again.`,
    );
  }
  writeFileSync(target, original.replace(find, () => replacement));
  return () => writeFileSync(target, original);
}

function teeth() {
  const restores = [];
  const restoreAll = () => {
    while (restores.length > 0) restores.pop()();
  };
  process.on("exit", restoreAll);
  process.on("SIGINT", () => {
    restoreAll();
    process.exit(130);
  });
  const rows = [];
  for (const item of BREAKS) {
    let restore;
    try {
      restore = applyBreak(item);
    } catch (error) {
      rows.push({ item, verdict: "NOT RUN", detail: error.message });
      continue;
    }
    restores.push(restore);
    const outcomes = item.catchers.map(runCheck);
    restoreAll();
    const caught = outcomes.every((outcome) => !outcome.ok && outcome.failedCount > 0);
    const detail = outcomes
      .map((outcome) =>
        outcome.failedCount > 0
          ? `${outcome.name} went red in ${outcome.failedFiles.join(", ") || "a test file"}: ${outcome.failed[0] ?? "a test failed"}`
          : `${outcome.name} did NOT fail (${outcome.ok ? "still green" : outcome.reason})`,
      )
      .join("; ");
    rows.push({ item, verdict: caught ? "caught" : "MISSED", detail });
  }
  console.log("\nScratch breaks (each applied to the real code, then put back):");
  for (const { item, verdict, detail } of rows) {
    console.log(`${verdict.padEnd(8)} ${item.id}: ${item.proves}\n         ${detail}`);
  }
  return rows.every((row) => row.verdict === "caught");
}

const wantTeeth = process.argv.includes("--teeth");
const only = process.argv.filter((arg, index, all) => all[index - 1] === "--only");
const names = only.length > 0 ? only : Object.keys(CHECKS);

console.log(`Paid media gate (SR-167), checks: ${names.join(", ")}`);
const results = names.map(runCheck);
for (const result of results) show(result);
let ok = results.every((result) => result.ok);

if (wantTeeth) {
  if (!ok) {
    console.log("\nThe checks are red before any break, so --teeth would prove nothing. Read the failure above first.");
  } else {
    const allCaught = teeth();
    const after = Object.keys(CHECKS).map(runCheck);
    console.log("\nAfter putting every file back:");
    for (const result of after) show(result);
    ok = allCaught && after.every((result) => result.ok);
  }
}

process.exit(ok ? 0 : 1);
