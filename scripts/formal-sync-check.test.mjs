import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkFormalSync, parseArgs, parseFormalSkill } from "./formal-sync-check.mjs";
import { formatJavaSpawnError } from "./formal/chat-run-settle.mjs";

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
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
