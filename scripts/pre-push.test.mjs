import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { installHooks } from "./install-hooks.mjs";
import { guardsRemote, judgePush, laneGuardArgs, MAIN_REF, parsePushLines } from "./hooks/pre-push.mjs";
import { TESTER_BRANCH } from "./where-am-i.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SHA = "a".repeat(40);
const ZERO = "0".repeat(40);

// ---------------------------------------------------------------------------------------------
// Decisions (pure)
// ---------------------------------------------------------------------------------------------

test("parsePushLines reads one object per ref and skips blank lines", () => {
  const text = `refs/heads/feature/x ${SHA} refs/heads/feature/x ${ZERO}\n\nrefs/heads/main ${SHA} refs/heads/main ${ZERO}\n`;
  assert.deepEqual(parsePushLines(text), [
    { localRef: "refs/heads/feature/x", localSha: SHA, remoteRef: "refs/heads/feature/x", remoteSha: ZERO },
    { localRef: "refs/heads/main", localSha: SHA, remoteRef: "refs/heads/main", remoteSha: ZERO },
  ]);
  assert.deepEqual(parsePushLines(""), []);
});

test("guardsRemote judges agentforge and nultron in any case, and unknown URLs; other GitHub repositories pass", () => {
  for (const url of [
    "https://github.com/Kyoo032/agentforge.git",
    "https://github.com/Kyoo032/agentforge",
    "git@github.com:Kyoo032/agentforge.git",
    "https://github.com/Kyoo032/Nultron.git",
    "git@github.com:Kyoo032/Nultron.git",
    "https://github.com/kyoo032/NULTRON/",
    "C:/Users/rizky/some-bare-repo",
    "",
    undefined,
  ]) {
    assert.equal(guardsRemote(url), true, String(url));
  }
  for (const url of [
    "https://github.com/Kyoo032/Nultron-Releases.git",
    "git@github.com:Kyoo032/Nultron-Releases.git",
    "https://github.com/Kyoo032/Nultron-Desktop.git",
    "https://github.com/Kyoo032/other-product.git",
    "https://github.com/Kyoo032/agentforge-fork",
    "https://github.com/Kyoo032/nultron-fork",
  ]) {
    assert.equal(guardsRemote(url), false, url);
  }
});

test("judgePush refuses the tester branch on any remote branch but its own", () => {
  const elsewhere = judgePush({
    testerFolder: true,
    localRef: `refs/heads/${TESTER_BRANCH}`,
    localSha: SHA,
    remoteRef: "refs/heads/feature/x",
  });
  assert.match(elsewhere.refuse, /goes only to the remote branch of the same name/);
  assert.equal(elsewhere.lanesCheck, false);
  const own = judgePush({
    testerFolder: true,
    localRef: `refs/heads/${TESTER_BRANCH}`,
    localSha: SHA,
    remoteRef: `refs/heads/${TESTER_BRANCH}`,
  });
  assert.equal(own.refuse, null);
  assert.equal(own.lanesCheck, false, "the tester's own push is not judged against main");
});

test("judgePush refuses any push to main, and names the tester folder when that is where it runs from", () => {
  const fromFeature = judgePush({
    testerFolder: false,
    localRef: "refs/heads/feature/x",
    localSha: SHA,
    remoteRef: MAIN_REF,
  });
  assert.match(fromFeature.refuse, /main moves only through merged pull requests/);
  const fromTester = judgePush({
    testerFolder: true,
    localRef: `refs/heads/${TESTER_BRANCH}`,
    localSha: SHA,
    remoteRef: MAIN_REF,
  });
  assert.match(fromTester.refuse, /from the tester folder to main/);
});

test("judgePush refuses deleting main, and allows deleting a feature branch without a lane check", () => {
  const deleteMain = judgePush({ testerFolder: false, localRef: "(delete)", localSha: ZERO, remoteRef: MAIN_REF });
  assert.match(deleteMain.refuse, /main moves only through merged pull requests/);
  const deleteFeature = judgePush({
    testerFolder: false,
    localRef: "(delete)",
    localSha: ZERO,
    remoteRef: "refs/heads/feature/x",
  });
  assert.equal(deleteFeature.refuse, null);
  assert.equal(deleteFeature.lanesCheck, false);
});

test("judgePush refuses another branch pushed onto the remote tester branch", () => {
  const judged = judgePush({
    testerFolder: false,
    localRef: "refs/heads/feature/x",
    localSha: SHA,
    remoteRef: `refs/heads/${TESTER_BRANCH}`,
  });
  assert.match(judged.refuse, /only tester\/chat-first may be pushed to the remote tester\/chat-first/);
});

test("judgePush sends a feature branch to the lane check, judged by the pushed branch name", () => {
  const judged = judgePush({
    testerFolder: false,
    localRef: "refs/heads/feature/x",
    localSha: SHA,
    remoteRef: "refs/heads/feature/y",
  });
  assert.equal(judged.refuse, null);
  assert.equal(judged.lanesCheck, true);
  assert.equal(judged.branch, "feature/x");
});

test("judgePush lets a tag through without a lane check", () => {
  const judged = judgePush({ testerFolder: false, localRef: "refs/tags/v1", localSha: SHA, remoteRef: "refs/tags/v1" });
  assert.equal(judged.refuse, null);
  assert.equal(judged.lanesCheck, false);
});

test("laneGuardArgs judges the pushed branch against origin/main, with the lane guard's own script", () => {
  const args = laneGuardArgs({ root: "/repo", branch: "feature/x", base: "origin/main", tip: SHA });
  assert.deepEqual(args.slice(1), ["--root", "/repo", "--branch", "feature/x", `origin/main...${SHA}`]);
  assert.match(args[0], /scripts[\\/]lane-guard\.mjs$/);
});

// ---------------------------------------------------------------------------------------------
// Real pushes into a throwaway bare remote: the hook runs through git, as an agent's push would
// ---------------------------------------------------------------------------------------------

const roots = [];
process.on("exit", () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  // The hook's shim runs `node`; keep this test's node first on PATH whatever the caller's PATH is.
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
};

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: ENV });
}

function put(root, rel, text) {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function commit(root, message) {
  git(root, "add", "--all");
  git(root, "commit", "--quiet", "-m", message);
}

function push(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, "push", ...args], { encoding: "utf8", env: ENV });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/**
 * A project folder named `folder` with the hook scripts copied in, a bare `origin`, and main pushed
 * before the hook is installed (the first push of main is the only one that needs no guard).
 */
function makeProject(folder) {
  const parent = mkdtempSync(path.join(os.tmpdir(), "pre-push-"));
  roots.push(parent);
  const root = path.join(parent, folder);
  const remote = path.join(parent, "origin.git");
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--bare", remote], { env: ENV });
  git(root, "init", "--quiet");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "config", "user.name", "pre-push test");
  git(root, "config", "user.email", "pre-push@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  for (const file of ["hooks/pre-push", "hooks/pre-push.mjs", "lane-guard.mjs", "where-am-i.mjs"]) {
    put(root, `scripts/${file}`, readFileSync(path.join(REPO, "scripts", file)));
  }
  put(
    root,
    "lanes.json",
    JSON.stringify({
      version: 1,
      brandLiterals: ["Nultron"],
      brandScope: { include: ["src/**"], exclude: ["**/*.test.*"], extensions: [".ts"] },
      neverPromote: ["src/*.tester.env"],
      entries: [
        { glob: "src/**", map: "docs/internal/maps/src.md", lanes: ["personal"], protected: false },
        { glob: "src/shared.ts", map: "docs/internal/maps/src.md", lanes: ["tester"], protected: true },
      ],
    }),
  );
  put(root, "scripts/lane-guard.baseline.json", JSON.stringify({ literals: ["Nultron"], files: {} }));
  put(root, "docs/internal/maps/src.md", "# Map: src\n");
  put(root, "src/a.ts", 'export const a = "a";\n');
  put(root, "src/shared.ts", "export const s = 1;\n");
  put(root, "README.md", "# project\n");
  commit(root, "base");
  git(root, "remote", "add", "origin", remote);
  assert.equal(push(root, "origin", "main").code, 0, "the first push of main carries no hook yet");
  installHooks(root);
  return { parent, root };
}

/** A branch from main with one commit that writes `files`, optionally with a commit message. */
function branchWith(root, branch, files, message = `change on ${branch}`) {
  git(root, "checkout", "--quiet", "-B", branch, "main");
  for (const [rel, text] of Object.entries(files)) put(root, rel, text);
  commit(root, message);
  git(root, "checkout", "--quiet", "main");
}

test("pre-push, from the tester folder: main is refused, other remote branches are refused, its own branch goes through", () => {
  const { root } = makeProject("agentforge-chat");
  git(root, "checkout", "--quiet", "-b", TESTER_BRANCH, "main");
  put(root, "src/tester.ts", "export const t = 1;\n");
  commit(root, "tester: work");

  const toMain = push(root, "origin", `${TESTER_BRANCH}:main`);
  assert.notEqual(toMain.code, 0, toMain.out);
  assert.match(toMain.out, /pushing from the tester folder to main is refused/);

  const toFeature = push(root, "origin", `${TESTER_BRANCH}:refs/heads/feature/x`);
  assert.notEqual(toFeature.code, 0, toFeature.out);
  assert.match(toFeature.out, /goes only to the remote branch of the same name/);

  const own = push(root, "origin", TESTER_BRANCH);
  assert.equal(own.code, 0, own.out);
});

test("pre-push, from a main-family folder: a clean feature goes through, each lane rule blocks its own change", () => {
  const { root } = makeProject("agentforge-guardrails");

  branchWith(root, "feature/clean", { "src/clean.ts": "export const c = 2;\n" });
  const clean = push(root, "origin", "feature/clean");
  assert.equal(clean.code, 0, clean.out);

  branchWith(root, "feature/shared", { "src/shared.ts": "export const s = 2;\n" }, "fix: shared, unlabelled");
  const shared = push(root, "origin", "feature/shared");
  assert.notEqual(shared.code, 0, shared.out);
  assert.match(shared.out, /BLOCK protected: src\/shared\.ts/);
  assert.match(shared.out, /pre-push: refused: lane-guard blocks the push of feature\/shared/);

  branchWith(
    root,
    "feature/shared-labelled",
    { "src/shared.ts": "export const s = 3;\n" },
    "fix: shared\n\nLanes: personal, tester",
  );
  const labelled = push(root, "origin", "feature/shared-labelled");
  assert.equal(labelled.code, 0, labelled.out);

  branchWith(root, "feature/brand", { "src/a.ts": 'export const a = "Nultron";\n' });
  const brand = push(root, "origin", "feature/brand");
  assert.notEqual(brand.code, 0, brand.out);
  assert.match(brand.out, /BLOCK brand: src\/a\.ts has "Nultron" 0 -> 1/);

  branchWith(root, "feature/never", { "src/app.tester.env": "KEY=1\n" });
  const never = push(root, "origin", "feature/never");
  assert.notEqual(never.code, 0, never.out);
  assert.match(never.out, /BLOCK never-promote: src\/app\.tester\.env/);
});

test("pre-push, from a main-family folder: a push of main is refused, and a map warning alone does not block", () => {
  const { root } = makeProject("agentforge-guardrails");
  branchWith(root, "feature/map-only", { "src/a.ts": 'export const a = "a2";\n' }, "fix: map only\n\nLanes: personal");
  const mapOnly = push(root, "origin", "feature/map-only");
  assert.equal(mapOnly.code, 0, mapOnly.out);
  assert.match(mapOnly.out, /WARN map/);

  const toMain = push(root, "origin", "feature/map-only:main");
  assert.notEqual(toMain.code, 0, toMain.out);
  assert.match(toMain.out, /pushing to main directly is refused/);
});

test("pre-push runs from a linked worktree too, because the hooks path is shared by every worktree", () => {
  const { parent, root } = makeProject("agentforge-guardrails");
  const worktree = path.join(parent, "agentforge-topic");
  git(root, "worktree", "add", "--quiet", worktree, "-b", "topic/x", "main");
  put(worktree, "src/topic.ts", "export const k = 1;\n");
  commit(worktree, "topic: work");
  const result = push(worktree, "origin", "HEAD:main");
  assert.notEqual(result.code, 0, result.out);
  assert.match(result.out, /pushing to main directly is refused/);
});
