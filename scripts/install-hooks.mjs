#!/usr/bin/env node
/**
 * Points this checkout's git config at scripts/hooks, where the pre-push guard lives (pnpm hooks:install).
 *
 *   node scripts/install-hooks.mjs            run once per clone, from any worktree of it
 *   node scripts/install-hooks.mjs --root <dir>   another checkout (tests)
 *
 * The write is `git config --local`: worktrees of one clone share that config, so one run covers all of
 * them, and nothing is written to the global or system config (release-web pushes `main` from a temp clone
 * that must never inherit this). The path is relative on purpose: git resolves it from each worktree's own
 * root, so every worktree runs the guard that its own branch carries. A branch that predates scripts/hooks
 * has no guard until it merges main.
 *
 * Agents never push with --no-verify. Rizky's rule, 2026-10-14: the hook is the only thing that stops a
 * tester push to main, and a bypass defeats it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const HOOKS_PATH = "scripts/hooks";
const HOOK_FILES = ["pre-push", "pre-push.mjs"];

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Writes core.hooksPath for the checkout at `root` and returns the value it now holds. */
export function installHooks(root) {
  const missing = HOOK_FILES.filter((name) => !existsSync(path.join(root, HOOKS_PATH, name)));
  if (missing.length > 0) {
    throw new Error(`${HOOKS_PATH}/${missing.join(", ")} missing in ${root}; the hooks come with agentforge main`);
  }
  git(root, ["config", "--local", "core.hooksPath", HOOKS_PATH]);
  return git(root, ["config", "--local", "--get", "core.hooksPath"]).trim();
}

export function parseArgs(argv) {
  const args = { root: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") {
      args.root = argv[i + 1];
      if (!args.root) throw new Error("--root needs a directory");
      i += 1;
    } else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`install-hooks: ${error.message}`);
    return 1;
  }
  const root = path.resolve(args.root ?? process.cwd());
  try {
    const value = installHooks(root);
    console.log(`install-hooks: core.hooksPath = ${value} (this clone's config, shared by its worktrees).`);
    console.log(
      "install-hooks: each worktree runs the guard its own branch carries; a branch older than scripts/hooks has none until it merges main.",
    );
    console.log(
      "install-hooks: never push with --no-verify. The pre-push guard refuses pushes to main and tester-only pushes.",
    );
    return 0;
  } catch (error) {
    console.error(`install-hooks: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main();
}
