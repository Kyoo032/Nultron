import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HOOKS_PATH, installHooks } from "./install-hooks.mjs";

const INSTALL = path.join(path.dirname(fileURLToPath(import.meta.url)), "install-hooks.mjs");

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A throwaway checkout; `hookFiles` are written under scripts/hooks. */
function makeCheckout(hookFiles) {
  const root = mkdtempSync(path.join(os.tmpdir(), "install-hooks-"));
  git(root, "init", "--quiet");
  for (const name of hookFiles) {
    mkdirSync(path.join(root, "scripts", "hooks"), { recursive: true });
    writeFileSync(path.join(root, "scripts", "hooks", name), "# hook\n");
  }
  return root;
}

test("HOOKS_PATH is the relative scripts/hooks folder every worktree shares by name", () => {
  assert.equal(HOOKS_PATH, "scripts/hooks");
});

test("installHooks sets core.hooksPath in this checkout's local config", () => {
  const root = makeCheckout(["pre-push", "pre-push.mjs"]);
  try {
    assert.equal(installHooks(root), "scripts/hooks");
    assert.equal(git(root, "config", "--local", "--get", "core.hooksPath").trim(), "scripts/hooks");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installHooks refuses when the hook files are missing, and writes nothing", () => {
  const root = makeCheckout(["pre-push"]);
  try {
    assert.throws(() => installHooks(root), /pre-push\.mjs missing/);
    const set = spawnSync("git", ["-C", root, "config", "--local", "--get", "core.hooksPath"], { encoding: "utf8" });
    assert.equal(set.status, 1, "no core.hooksPath was written");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-hooks.mjs --root installs from the command line and names the no-verify rule", () => {
  const root = makeCheckout(["pre-push", "pre-push.mjs"]);
  try {
    const result = spawnSync(process.execPath, [INSTALL, "--root", root], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /core\.hooksPath = scripts\/hooks/);
    assert.match(result.stdout, /--no-verify/);
    assert.equal(git(root, "config", "--local", "--get", "core.hooksPath").trim(), "scripts/hooks");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-hooks.mjs refuses an unknown argument", () => {
  const result = spawnSync(process.execPath, [INSTALL, "--global"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown argument: --global/);
});
