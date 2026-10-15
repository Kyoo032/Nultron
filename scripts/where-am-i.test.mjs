import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyPlace, folderKind, releaseProblem, TESTER_BRANCH } from "./where-am-i.mjs";

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "where-am-i.mjs");
const MAIN_FOLDER = "C:/Users/rizky/agentforge";
const WORKTREE = "C:/Users/rizky/agentforge-guardrails";
const TESTER = "C:/Users/rizky/agentforge-chat";
const HYP = "C:/Users/rizky/hypey/app";

test("folderKind names each row by its folder, case-insensitively and across both slash styles", () => {
  assert.equal(folderKind(MAIN_FOLDER), "main");
  assert.equal(folderKind(WORKTREE), "main");
  assert.equal(folderKind("C:\\Users\\rizky\\agentforge-tier-neutral"), "main");
  assert.equal(folderKind("C:\\Users\\Rizky\\AgentForge-Chat"), "tester");
  assert.equal(folderKind(HYP), "hyp-ai");
  assert.equal(folderKind("C:\\Users\\rizky\\hypey\\app-sync"), "other");
  assert.equal(folderKind("C:\\Users\\rizky\\Downloads"), "other");
  assert.equal(folderKind("C:/Users/rizky/agentforge/.claude/worktrees/quizzical-merkle-067d77"), "main");
  assert.equal(folderKind("C:\\Users\\rizky\\nultron"), "main");
  assert.equal(folderKind("C:\\Users\\Rizky\\Nultron-Split"), "main");
  assert.equal(folderKind("C:/Users/rizky/nultron/.claude/worktrees/quizzical-merkle-067d77"), "main");
  assert.equal(folderKind("C:/Users/rizky/nultronx"), "other");
});

test("classifyPlace: a folder named nultron is the published row, like agentforge", () => {
  const published = classifyPlace({ folder: "C:/Users/rizky/nultron", branch: "main" });
  assert.equal(published.ok, true);
  assert.equal(published.row, "main");
  assert.equal(published.webdev, 3000);
  const worktree = classifyPlace({ folder: "C:/Users/rizky/nultron-split-guard", branch: "chore/rename-guard" });
  assert.equal(worktree.ok, true);
  assert.equal(worktree.row, "main");
  assert.match(worktree.label, /feature branch/);
});

test("classifyPlace: the main folder is the published row on main", () => {
  const place = classifyPlace({ folder: MAIN_FOLDER, branch: "main" });
  assert.equal(place.ok, true);
  assert.equal(place.row, "main");
  assert.equal(place.webdev, 3000);
});

test("classifyPlace: a worktree on a feature branch cut from main is the main row", () => {
  const place = classifyPlace({ folder: WORKTREE, branch: "chore/agent-guardrails", branchHoldsTester: false });
  assert.equal(place.ok, true);
  assert.equal(place.row, "main");
  assert.match(place.label, /feature branch/);
});

test("classifyPlace: a claude worktree under the main folder is a feature row, not a stray folder", () => {
  const place = classifyPlace({ folder: "C:/Users/rizky/agentforge/.claude/worktrees/x-1", branch: "claude/x-1" });
  assert.equal(place.ok, true);
  assert.equal(place.row, "main");
});

test("classifyPlace: a main-family branch that holds the tester's commits is refused", () => {
  const place = classifyPlace({ folder: WORKTREE, branch: "fix/from-tester", branchHoldsTester: true });
  assert.equal(place.ok, false);
  assert.match(place.message, /holds the tester's commits/);
});

test("classifyPlace: the tester folder is ok only on tester/chat-first", () => {
  const ok = classifyPlace({ folder: TESTER, branch: TESTER_BRANCH });
  assert.equal(ok.ok, true);
  assert.equal(ok.row, "tester");
  assert.equal(ok.webdev, 3200);
  const wrong = classifyPlace({ folder: TESTER, branch: "main" });
  assert.equal(wrong.ok, false);
  assert.match(wrong.message, /only carries tester\/chat-first/);
});

test("classifyPlace: the tester branch outside agentforge-chat is refused", () => {
  const place = classifyPlace({ folder: MAIN_FOLDER, branch: TESTER_BRANCH });
  assert.equal(place.ok, false);
  assert.match(place.message, /belongs in agentforge-chat/);
  assert.equal(classifyPlace({ folder: WORKTREE, branch: TESTER_BRANCH }).ok, false);
});

test("classifyPlace: the HYP AI clone is its own main and nothing else", () => {
  const ok = classifyPlace({ folder: HYP, branch: "main" });
  assert.equal(ok.ok, true);
  assert.equal(ok.row, "hyp-ai");
  assert.equal(ok.webdev, 3301);
  assert.equal(classifyPlace({ folder: HYP, branch: "feature/x" }).ok, false);
});

test("classifyPlace: a detached HEAD is refused with a sentence; an unnamed folder passes as other", () => {
  const detached = classifyPlace({ folder: MAIN_FOLDER, branch: null });
  assert.equal(detached.ok, false);
  assert.match(detached.message, /detached HEAD/);
  const unknown = classifyPlace({ folder: "C:/Users/rizky/Downloads/copy", branch: "main" });
  assert.equal(unknown.ok, true, "a folder outside the table is not a red ci:local step");
  assert.equal(unknown.row, "other");
  assert.equal(unknown.webdev, undefined, "no webdev port is claimed for an unnamed folder");
});

test("classifyPlace: an unnamed folder that holds the tester's commits is still refused", () => {
  const held = classifyPlace({ folder: "C:/Users/rizky/Downloads/copy", branch: "topic", branchHoldsTester: true });
  assert.equal(held.ok, false);
  assert.match(held.message, /holds the tester's commits/);
  assert.equal(classifyPlace({ folder: "C:/Users/rizky/Downloads/copy", branch: "topic" }).ok, true);
});

test("where-am-i run: an unnamed clone prints its folder and branch, and exits 0 without a webdev port", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "where-am-i-unnamed-"));
  try {
    writeFileSync(path.join(dir, "lanes.json"), "{}\n");
    mkdirSync(path.join(dir, "docs", "internal"), { recursive: true });
    git(dir, "init", "-q");
    git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
    git(
      dir,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );
    const result = spawnSync(process.execPath, [GUARD, "--root", dir], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /where-am-i: row other \(/);
    assert.doesNotMatch(result.stdout, /webdev on/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("releaseProblem: releases run from main in a main folder only", () => {
  assert.equal(releaseProblem({ folder: MAIN_FOLDER, branch: "main" }), null);
  assert.match(releaseProblem({ folder: MAIN_FOLDER, branch: "feature/x" }), /releases run from main only/);
  assert.match(releaseProblem({ folder: MAIN_FOLDER, branch: null }), /detached HEAD/);
  assert.match(releaseProblem({ folder: TESTER, branch: TESTER_BRANCH }), /tester folder/);
  assert.match(releaseProblem({ folder: TESTER, branch: "main" }), /tester folder/);
});

// ---------------------------------------------------------------------------------------------
// Integration: throwaway checkouts with the real folder names
// ---------------------------------------------------------------------------------------------

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A checkout named `folder` under a fresh temp dir, on main with lanes.json and docs/internal in place. */
function makeCheckout(folder, { manifest = true } = {}) {
  const parent = mkdtempSync(path.join(os.tmpdir(), "where-am-i-"));
  const root = path.join(parent, folder);
  mkdirSync(root, { recursive: true });
  git(root, "init", "--quiet");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "config", "user.name", "where test");
  git(root, "config", "user.email", "where@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "README.md"), "# checkout\n");
  if (manifest) {
    writeFileSync(path.join(root, "lanes.json"), '{"version": 1}\n');
    mkdirSync(path.join(root, "docs", "internal"), { recursive: true });
    writeFileSync(path.join(root, "docs", "internal", "note.md"), "# note\n");
  }
  git(root, "add", "--all");
  git(root, "commit", "--quiet", "-m", "base");
  return { parent, root };
}

function runWhere(root) {
  const result = spawnSync(process.execPath, [GUARD, "--root", root], { encoding: "utf8" });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

test("integration: the tester folder on tester/chat-first passes and names its row", () => {
  const { parent, root } = makeCheckout("agentforge-chat");
  try {
    git(root, "branch", TESTER_BRANCH);
    git(root, "checkout", "--quiet", TESTER_BRANCH);
    const result = runWhere(root);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /row tester/);
    assert.match(result.out, /webdev on :3200/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("integration: the tester folder on main exits 1 with one plain sentence", () => {
  const { parent, root } = makeCheckout("agentforge-chat");
  try {
    const result = runWhere(root);
    assert.equal(result.code, 1);
    assert.match(result.err, /where-am-i: .*only carries tester\/chat-first/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("integration: a worktree-style folder on a branch cut from main passes", () => {
  const { parent, root } = makeCheckout("agentforge-guardrails");
  try {
    git(root, "checkout", "--quiet", "-b", "chore/example");
    const result = runWhere(root);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /row main \(a feature branch cut from main\)/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("integration: a branch cut from the tester's tip is refused in a main-family folder", () => {
  const { parent, root } = makeCheckout("agentforge-guardrails");
  try {
    git(root, "checkout", "--quiet", "-b", TESTER_BRANCH);
    writeFileSync(path.join(root, "tester-only.txt"), "tester work\n");
    git(root, "add", "--all");
    git(root, "commit", "--quiet", "-m", "tester work");
    git(root, "checkout", "--quiet", "-b", "fix/from-tester");
    git(root, "checkout", "--quiet", "main");
    git(root, "checkout", "--quiet", "fix/from-tester");
    const result = runWhere(root);
    assert.equal(result.code, 1);
    assert.match(result.err, /holds the tester's commits/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("integration: tester work already promoted into main does not count as the tester's", () => {
  const { parent, root } = makeCheckout("agentforge-guardrails");
  try {
    git(root, "checkout", "--quiet", "-b", TESTER_BRANCH);
    writeFileSync(path.join(root, "promoted.txt"), "promoted work\n");
    git(root, "add", "--all");
    git(root, "commit", "--quiet", "-m", "tester work");
    git(root, "checkout", "--quiet", "main");
    git(root, "merge", "--quiet", "--no-ff", "-m", "promote", TESTER_BRANCH);
    git(root, "checkout", "--quiet", "-b", "chore/after-promotion");
    const result = runWhere(root);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /a feature branch cut from main/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("integration: a stripped checkout (no lanes.json) skips with exit 0", () => {
  const { parent, root } = makeCheckout("app-sync", { manifest: false });
  try {
    const result = runWhere(root);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /skipped/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("integration: a folder that is not a git checkout exits 1 with a sentence", () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "where-am-i-"));
  try {
    mkdirSync(path.join(parent, "docs", "internal"), { recursive: true });
    writeFileSync(path.join(parent, "lanes.json"), '{"version": 1}\n');
    const result = runWhere(parent);
    assert.equal(result.code, 1);
    assert.match(result.err, /not a git checkout/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
