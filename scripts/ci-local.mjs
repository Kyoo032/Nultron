#!/usr/bin/env node
/**
 * Local CI. Since 2026-09-24 this is the only CI the repo has: Rizky dropped GitHub Actions, so
 * nothing checks a change unless someone runs this. Run it before any PR, merge or pack, and paste
 * the summary table it prints into the PR.
 *
 * Usage (repo root):
 *   node scripts/ci-local.mjs                 lint, tsc, unit tests, tooling tests, audit, doc checks
 *   node scripts/ci-local.mjs --install       also check `pnpm install --frozen-lockfile` first
 *   node scripts/ci-local.mjs --e2e           also run the Playwright stub suite (slow; off by default)
 *   node scripts/ci-local.mjs --only tsc --only lint     run only these steps (group or full name)
 *   node scripts/ci-local.mjs --skip audit              run everything but these
 *
 * Every step runs even when an earlier one failed, so one run shows the whole picture. Exit code is
 * 1 when any REQUIRED step failed; ADVISORY steps are reported and never fail the run. Full output
 * of each step lands in `.ci-local/<timestamp>/<step>.log`, plus `summary.md` for the PR.
 *
 * A vitest step passes only when its log carries the `Tests  N passed` summary (N > 0), not merely
 * exit code 0: vitest exits 0 after "No test files found" when a global setup dies, and an empty run
 * is not a green one. `summary.md` lists the reason under every step that did not pass.
 *
 * Children are spawned with shell:false through `process.execPath` and each tool's JS entry, because
 * the extensionless `node_modules/.bin` shims cannot be exec'd on Windows. pnpm is resolved to its
 * `pnpm.cjs` (npm_execpath, CI_LOCAL_PNPM, or the npx cache); only when none is found does the
 * script fall back to `npx --yes pnpm@<version>` through a shell, with fixed arguments.
 *
 * What moved here from the deleted workflows: ci.yml (install, lint, unit tests, `node --test
 * scripts/*.test.mjs`, the deployed-closure audit gate, the advisory workspace audit) and e2e.yml
 * (Playwright with AGENTFORGE_RUNTIME=stub). desktop-mac.yml was a release build, not a check; the
 * mac build is `pnpm desktop:build:mac:docker` (apps/desktop/platform/macos/AGENTS.md).
 *
 * Required steps added for the lane rules: `where-am-i` (scripts/where-am-i.mjs, first; the folder must match its branch)
 * and `lane-guard` (scripts/lane-guard.mjs without --strict; never-promote paths, protected files without a `Lanes:` line,
 * brand literals in shared code). `--only where` or `--only lanes` runs them; `pnpm where` and `pnpm lane-guard` print
 * the lines on their own.
 *
 * Advisory steps (reported as `warn`, never fail the run): audit:workspace, maps:check, lane-guard:map (the map page rule,
 * `--strict`), edit:starters:check, videos:examples:check, sandbox:manifest.
 */

import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STEP_TIMEOUT_MS = 30 * 60 * 1000;
/** Steps that only run when asked for, by flag or by `--only`. */
const OPT_IN = { install: "--install", e2e: "--e2e" };
const SANDBOX_NOT_BUILT = "sandbox runtime not built; run npx pnpm@9.15.9 sandbox:build";

// ---------------------------------------------------------------------------------------------
// Pure helpers (tested in ci-local.test.mjs)
// ---------------------------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = { only: [], skip: [], e2e: false, install: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--e2e") args.e2e = true;
    else if (flag === "--install") args.install = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else if (flag === "--only" || flag === "--skip") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`${flag} needs a step name`);
      args[flag.slice(2)].push(value);
      i += 1;
    } else if (flag.startsWith("--only=") || flag.startsWith("--skip=")) {
      const [key, value] = flag.slice(2).split("=");
      if (!value) throw new Error(`--${key} needs a step name`);
      args[key].push(value);
    } else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

const matches = (step, names) => names.some((n) => n === step.group || n === step.name);

/** Which of `steps` run for `args`. Opt-in groups run when their flag is set or `--only` names them. */
export function selectSteps(steps, args) {
  return steps.filter((step) => {
    if (matches(step, args.skip)) return false;
    if (args.only.length > 0 && !matches(step, args.only)) return false;
    if (step.group === "install") return args.install || matches(step, args.only);
    if (step.group === "e2e") return args.e2e || matches(step, args.only);
    return true;
  });
}

export function exitCodeFor(results) {
  return results.some((r) => r.required && r.status !== "pass") ? 1 : 0;
}

export function formatDuration(ms) {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/**
 * A markdown table, so the same text reads in a terminal and pastes into a PR. A step that did not
 * pass says why in a short list under the table, so the paste is enough to tell "a test failed" from
 * "no test ran".
 */
export function formatSummary(results) {
  const rows = results.map((r) => {
    const status = r.status === "pass" ? "pass" : r.required ? `FAIL` : `warn (advisory)`;
    return `| ${r.name} | ${status} | ${formatDuration(r.durationMs)} |`;
  });
  const reasons = results.filter((r) => r.status !== "pass" && r.reason).map((r) => `- ${r.name}: ${r.reason}`);
  const failed = results.filter((r) => r.required && r.status !== "pass").length;
  const warned = results.filter((r) => !r.required && r.status !== "pass").length;
  const verdict = failed > 0 ? `FAIL: ${failed} required step(s) failed` : "OK: every required step passed";
  return [
    "| step | status | duration |",
    "| --- | --- | --- |",
    ...rows,
    "",
    ...(reasons.length > 0 ? ["Reasons:", ...reasons, ""] : []),
    `${verdict}${warned > 0 ? `, ${warned} advisory warning(s)` : ""}.`,
  ].join("\n");
}

/**
 * ANSI CSI sequences (colour, cursor). The ESC byte comes from `String.fromCharCode`: a raw control
 * byte in the source would make git treat this file as binary, and biome refuses one in a regex literal.
 */
const ANSI_CSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");

export function stripAnsi(text) {
  return text.replace(ANSI_CSI, "");
}

/**
 * vitest's closing line, e.g. `Tests  2795 passed | 1 skipped (2796)` or `Tests  1 failed | 40 passed (41)`.
 * Anchored to the start of a line so a test title that merely begins with the word cannot match, and
 * `Test Files` (which prints even when every file was empty) is not it.
 */
const VITEST_SUMMARY = /^[ \t]*Tests[ \t]+(?:\d+[ \t]+[a-z]+[ \t]*\|[ \t]*)*(\d+)[ \t]+passed\b/m;

const NO_TESTS_REASON =
  "vitest printed no `Tests N passed` summary line, so no tests ran (it can exit 0 after finding no test files or dying in global setup)";

/**
 * Did this vitest log run a test? Exit code 0 only says the process ended: on 2026-10-01 the portal
 * suite, run under an admin token, could not start its embedded Postgres, logged "No test files found"
 * and "Unhandled Error", exited 0, and was reported as a pass. A passing run has to say so.
 */
export function checkVitestLog(logText) {
  const match = VITEST_SUMMARY.exec(stripAnsi(logText ?? ""));
  const passed = match ? Number(match[1]) : 0;
  return passed > 0 ? { ok: true, passed } : { ok: false, passed: 0, reason: NO_TESTS_REASON };
}

/**
 * The verdict for one step: `exitCodes` are its commands' exit codes in order, `logText` is its log.
 * A step with no commands fails (its `note` says why, e.g. "vitest not installed"); a non-zero exit
 * fails; and a `requireTestSummary` step that exited 0 still fails without a vitest summary line.
 */
export function judgeStep({ exitCodes, note, requireTestSummary = false, logText = "" }) {
  if (exitCodes.length === 0) return { status: "fail", reason: note ?? "no command to run" };
  const bad = exitCodes.find((code) => code !== 0);
  if (bad !== undefined) return { status: "fail", reason: `exit code ${bad}` };
  if (requireTestSummary) {
    const verdict = checkVitestLog(logText);
    if (!verdict.ok) return { status: "fail", reason: verdict.reason };
  }
  return { status: "pass" };
}

/** `packages: ["apps/*", "packages/*"]` → the directories under them that hold a package.json. */
export function workspaceGlobs(yamlText) {
  return [...yamlText.matchAll(/^\s*-\s*["']?([^"'\s#]+)["']?/gm)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------------------------

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function workspaces() {
  const globs = workspaceGlobs(readFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8"));
  const dirs = [];
  for (const glob of globs) {
    if (!glob.endsWith("/*")) {
      if (existsSync(path.join(repoRoot, glob, "package.json"))) dirs.push(glob);
      continue;
    }
    const base = glob.slice(0, -2);
    for (const entry of readdirSync(path.join(repoRoot, base), { withFileTypes: true })) {
      const rel = `${base}/${entry.name}`;
      if (entry.isDirectory() && existsSync(path.join(repoRoot, rel, "package.json"))) dirs.push(rel);
    }
  }
  return dirs.sort().map((dir) => ({ dir, pkg: readJson(path.join(repoRoot, dir, "package.json")) }));
}

/** A package's own copy of a tool's JS entry, else the root's. */
function toolEntry(dir, relative) {
  for (const base of [path.join(repoRoot, dir), repoRoot]) {
    const file = path.join(base, "node_modules", relative);
    if (existsSync(file)) return file;
  }
  return null;
}

function npxCacheDirs(env) {
  const roots = [env.npm_config_cache, path.join(env.LOCALAPPDATA ?? "", "npm-cache"), path.join(os.homedir(), ".npm")];
  return roots
    .filter(Boolean)
    .map((r) => path.join(r, "_npx"))
    .filter((d) => existsSync(d));
}

/** The pnpm.cjs to run with process.execPath, or null. */
function findPnpmEntry(version, env = process.env) {
  if (env.CI_LOCAL_PNPM && existsSync(env.CI_LOCAL_PNPM)) return env.CI_LOCAL_PNPM;
  if (env.npm_execpath && /pnpm\.c?js$/.test(env.npm_execpath) && existsSync(env.npm_execpath)) return env.npm_execpath;
  for (const cache of npxCacheDirs(env)) {
    for (const hash of readdirSync(cache)) {
      const pkgDir = path.join(cache, hash, "node_modules", "pnpm");
      try {
        if (readJson(path.join(pkgDir, "package.json")).version === version) {
          const entry = path.join(pkgDir, "bin", "pnpm.cjs");
          if (existsSync(entry)) return entry;
        }
      } catch {
        // not a pnpm install; keep looking
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

function buildSteps(ctx) {
  const node = (args, opts = {}) => ({ cmd: process.execPath, args, cwd: opts.cwd ?? repoRoot, ...opts });
  const pnpm = (args, opts = {}) =>
    ctx.pnpmEntry
      ? node([ctx.pnpmEntry, ...args], opts)
      : {
          cmd: "npx",
          args: ["--yes", `pnpm@${ctx.pnpmVersion}`, ...args],
          shell: process.platform === "win32",
          cwd: repoRoot,
          ...opts,
        };
  const steps = [];
  const add = (group, name, required, commands, note, requireTestSummary = false) =>
    steps.push({ group, name, required, commands, note, requireTestSummary });

  // First, so a tester folder on the wrong branch (or main checked out in the tester folder) fails before anything runs.
  // It only reads git and prints the row; it refuses on mismatch and skips when lanes.json or docs/internal is absent.
  add("where", "where-am-i", true, [node(["scripts/where-am-i.mjs"])]);
  add("install", "install", true, [pnpm(["install", "--frozen-lockfile"])]);

  const lint = (ctx.rootPkg.scripts?.lint ?? "biome check .").split(/\s+/);
  const biome = toolEntry(".", "@biomejs/biome/bin/biome");
  add("lint", "lint", true, biome ? [node([biome, ...lint.slice(1)])] : [], biome ? undefined : "biome not installed");

  for (const { dir } of ctx.workspaces) {
    if (!existsSync(path.join(repoRoot, dir, "tsconfig.json"))) continue;
    const tsc = toolEntry(dir, "typescript/bin/tsc");
    add(
      "tsc",
      `tsc:${dir}`,
      true,
      tsc ? [node([tsc, "--noEmit", "-p", "tsconfig.json"], { cwd: path.join(repoRoot, dir) })] : [],
      tsc ? undefined : "typescript not installed",
    );
  }

  // One package at a time, each with its own data dir: packages in parallel race one SQLite file.
  for (const { dir, pkg } of ctx.workspaces) {
    if (!/^vitest\b/.test(pkg.scripts?.test ?? "")) continue;
    const vitest = toolEntry(dir, "vitest/vitest.mjs");
    // `requireTestSummary`: exit 0 is not enough, the log must show `Tests N passed` (see `checkVitestLog`).
    add(
      "test",
      `test:${dir}`,
      true,
      vitest ? [node([vitest, "run"], { cwd: path.join(repoRoot, dir), freshDataDir: true })] : [],
      vitest ? undefined : "vitest not installed",
      true,
    );
  }

  const scriptTests = readdirSync(path.join(repoRoot, "scripts"))
    .filter((f) => f.endsWith(".test.mjs"))
    .sort();
  add("node-test", "node-test:scripts", true, [
    node(["--test", ...scriptTests.map((f) => path.join("scripts", f))], { freshDataDir: true }),
  ]);

  const desktop = ctx.workspaces.find((w) => w.pkg.name === "@agentforge/desktop");
  const desktopTest = desktop?.pkg.scripts?.test;
  if (desktopTest) {
    const parts = desktopTest.split("&&").map((p) => p.trim().split(/\s+/));
    const cwd = path.join(repoRoot, desktop.dir);
    const commands = parts.every((p) => p[0] === "node" && p.length >= 2)
      ? parts.map((p) => node(p.slice(1), { cwd }))
      : [pnpm(["--filter", "@agentforge/desktop", "test"])];
    add("node-test", "node-test:apps/desktop", true, commands);
  }

  // ci.yml's audit job: the hosted-image closure gates, the whole workspace is advisory.
  const closure = path.join(ctx.logDir, "audit-closure.json");
  const audit = path.join(ctx.logDir, "audit.json");
  add("audit", "audit:deployed", true, [
    // Same flags as LIST_ARGS in scripts/audit-deployed.mjs: the Dockerfile's `prod` stage closure.
    pnpm(["list", "--filter", "@agentforge/web...", "--prod", "--depth", "Infinity", "--json"], {
      stdoutFile: closure,
    }),
    pnpm(["audit", "--json"], { stdoutFile: audit, ignoreExit: true }),
    node(["scripts/audit-deployed.mjs", "--level", "high", "--audit", audit, "--closure", closure]),
  ]);
  add("audit", "audit:workspace", false, [pnpm(["audit", "--audit-level", "moderate"])]);

  // Doc and media checks. Never in the old CI; advisory because the media they check is gitignored.
  add("maps", "maps:check", false, [node(["scripts/map-rot.mjs"])]);
  // Formal verification drift check. Advisory here so unrelated PRs see a reminder when covered code moved.
  add("formal", "formal:sync-check", false, [node(["scripts/formal-sync-check.mjs"])]);
  // Change guard (lanes.json). Required: a path that never reaches main, a protected file without a `Lanes:` line, a new
  // brand literal in shared code. Those exit 1 without `--strict`. It skips itself when lanes.json or docs/internal is
  // absent or the range origin/main...HEAD cannot be resolved.
  add("lanes", "lane-guard", true, [node(["scripts/lane-guard.mjs"])]);
  // Advisory: a code change without its map page. `--strict` makes that warning show as `warn` in the table (the step is
  // advisory, so it never fails the run).
  add("lanes", "lane-guard:map", false, [node(["scripts/lane-guard.mjs", "--strict"])]);
  add("media", "edit:starters:check", false, [node(["scripts/edit-starters.mjs", "--check"])]);
  add("media", "videos:examples:check", false, [node(["scripts/video-examples.mjs", "--check"])]);

  // The built code-sandbox folder (`pnpm sandbox:build`, gitignored): when it exists, every file in it must still
  // hash to its MANIFEST.json. Advisory because the folder is built, never committed; absent means nothing to check.
  add("sandbox", "sandbox:manifest", false, [node(["scripts/build-sandbox-runtime.mjs", "--verify", "--if-present"])]);

  // The real engines. `sandbox:manifest` only proves the built folder is intact; `test:packages/host` skips
  // sandbox.integration.test.ts without AGENTFORGE_SANDBOX_DIR, so on their own CI stays green while Pyodide and
  // QuickJS never run. When the folder is built this step runs that file against it (Python, JavaScript, the escape
  // battery, the memory cap and the wall-clock kill) and is REQUIRED; vitest must report passed tests, so an all-skipped
  // file fails. When the folder is not built there is nothing to run, so it passes and says how to build it.
  const sandboxDir = path.join(repoRoot, "vendor", "sandbox-runtime");
  if (existsSync(path.join(sandboxDir, "MANIFEST.json"))) {
    const hostVitest = toolEntry("packages/host", "vitest/vitest.mjs");
    add(
      "sandbox",
      "sandbox:integration",
      true,
      hostVitest
        ? [
            node([hostVitest, "run", "src/code-runner/sandbox.integration.test.ts"], {
              cwd: path.join(repoRoot, "packages/host"),
              env: { AGENTFORGE_SANDBOX_DIR: sandboxDir },
              freshDataDir: true,
            }),
          ]
        : [],
      hostVitest ? undefined : "vitest not installed",
      true,
    );
  } else {
    add("sandbox", "sandbox:integration", true, [node(["-e", `console.log(${JSON.stringify(SANDBOX_NOT_BUILT)})`])]);
    steps[steps.length - 1].passNote = SANDBOX_NOT_BUILT;
  }

  // e2e.yml. CI=1 turns off reuseExistingServer, so the suite never drives whatever answers on :3000
  // (on this desk that is Rizky's live webdev). A pnpm shim on PATH lets its `pnpm dev` resolve.
  const playwright = toolEntry("apps/web", "@playwright/test/cli.js");
  add(
    "e2e",
    "e2e:playwright",
    true,
    playwright
      ? [
          node([playwright, "test"], {
            cwd: path.join(repoRoot, "apps/web"),
            env: { AGENTFORGE_RUNTIME: "stub", CI: "1" },
            pnpmShim: true,
          }),
        ]
      : [],
    playwright ? undefined : "@playwright/test not installed",
  );
  return steps;
}

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

function writePnpmShim(ctx) {
  const bin = path.join(ctx.logDir, "bin");
  mkdirSync(bin, { recursive: true });
  const target = ctx.pnpmEntry ? `"${process.execPath}" "${ctx.pnpmEntry}"` : `npx --yes pnpm@${ctx.pnpmVersion}`;
  writeFileSync(path.join(bin, "pnpm.cmd"), `@echo off\r\n${target} %*\r\n`);
  writeFileSync(path.join(bin, "pnpm"), `#!/bin/sh\nexec ${target} "$@"\n`, { mode: 0o755 });
  return bin;
}

function runCommand(command, log, ctx) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...(command.env ?? {}) };
    let dataDir = null;
    if (command.freshDataDir) {
      dataDir = mkdtempSync(path.join(os.tmpdir(), "agentforge-ci-"));
      env.AGENTFORGE_DATA_DIR = dataDir;
    }
    if (command.pnpmShim) {
      const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
      env[key] = `${writePnpmShim(ctx)}${path.delimiter}${env[key] ?? ""}`;
    }
    log.write(
      `\n$ ${[command.cmd, ...command.args].join(" ")}\n  cwd: ${command.cwd}${dataDir ? `\n  AGENTFORGE_DATA_DIR: ${dataDir}` : ""}\n\n`,
    );
    const out = command.stdoutFile ? createWriteStream(command.stdoutFile) : null;
    const child = spawn(command.cmd, command.args, {
      cwd: command.cwd,
      env,
      shell: command.shell ?? false,
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      log.write(`\n[ci-local] timed out after ${formatDuration(STEP_TIMEOUT_MS)}, killing\n`);
      child.kill();
    }, STEP_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (out ? out.write(chunk) : log.write(chunk)));
    child.stderr.on("data", (chunk) => log.write(chunk));
    const finish = (code) => {
      clearTimeout(timer);
      out?.end();
      if (dataDir) {
        try {
          rmSync(dataDir, { recursive: true, force: true });
        } catch (error) {
          log.write(`\n[ci-local] could not remove ${dataDir}: ${error.message}\n`);
        }
      }
      log.write(`\n[ci-local] exit ${code}\n`);
      resolve(command.ignoreExit ? 0 : code);
    };
    child.on("error", (error) => {
      log.write(`\n[ci-local] spawn failed: ${error.message}\n`);
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}

async function runStep(step, ctx) {
  const logFile = path.join(ctx.logDir, `${step.name.replace(/[/:\\]/g, "_")}.log`);
  const log = createWriteStream(logFile);
  const started = Date.now();
  const exitCodes = [];
  if (step.note) log.write(`[ci-local] ${step.note}\n`);
  for (const command of step.commands) {
    exitCodes.push(await runCommand(command, log, ctx));
  }
  await new Promise((resolve) => log.end(resolve));
  const verdict = judgeStep({
    exitCodes,
    note: step.note,
    requireTestSummary: step.requireTestSummary,
    logText: step.requireTestSummary ? readFileSync(logFile, "utf8") : "",
  });
  return {
    name: step.name,
    required: step.required,
    status: verdict.status,
    reason: verdict.reason,
    durationMs: Date.now() - started,
    logFile,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootPkg = readJson(path.join(repoRoot, "package.json"));
  const pnpmVersion = (rootPkg.packageManager ?? "pnpm@9.15.9").split("@")[1];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logDir = path.join(repoRoot, ".ci-local", stamp);
  const ctx = { rootPkg, pnpmVersion, pnpmEntry: findPnpmEntry(pnpmVersion), logDir, workspaces: workspaces() };
  const all = buildSteps(ctx);

  if (args.help) {
    console.log(
      `Steps (group → name):\n${all.map((s) => `  ${s.group.padEnd(10)} ${s.name}${s.required ? "" : "  (advisory)"}${OPT_IN[s.group] ? `  (only with ${OPT_IN[s.group]})` : ""}`).join("\n")}`,
    );
    return 0;
  }
  const selected = selectSteps(all, args);
  if (selected.length === 0) {
    console.error(`No step matches. Groups: ${[...new Set(all.map((s) => s.group))].join(", ")}`);
    return 1;
  }
  mkdirSync(logDir, { recursive: true });
  console.log(`ci-local: ${selected.length} step(s), logs in ${path.relative(repoRoot, logDir)}`);
  console.log(`pnpm: ${ctx.pnpmEntry ?? `npx pnpm@${pnpmVersion} (fallback)`}\n`);

  const results = [];
  for (const step of selected) {
    const result = await runStep(step, ctx);
    results.push(result);
    const mark = result.status === "pass" ? "pass" : result.required ? "FAIL" : "warn";
    console.log(
      `${mark.padEnd(4)}  ${step.name.padEnd(34)} ${formatDuration(result.durationMs).padStart(9)}${result.status === "pass" ? "" : `  → ${path.relative(repoRoot, result.logFile)}${result.reason ? ` (${result.reason})` : ""}`}`,
    );
    if (result.status === "pass" && step.passNote) console.log(`      note: ${step.passNote}`);
  }

  const summary = formatSummary(results);
  writeFileSync(path.join(logDir, "summary.md"), `${summary}\n`);
  console.log(`\n${summary}`);
  return exitCodeFor(results);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`ci-local: ${error.message}`);
      process.exit(1);
    },
  );
}
