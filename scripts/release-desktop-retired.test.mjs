import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// release-desktop.mjs runs main() on import and has no guard for it, so these tests run it as a child.
// Nothing here uploads. The refusals come before any write, and the one run that gets past the retired
// check uses --dry-run and an empty --dist, so it stops before anything is staged.
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_REL = "apps/desktop/scripts/release-desktop.mjs";
// What release-desktop.mjs reads or imports. release-web.test.mjs copies the same list for its desktop cases.
const FILES = [
  SCRIPT_REL,
  "apps/desktop/scripts/release-artifacts.mjs",
  "apps/desktop/package.json",
  "apps/desktop/branding/agentforge/brand.json",
  "scripts/release-marks.mjs",
  "scripts/where-am-i.mjs",
];

const temp = [];
after(() => {
  for (const dir of temp) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  temp.push(dir);
  return dir;
}

function run(...args) {
  return spawnSync(process.execPath, args, { encoding: "utf8", timeout: 60_000 });
}

function git(dir, ...args) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

// A temp repo on main that holds copies of FILES. The branch needs one commit, because an unborn branch
// reads as a detached HEAD to `git branch --show-current`.
let fixtureScript;
function fixtureOnMain() {
  if (fixtureScript) return fixtureScript;
  const dir = tempDir("release-desktop-retired-repo-");
  for (const rel of FILES) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    copyFileSync(path.join(REPO, rel), path.join(dir, rel));
  }
  git(dir, "init", "-q");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  git(
    dir,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "fixture",
  );
  fixtureScript = path.join(dir, SCRIPT_REL);
  return fixtureScript;
}

test("release-desktop refuses outright without --allow-retired, before it reads the version or the tree", () => {
  const result = run(path.join(REPO, SCRIPT_REL), "--dry-run");
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /desktop-release: the desktop app is retired \(2026-10-14\)/);
  assert.equal(result.stdout, "", "the refusal comes before the target line and every git call");
});

test("release-desktop refuses an unknown flag as before, so the retired check cannot be bypassed by typos", () => {
  const result = run(path.join(REPO, SCRIPT_REL), "--allow-retire");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown argument --allow-retire/);
});

test("release-desktop with --allow-retired on main gets past the retired refusal and the checkout guard", () => {
  const emptyDist = tempDir("release-desktop-retired-dist-");
  const result = run(fixtureOnMain(), "--allow-retired", "--allow-dirty", "--dry-run", "--dist", emptyDist);
  const out = `${result.stdout}${result.stderr}`;
  assert.doesNotMatch(out, /the desktop app is retired/, "the flag lifts the refusal");
  assert.match(out, /checkout is main, not the tester folder/, "the fixture is on main, so the guard passes");
  assert.equal(result.status, 1, "an empty dist has no installer, so the run stops before anything is staged");
});
