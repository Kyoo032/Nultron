#!/usr/bin/env node
/**
 * Pre-push guard. Git runs scripts/hooks/pre-push (a two-line sh shim that execs this file) once per
 * push. It gets the remote name and URL as arguments, and one stdin line per ref:
 *   <local ref> <local sha> <remote ref> <remote sha>
 * The decision is taken from the ref being pushed, never from the checked-out branch.
 *
 * Refuses (exit 1):
 *   1. tester/chat-first pushed to any remote branch other than tester/chat-first.
 *   2. Any push to main. main moves only through merged pull requests. From the tester folder the
 *      message says so, because that is the mistake this exists for.
 *   3. Another branch pushed onto the remote tester/chat-first: only the tester's own branch may carry it.
 * For any other branch push it runs scripts/lane-guard.mjs against origin/main...<local sha>, without
 * --strict: its three blocking rules (never-promote, protected files with no Lanes line, brand literals
 * over the baseline) refuse the push, and map warnings only print.
 *
 * Agents never bypass this hook. Do not use --no-verify on a push (Rizky's rule, 2026-10-14).
 * A failing node or lane-guard refuses the push: the hook fails closed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { folderKind, TESTER_BRANCH } from "../where-am-i.mjs";

export const MAIN_REF = "refs/heads/main";
const HEADS = "refs/heads/";
const ZERO_SHA = /^0+$/;
const LANE_GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lane-guard.mjs");

/** One object per stdin line; blank lines are skipped. */
export function parsePushLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
      return { localRef, localSha, remoteRef, remoteSha };
    });
}

const branchOf = (ref) => (typeof ref === "string" && ref.startsWith(HEADS) ? ref.slice(HEADS.length) : null);
const refusal = (refuse) => ({ refuse, lanesCheck: false, branch: null });

/**
 * The decision for one ref. `testerFolder` is true when the push runs from agentforge-chat.
 * Returns { refuse, lanesCheck, branch }: `refuse` is a sentence or null, `lanesCheck` says whether the
 * lane guard judges this push, and `branch` is the pushed branch name for that check.
 */
export function judgePush({ testerFolder = false, localRef, localSha, remoteRef }) {
  const deleting = ZERO_SHA.test(localSha ?? "");
  const localBranch = branchOf(localRef);
  const remoteBranch = branchOf(remoteRef);
  if (remoteRef === MAIN_REF) {
    return refusal(
      testerFolder
        ? "pushing from the tester folder to main is refused. The tester reaches main only through a promotion pull request Rizky approves."
        : "pushing to main directly is refused. main moves only through merged pull requests: push a branch cut from main and open a pull request.",
    );
  }
  if (remoteBranch === TESTER_BRANCH && localBranch !== TESTER_BRANCH && !deleting) {
    return refusal(
      `only ${TESTER_BRANCH} may be pushed to the remote ${TESTER_BRANCH}; ${localRef} would overwrite the tester.`,
    );
  }
  if (localBranch === TESTER_BRANCH && remoteBranch !== TESTER_BRANCH) {
    return refusal(`${TESTER_BRANCH} goes only to the remote branch of the same name, not to ${remoteRef}.`);
  }
  const lanesCheck = !deleting && localBranch !== null && remoteBranch !== null && localBranch !== TESTER_BRANCH;
  return { refuse: null, lanesCheck, branch: localBranch };
}

/**
 * Whether the guard judges a push to this remote URL. A push to another GitHub repository (the HYP AI
 * clone's Kyoo032/hyp-ai, a release repo) has its own main, so the guard lets it through. Any other URL,
 * a local path included, is judged: the guard fails closed.
 */
export function guardsRemote(url) {
  const match = /github\.com[:/][^/]+\/([^/]+?)(?:\.git)?\/?$/i.exec(String(url ?? "").trim());
  return !match || ["agentforge", "nultron"].includes(match[1].toLowerCase());
}

/** The argv for one lane-guard run: the pushed branch judged against its own tip, never the checked-out one. */
export function laneGuardArgs({ root, branch, base, tip }) {
  return [LANE_GUARD, "--root", root, "--branch", branch, `${base}...${tip}`];
}

function gitOut(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function resolves(root, ref) {
  try {
    gitOut(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Runs lane-guard for one judged push and returns { ok, output }. A missing base refuses (fail closed). */
function laneCheck(root, judged, tip) {
  const base = resolves(root, "origin/main") ? "origin/main" : "main";
  if (!resolves(root, base)) {
    return { ok: false, output: "pre-push: no origin/main or main to compare with; the lane check cannot run.\n" };
  }
  const result = spawnSync(process.execPath, laneGuardArgs({ root, branch: judged.branch, base, tip }), {
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { ok: result.status === 0, output };
}

/**
 * Judges every ref in `stdinText` for a push from the checkout at `root`. Returns { code, message, output }:
 * code 0 lets the push through; 1 refuses it, with `message` naming the rule and `output` any lane-guard text.
 */
export function checkPush({ root, stdinText }) {
  const testerFolder = folderKind(root) === "tester";
  for (const line of parsePushLines(stdinText)) {
    const judged = judgePush({ testerFolder, ...line });
    if (judged.refuse) return { code: 1, message: `pre-push: refused: ${judged.refuse}`, output: "" };
    if (!judged.lanesCheck) continue;
    const lane = laneCheck(root, judged, line.localSha);
    if (!lane.ok) {
      return {
        code: 1,
        message: `pre-push: refused: lane-guard blocks the push of ${judged.branch} (see above). Fix the change, or label a commit with a "Lanes:" line.`,
        output: lane.output,
      };
    }
    if (lane.output) process.stdout.write(lane.output);
  }
  return { code: 0, message: "", output: "" };
}

async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main() {
  let root;
  try {
    root = gitOut(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    console.error("pre-push: refused: not inside a git checkout.");
    return 1;
  }
  // Git passes the remote name, then its URL.
  if (!guardsRemote(process.argv[3])) return 0;
  const { code, message, output } = checkPush({ root, stdinText: await readStdin() });
  if (output) process.stderr.write(output);
  if (message) console.error(message);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main();
}
