#!/usr/bin/env node
/**
 * Where am I? Prints this checkout's folder and branch, the row of AGENTS.md's "Where am I?" table
 * they match, and exits 1 with one plain sentence when they break a rule. It writes nothing.
 *
 * Usage (repo root, or any checkout with --root):
 *   node scripts/where-am-i.mjs            pnpm where
 *   node scripts/where-am-i.mjs --root <dir>
 *
 * Rows: the published folder `agentforge` (or `nultron`, once the source repo takes that name) and its worktrees `agentforge-<topic>` or `nultron-<topic>` (and Claude Code's
 * worktrees under `agentforge/.claude/worktrees`) on `main` or on a branch cut from main; the tester
 * folder `agentforge-chat` on `tester/chat-first` and nothing else. A main-family branch that holds the
 * tester's commits was not cut from main, so it is refused.
 *
 * Any other folder (a Cloud VM clone, a copy under another name) has no row, so it prints its place and
 * passes: a required ci:local step must not turn red because of a folder name. The tester's-commits rule
 * still applies to it. Decision recorded 2026-10-14; `releaseProblem` below is the one hard release gate.
 *
 * Also exported for the release scripts: `releaseProblem` says why a release may not run from a checkout
 * (not on main, or the tester folder). scripts/release-web.mjs and apps/desktop/scripts/release-desktop.mjs
 * refuse on it.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const TESTER_BRANCH = "tester/chat-first";
const MAIN_BRANCH = "main";
const WEBDEV_PORT = { main: 3000, tester: 3200 };

/** Which row a folder belongs to, by its name. Windows names are case-insensitive. */
export function folderKind(folder) {
  const parts = String(folder ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  const name = parts.at(-1) ?? "";
  if (name === "agentforge-chat") return "tester";
  if (/^(agentforge|nultron)(-.+)?$/.test(name)) return "main";
  const claudeWorktree = parts.at(-3) === ".claude" && parts.at(-2) === "worktrees";
  if (claudeWorktree && ["agentforge", "nultron"].includes(parts.at(-4))) return "main";
  return "other";
}

const placed = (row, label) => ({ ok: true, row, label, webdev: WEBDEV_PORT[row] });
const refused = (message) => ({ ok: false, message });

/**
 * The row for one checkout, or the sentence that says why it breaks a rule. `branch` is null on a detached
 * HEAD. `branchHoldsTester` is true when the branch contains the tester's commits.
 */
export function classifyPlace({ folder, branch, branchHoldsTester = false }) {
  if (!branch) {
    return refused(`${folder} has a detached HEAD; check out its branch first (AGENTS.md "Where am I?").`);
  }
  const kind = folderKind(folder);
  if (kind === "tester") {
    if (branch === TESTER_BRANCH) return placed("tester", "the tester folder on its own branch");
    return refused(
      `${folder} is the tester folder (agentforge-chat), which only carries ${TESTER_BRANCH}; it is on ${branch}. Stop and ask Rizky.`,
    );
  }
  if (branch === TESTER_BRANCH) {
    return refused(`branch ${TESTER_BRANCH} belongs in agentforge-chat, not in ${folder}.`);
  }
  if (kind === "main") {
    if (branch === MAIN_BRANCH) return placed("main", "the published folder on main");
    if (branchHoldsTester) {
      return refused(
        `branch ${branch} holds the tester's commits, so it was not cut from main. Cut a branch from main instead.`,
      );
    }
    return placed("main", "a feature branch cut from main");
  }
  if (branchHoldsTester) {
    return refused(
      `branch ${branch} holds the tester's commits, so it was not cut from main. Cut a branch from main instead.`,
    );
  }
  return placed("other", `${folder} is outside the folders in AGENTS.md "Where am I?"; no desk row applies`);
}

/** Null when a release may run from this checkout; otherwise the reason it may not. */
export function releaseProblem({ folder, branch }) {
  if (folderKind(folder) === "tester") {
    return `${folder} is the tester folder (agentforge-chat). Releases never run from the tester.`;
  }
  if (branch !== MAIN_BRANCH) {
    return `releases run from main only; this checkout is on ${branch || "a detached HEAD"}.`;
  }
  return null;
}

function git(root, args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (allowFail) return null;
    throw error;
  }
}

/** The checked-out branch, or null on a detached HEAD or outside a checkout. */
export function branchOf(root) {
  const name = git(root, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true })?.trim();
  return name && name !== "HEAD" ? name : null;
}

/**
 * True when HEAD contains the local tester tip while main does not: the tester's unpromoted work. The
 * origin copy of the tester branch is not read, because it can sit at main's tip and would flag every branch.
 * Work that a promotion already merged into main does not count.
 */
function holdsTester(root) {
  const tip = git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${TESTER_BRANCH}`], {
    allowFail: true,
  })?.trim();
  if (!tip) return false;
  const contains = (ref) => git(root, ["merge-base", "--is-ancestor", tip, ref], { allowFail: true }) !== null;
  return contains("HEAD") && !contains(MAIN_BRANCH) && !contains("origin/main");
}

/** The checkout's folder and branch, or null when `root` is not inside a git checkout. */
export function readPlace(root) {
  const folder = git(root, ["rev-parse", "--show-toplevel"], { allowFail: true })?.trim();
  if (!folder) return null;
  const branch = branchOf(root);
  const isFeature = branch !== null && branch !== MAIN_BRANCH;
  return { folder, branch, branchHoldsTester: isFeature && holdsTester(root) };
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

/** Prints the place and returns the exit code. */
export function run(args, defaultRoot) {
  const root = path.resolve(args.root ?? defaultRoot);
  const place = readPlace(root);
  if (!place) {
    console.error(`where-am-i: ${root} is not a git checkout; run this inside agentforge or its worktrees.`);
    return 1;
  }
  console.log(`where-am-i: folder ${place.folder}`);
  console.log(`where-am-i: branch ${place.branch ?? "(detached HEAD)"}`);
  const result = classifyPlace(place);
  if (result.ok) {
    const webdev = result.webdev ? `, webdev on :${result.webdev}` : "";
    console.log(`where-am-i: row ${result.row} (${result.label})${webdev}`);
    return 0;
  }
  console.error(`where-am-i: ${result.message}`);
  return 1;
}

function main() {
  try {
    return run(parseArgs(process.argv.slice(2)), process.cwd());
  } catch (error) {
    console.error(`where-am-i: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main();
}
