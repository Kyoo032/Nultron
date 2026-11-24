import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkFormalSync, parseArgs, parseFormalSkill } from "./formal-sync-check.mjs";
import { check as checkSettle, formatJavaSpawnError, runMain as runSettleMain } from "./formal/chat-run-settle.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORMAL_SYNC_SCRIPT = path.join(REPO_ROOT, "scripts", "formal-sync-check.mjs");

const git = (cwd, args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("formatJavaSpawnError explains missing Java cleanly", () => {
  const msg = formatJavaSpawnError(Object.assign(new Error("spawn java ENOENT"), { code: "ENOENT" }));
  assert.match(msg, /Java 11\+/);
  assert.match(msg, /ENOENT/);
  assert.match(msg, /nix develop/);
});

test("parseArgs parses --root, --base, --advisory, and --json", () => {
  const args = parseArgs(["--root", "/tmp/x", "--base", "origin/main", "--advisory", "--json"]);
  assert.equal(args.root, "/tmp/x");
  assert.equal(args.base, "origin/main");
  assert.equal(args.advisory, true);
  assert.equal(args.json, true);
  assert.throws(() => parseArgs(["--unknown"]), /unknown argument/);
});

test("parseFormalSkill parses Coverage record tables and ignores non-formal skills", () => {
  assert.equal(parseFormalSkill("# Normal skill\nNothing to sync.\n"), null);

  const parsed = parseFormalSkill(
    [
      "## Coverage record",
      "| Code | What |",
      "|---|---|",
      "| `packages/core/src/runtime/media-permission.ts` | Gate |",
      "| `packages/core/src/harness/modes/*` | Specs |",
      "",
      "**Sync commit: `8871ffdf`**",
    ].join("\n"),
  );
  assert.equal(parsed?.syncCommit, "8871ffdf");
  assert.deepEqual(parsed?.coveredPaths, [
    "packages/core/src/runtime/media-permission.ts",
    "packages/core/src/harness/modes",
  ]);
});

test("parseFormalSkill parses Coverage: prose lines", () => {
  const parsed = parseFormalSkill(
    [
      "## Keep it in step with the code",
      "Coverage: `packages/host/src/runs.ts`, `packages/host/src/threads.ts`, and `packages/db/src/client.ts`.",
      "",
      "Sync commit: `8871ffdf` (`main`, 2026-11-23).",
    ].join("\n"),
  );
  assert.equal(parsed?.syncCommit, "8871ffdf");
  assert.deepEqual(parsed?.coveredPaths, [
    "packages/host/src/runs.ts",
    "packages/host/src/threads.ts",
    "packages/db/src/client.ts",
  ]);
});

test("checkFormalSync distinguishes in-sync changes from covered-file drift", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "formal-sync-test-"));
  try {
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    mkdirSync(path.join(repo, "packages", "host", "src"), { recursive: true });
    mkdirSync(path.join(repo, ".cursor", "skills", "sample-check"), { recursive: true });
    writeFileSync(path.join(repo, "packages", "host", "src", "runs.ts"), "export const a = 1;\n");
    writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "initial"]);
    const baseSha = git(repo, ["rev-parse", "--short", "HEAD"]);

    writeFileSync(
      path.join(repo, ".cursor", "skills", "sample-check", "SKILL.md"),
      `Coverage: \`packages/host/src/runs.ts\`.\nSync commit: \`${baseSha}\`\n`,
    );
    // Commit touching an uncovered file stays in sync.
    writeFileSync(path.join(repo, "README.md"), "hello world\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "docs update"]);

    const clean = checkFormalSync({ root: repo });
    assert.equal(clean.length, 1);
    assert.equal(clean[0]?.status, "in_sync");

    // Commit touching covered code marks the check drifted.
    writeFileSync(path.join(repo, "packages", "host", "src", "runs.ts"), "export const a = 2;\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "modify runs"]);

    const drifted = checkFormalSync({ root: repo });
    assert.equal(drifted[0]?.status, "drifted");
    assert.equal(drifted[0]?.commits.length, 1);
    assert.match(drifted[0]?.commits[0] ?? "", /modify runs/);
    assert.deepEqual(drifted[0]?.changedPaths, ["packages/host/src/runs.ts"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("verify-paid-media-gate formal:sync-check fails and names each paid-media caller path when it drifts", () => {
  const realSkill = readFileSync(
    path.join(REPO_ROOT, ".cursor", "skills", "verify-paid-media-gate", "SKILL.md"),
    "utf8",
  );
  const callerPaths = [
    "packages/core/src/agents/virtual-agents.ts",
    "packages/host/src/register-tools.ts",
    "packages/host/src/voice/ask-tools.ts",
  ];

  for (const targetPath of callerPaths) {
    const repo = mkdtempSync(path.join(tmpdir(), "formal-sync-paid-media-"));
    try {
      git(repo, ["init", "-q"]);
      git(repo, ["config", "user.email", "test@example.com"]);
      git(repo, ["config", "user.name", "Test"]);
      for (const rel of callerPaths) {
        const full = path.join(repo, ...rel.split("/"));
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, "export const v = 1;\n", "utf8");
      }
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-qm", "baseline"]);
      const baseSha = git(repo, ["rev-parse", "--short", "HEAD"]);

      const skillPath = path.join(repo, ".cursor", "skills", "verify-paid-media-gate", "SKILL.md");
      mkdirSync(path.dirname(skillPath), { recursive: true });
      writeFileSync(
        skillPath,
        realSkill.replace(/\*\*Sync commit:\s*`[0-9a-f]{7,40}`\*\*/i, `**Sync commit: \`${baseSha}\`**`),
        "utf8",
      );
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-qm", "record skill baseline"]);

      const before = checkFormalSync({ root: repo });
      assert.equal(before[0]?.status, "in_sync", `${targetPath} should start in sync`);

      const fullTarget = path.join(repo, ...targetPath.split("/"));
      writeFileSync(fullTarget, "export const v = 2;\n", "utf8");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-qm", `drift in ${targetPath}`]);

      const after = checkFormalSync({ root: repo });
      assert.equal(after[0]?.status, "drifted", `${targetPath} must be flagged as drifted`);
      assert.deepEqual(after[0]?.changedPaths, [targetPath]);

      const cli = spawnSync(process.execPath, [FORMAL_SYNC_SCRIPT, "--root", repo], { encoding: "utf8" });
      assert.equal(cli.status, 1, `expected CLI failure for ${targetPath}: ${cli.stdout}${cli.stderr}`);
      assert.match(cli.stdout, /FAIL\s+verify-paid-media-gate/);
      assert.ok(cli.stdout.includes(targetPath), `CLI output must name ${targetPath}, got:\n${cli.stdout}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test("chat-run-settle cleans up its staging directory when Java spawn fails and exits 3 with diagnostic", () => {
  const scratchTmp = mkdtempSync(path.join(tmpdir(), "chat-run-settle-leak-test-"));
  try {
    const errors = [];
    const logs = [];
    const exitCode = runSettleMain([], {
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
      jarPath: () => path.join(scratchTmp, "fake-tla2tools.jar"),
      check: (jar, values, invariants, properties) =>
        checkSettle(jar, values, invariants, properties, {
          tmpRoot: scratchTmp,
          spawn: () => ({ error: Object.assign(new Error("spawn java ENOENT"), { code: "ENOENT" }) }),
        }),
    });
    assert.equal(exitCode, 3);
    assert.match(errors.join("\n"), /Java 11\+ is required to run TLC/);
    assert.match(errors.join("\n"), /ENOENT/);
    assert.deepEqual(
      readdirSync(scratchTmp).filter((name) => name.startsWith("chat-run-settle-")),
      [],
      "staging directory leaked after Java spawn failure",
    );

    // Also verify with a real spawnSync against an empty PATH (no java executable found).
    const realErrors = [];
    const realExit = runSettleMain([], {
      log: () => {},
      error: (line) => realErrors.push(line),
      jarPath: () => path.join(scratchTmp, "fake-tla2tools.jar"),
      check: (jar, values, invariants, properties) =>
        checkSettle(jar, values, invariants, properties, {
          tmpRoot: scratchTmp,
          env: { PATH: "" },
        }),
    });
    assert.equal(realExit, 3);
    assert.match(realErrors.join("\n"), /Java 11\+ is required to run TLC/);
    assert.deepEqual(
      readdirSync(scratchTmp).filter((name) => name.startsWith("chat-run-settle-")),
      [],
      "staging directory leaked after real spawnSync failure",
    );
  } finally {
    rmSync(scratchTmp, { recursive: true, force: true });
  }
});
