import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  brandWarnings,
  countLiterals,
  entriesFor,
  globToRegExp,
  isMapExempt,
  mapWarnings,
  neverPromoteApplies,
  neverPromoteWarnings,
  parseArgs,
  parseLanesLines,
  protectedWarnings,
} from "./lane-guard.mjs";
import { TESTER_BRANCH } from "./where-am-i.mjs";

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "lane-guard.mjs");

const ENTRIES = [
  { glob: "packages/host/**", map: "docs/internal/maps/host.md", lanes: ["enterprise"], protected: false },
  { glob: "packages/host/src/runs.ts", map: "docs/internal/maps/chat.md", lanes: ["tester"], protected: true },
  { glob: "apps/web/locales/**", map: null, lanes: ["hyp-ai"], protected: false },
];

test("globToRegExp: ** crosses directories, * does not", () => {
  assert.ok(globToRegExp("apps/web/**").test("apps/web/a/b/c.tsx"));
  assert.ok(globToRegExp("apps/web/**").test("apps/web/c.tsx"));
  assert.ok(!globToRegExp("apps/web/**").test("apps/webx/c.tsx"));
  assert.ok(globToRegExp("apps/web/locales/*/chat.json").test("apps/web/locales/en/chat.json"));
  assert.ok(!globToRegExp("apps/web/locales/*/chat.json").test("apps/web/locales/en/x/chat.json"));
  assert.ok(globToRegExp("**/*.test.*").test("packages/host/src/a.test.ts"));
  assert.ok(globToRegExp("**/*.test.*").test("a.test.ts"));
  assert.ok(globToRegExp("a/b.c").test("a/b.c"));
  assert.ok(!globToRegExp("a/b.c").test("a/bxc"));
  const braces = globToRegExp("src/{csrf,rate-limit}.ts");
  assert.ok(braces.test("src/csrf.ts") && braces.test("src/rate-limit.ts"));
  assert.ok(!braces.test("src/other.ts"));
});

// The shipped manifest. Skipped where docs/internal is stripped (the HYP AI import).
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHIPPED = path.join(REPO, "lanes.json");
const HAS_DOCS = existsSync(SHIPPED) && existsSync(path.join(REPO, "docs", "internal"));

test("lanes.json: valid lanes, real map pages, real protected files", { skip: !HAS_DOCS }, () => {
  const config = JSON.parse(readFileSync(SHIPPED, "utf8"));
  const lanes = new Set(["personal", "enterprise", "hyp-ai", "tester"]);
  assert.ok(config.entries.length > 0);
  for (const entry of config.entries) {
    assert.equal(typeof entry.glob, "string", JSON.stringify(entry));
    assert.equal(typeof entry.protected, "boolean", entry.glob);
    assert.ok(entry.lanes.length > 0 && entry.lanes.every((l) => lanes.has(l)), `${entry.glob}: bad lanes`);
    if (entry.map !== null)
      assert.ok(existsSync(path.join(REPO, entry.map)), `${entry.glob}: map ${entry.map} is missing`);
    if (entry.protected && !/[*?{]/.test(entry.glob)) {
      assert.ok(existsSync(path.join(REPO, entry.glob)), `${entry.glob}: protected file is missing`);
    }
  }
});

test("lanes.json neverPromote: each glob matches no tracked file on main, and never AGENTS.md or TESTER.md", (t) => {
  if (!HAS_DOCS) return t.skip("lanes.json or docs/internal stripped");
  const config = JSON.parse(readFileSync(SHIPPED, "utf8"));
  assert.ok(
    Array.isArray(config.neverPromote) && config.neverPromote.length > 0,
    "neverPromote must be a non-empty array",
  );
  for (const glob of config.neverPromote) assert.equal(typeof glob, "string", JSON.stringify(glob));
  const ref = ["origin/main", "main"].find((r) => {
    try {
      execFileSync("git", ["-C", REPO, "rev-parse", "--verify", "--quiet", `${r}^{commit}`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
  if (!ref) return t.skip("no main ref in this clone");
  const tracked = execFileSync("git", ["-C", REPO, "ls-tree", "-r", "--name-only", ref], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const hits = tracked.filter((file) => config.neverPromote.some((glob) => globToRegExp(glob).test(file)));
  assert.deepEqual(hits, [], `a neverPromote glob would block a legitimate diff on ${ref}`);
  assert.deepEqual(
    neverPromoteWarnings(["AGENTS.md", "TESTER.md", ".env.example", "webapp-deploy/.env.example"], config.neverPromote),
    [],
  );
});

test("neverPromoteWarnings: a changed path on a never-promote glob is hit, the rest are not", () => {
  const globs = [".webdev-data-chat/**", "**/.env", "**/.env.chat*"];
  assert.deepEqual(
    neverPromoteWarnings(
      [".webdev-data-chat/desk.sqlite", "apps/web/.env.chat", "apps/web/.env.example", "src/a.ts", "x/.env"],
      globs,
    ),
    [".webdev-data-chat/desk.sqlite", "apps/web/.env.chat", "x/.env"],
  );
  assert.deepEqual(neverPromoteWarnings(["src/a.ts"], []), []);
});

test("neverPromoteApplies: a diff to main from any branch but the tester's, detached HEAD included", () => {
  assert.equal(neverPromoteApplies({ base: "origin/main", branch: "fix/x" }), true);
  assert.equal(neverPromoteApplies({ base: "main", branch: "fix/x" }), true);
  assert.equal(neverPromoteApplies({ base: "main", branch: null }), true);
  assert.equal(neverPromoteApplies({ base: "main", branch: TESTER_BRANCH }), false);
  assert.equal(neverPromoteApplies({ base: "abc123", branch: "fix/x" }), false);
});

test("parseArgs reads --branch and refuses a missing value", () => {
  assert.deepEqual(parseArgs(["--branch", "fix/x", "main...HEAD"]), {
    range: "main...HEAD",
    strict: false,
    writeBaseline: false,
    root: null,
    branch: "fix/x",
  });
  assert.throws(() => parseArgs(["--branch"]), /--branch needs a branch name/);
});

test("entriesFor returns every matching entry", () => {
  const hits = entriesFor("packages/host/src/runs.ts", ENTRIES);
  assert.equal(hits.length, 2);
  assert.equal(entriesFor("README.md", ENTRIES).length, 0);
});

test("isMapExempt: tests, docs and fixtures never need a map change", () => {
  assert.ok(isMapExempt("packages/host/src/a.test.ts"));
  assert.ok(isMapExempt("docs/internal/maps/x.md"));
  assert.ok(isMapExempt("packages/host/src/__fixtures__/a.ts"));
  assert.ok(isMapExempt("apps/portal/test/x.ts"));
  assert.ok(!isMapExempt("packages/host/src/runs.ts"));
});

test("mapWarnings: warns when code changes and none of its map pages did", () => {
  const warned = mapWarnings(["packages/host/src/runs.ts"], ENTRIES);
  assert.equal(warned.length, 1);
  assert.deepEqual(warned[0].maps, ["docs/internal/maps/chat.md", "docs/internal/maps/host.md"]);
  assert.deepEqual(warned[0].files, ["packages/host/src/runs.ts"]);
});

test("mapWarnings: any one of the matched pages changing is enough", () => {
  assert.deepEqual(mapWarnings(["packages/host/src/runs.ts", "docs/internal/maps/host.md"], ENTRIES), []);
});

test("mapWarnings: map null, tests and unlisted files are quiet", () => {
  assert.deepEqual(mapWarnings(["apps/web/locales/en/chat.json"], ENTRIES), []);
  assert.deepEqual(mapWarnings(["packages/host/src/a.test.ts"], ENTRIES), []);
  assert.deepEqual(mapWarnings(["scripts/other.mjs"], ENTRIES), []);
});

test("parseLanesLines reads Lanes: lines from commit messages", () => {
  assert.deepEqual(parseLanesLines("fix: x\n\nLanes: personal, enterprise\n"), ["personal, enterprise"]);
  assert.deepEqual(parseLanesLines("fix: x\n\nlanes: all"), ["all"]);
  assert.deepEqual(parseLanesLines("fix: mentions Lanes: in the middle of a line"), []);
  assert.deepEqual(parseLanesLines("fix: x\n\nLanes:\n"), []);
});

test("protectedWarnings: protected path needs a Lanes line", () => {
  const files = ["packages/host/src/runs.ts", "scripts/other.mjs"];
  const warned = protectedWarnings(files, ENTRIES, ["fix: x"]);
  assert.equal(warned.length, 1);
  assert.deepEqual(warned[0].files, ["packages/host/src/runs.ts"]);
  assert.deepEqual(protectedWarnings(files, ENTRIES, ["fix: x\n\nLanes: tester"]), []);
  assert.deepEqual(protectedWarnings(["scripts/other.mjs"], ENTRIES, ["fix: x"]), []);
});

test("countLiterals counts case-sensitive substrings", () => {
  const text = "Nultron and Nultron; nultron; Toko Token; HYP AI; Hypey";
  assert.deepEqual(countLiterals(text, ["Nultron", "Toko Token", "TokenKu", "HYP AI", "Hypey"]), {
    Nultron: 2,
    "Toko Token": 1,
    "HYP AI": 1,
    Hypey: 1,
  });
  assert.deepEqual(countLiterals("nothing here", ["Nultron"]), {});
});

const SCOPE = {
  include: ["apps/web/**", "packages/**"],
  exclude: ["apps/web/locales/**", "**/*.test.*", "**/*.md"],
  extensions: [".ts", ".tsx", ".json"],
};

test("brandWarnings: only an increase over the baseline warns", () => {
  const baseline = { literals: ["Nultron"], files: { "packages/core/src/a.ts": { Nultron: 2 } } };
  const text = {
    "packages/core/src/a.ts": "Nultron Nultron Nultron",
    "packages/core/src/b.ts": "Nultron",
    "packages/core/src/c.ts": "no brand",
    "apps/web/locales/en/x.json": "Nultron",
    "packages/core/src/a.test.ts": "Nultron",
    "packages/core/README.md": "Nultron",
  };
  const read = (file) => text[file] ?? null;
  const warned = brandWarnings(Object.keys(text), SCOPE, ["Nultron"], baseline, read);
  assert.deepEqual(
    warned.map((w) => [w.file, w.literal, w.was, w.now]),
    [
      ["packages/core/src/a.ts", "Nultron", 2, 3],
      ["packages/core/src/b.ts", "Nultron", 0, 1],
    ],
  );
  const same = brandWarnings(["packages/core/src/a.ts"], SCOPE, ["Nultron"], baseline, () => "Nultron Nultron");
  assert.deepEqual(same, []);
});

// ---------------------------------------------------------------------------------------------
// Integration: a throwaway repo, never the real tree
// ---------------------------------------------------------------------------------------------

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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

function makeRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), "lane-guard-"));
  git(root, "init", "--quiet");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "config", "user.name", "lane guard test");
  git(root, "config", "user.email", "lane-guard@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "commit.gpgsign", "false");
  put(
    root,
    "lanes.json",
    JSON.stringify({
      version: 1,
      brandLiterals: ["Nultron"],
      brandScope: { include: ["src/**"], exclude: ["**/*.test.*"], extensions: [".ts"] },
      neverPromote: [".webdev-data-chat/**", "src/*.tester.env"],
      entries: [
        { glob: "src/**", map: "docs/internal/maps/src.md", lanes: ["personal", "enterprise"], protected: false },
        { glob: "src/shared.ts", map: "docs/internal/maps/src.md", lanes: ["tester"], protected: true },
      ],
    }),
  );
  put(root, "docs/internal/maps/src.md", "# Map: src\n");
  put(root, "src/a.ts", 'export const a = "Nultron";\n');
  put(root, "src/shared.ts", "export const s = 1;\n");
  put(root, "src/clean.ts", "export const c = 1;\n");
  commit(root, "base");
  return root;
}

function runGuard(root, ...extra) {
  const result = spawnSync(process.execPath, [GUARD, "--root", root, ...extra], { encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

test("integration: a code-only change with a Lanes line warns about the map and nothing else", () => {
  const root = makeRepo();
  try {
    const written = runGuard(root, "--write-baseline");
    assert.equal(written.code, 0, written.out);
    git(root, "checkout", "--quiet", "-b", "feature");
    put(root, "src/clean.ts", "export const c = 2;\n");
    commit(root, "chore: touch\n\nLanes: all");
    const result = runGuard(root, "main...HEAD");
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /WARN map/, "code changed, map did not");
    assert.doesNotMatch(result.out, /WARN (protected|brand)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: protected and brand problems block, the map warning advises (exit 1 without --strict)", () => {
  const root = makeRepo();
  try {
    assert.equal(runGuard(root, "--write-baseline").code, 0);
    commit(root, "chore: baseline");
    git(root, "checkout", "--quiet", "-b", "feature");
    put(root, "src/shared.ts", "export const s = 2;\n");
    put(root, "src/a.ts", 'export const a = "Nultron Nultron";\n');
    commit(root, "fix: change shared code with no label");

    const loose = runGuard(root, "main...HEAD");
    assert.equal(loose.code, 1, loose.out);
    assert.match(loose.out, /WARN map: .*docs\/internal\/maps\/src\.md/);
    assert.match(loose.out, /BLOCK protected: .*src\/shared\.ts/);
    assert.match(loose.out, /BLOCK brand: src\/a\.ts .*Nultron.* 1 -> 2/);
    assert.match(loose.out, /2 blocking problem\(s\); exit 1/);

    const strict = runGuard(root, "main...HEAD", "--strict");
    assert.equal(strict.code, 1, strict.out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: a map warning alone stays advisory (exit 0), and --strict makes it fail", () => {
  const root = makeRepo();
  try {
    assert.equal(runGuard(root, "--write-baseline").code, 0);
    commit(root, "chore: baseline");
    git(root, "checkout", "--quiet", "-b", "feature");
    put(root, "src/clean.ts", "export const c = 2;\n");
    commit(root, "chore: touch\n\nLanes: all");
    const loose = runGuard(root, "main...HEAD");
    assert.equal(loose.code, 0, loose.out);
    assert.match(loose.out, /WARN map/);
    assert.match(loose.out, /advisory warning\(s\); exit 0/);
    assert.equal(runGuard(root, "main...HEAD", "--strict").code, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: a tester-only path in a diff to main blocks, exit 1 without --strict", () => {
  const root = makeRepo();
  try {
    assert.equal(runGuard(root, "--write-baseline").code, 0);
    commit(root, "chore: baseline");
    git(root, "checkout", "--quiet", "-b", "feature");
    put(root, "src/app.tester.env", "KEY=1\n");
    commit(root, "chore: sneak\n\nLanes: all");
    const result = runGuard(root, "main...HEAD");
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /BLOCK never-promote: src\/app\.tester\.env/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: a deleted never-promote path does not block, and the tester branch is never checked", () => {
  const root = makeRepo();
  try {
    put(root, "src/app.tester.env", "KEY=1\n");
    commit(root, "chore: base with a tester file");
    assert.equal(runGuard(root, "--write-baseline").code, 0);
    commit(root, "chore: baseline");
    git(root, "checkout", "--quiet", "-b", "feature");
    rmSync(path.join(root, "src", "app.tester.env"));
    commit(root, "chore: remove\n\nLanes: all");
    const deleted = runGuard(root, "main...HEAD");
    assert.equal(deleted.code, 0, deleted.out);
    assert.doesNotMatch(deleted.out, /never-promote/);

    git(root, "checkout", "--quiet", "-b", TESTER_BRANCH, "main");
    put(root, "src/app.tester.env", "KEY=2\n");
    commit(root, "tester: add\n\nLanes: all");
    const onTester = runGuard(root, "main...HEAD", "--branch", TESTER_BRANCH);
    assert.equal(onTester.code, 0, onTester.out);
    assert.match(onTester.out, /never-promote skipped \(the tester branch\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: a never-promote rule does not apply to a range whose base is not main", () => {
  const root = makeRepo();
  try {
    assert.equal(runGuard(root, "--write-baseline").code, 0);
    commit(root, "chore: baseline");
    git(root, "checkout", "--quiet", "-b", "feature");
    put(root, "src/app.tester.env", "KEY=1\n");
    commit(root, "chore: sneak\n\nLanes: all");
    const result = runGuard(root, "HEAD~1..HEAD");
    assert.equal(result.code, 0, result.out);
    assert.doesNotMatch(result.out, /never-promote/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: a protected file with no Lanes line blocks (exit 1 without --strict)", () => {
  const root = makeRepo();
  try {
    assert.equal(runGuard(root, "--write-baseline").code, 0);
    commit(root, "chore: baseline");
    git(root, "checkout", "--quiet", "-b", "feature");
    put(root, "src/shared.ts", "export const s = 7;\n");
    commit(root, "fix: shared, unlabelled");
    const result = runGuard(root, "main...HEAD");
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /BLOCK protected: src\/shared\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: a broken lanes.json blocks instead of passing silently", () => {
  const root = makeRepo();
  try {
    put(root, "lanes.json", "{ not json");
    const result = runGuard(root, "main...HEAD");
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /lane-guard: /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: a map change and a Lanes line silence the map and protected warnings", () => {
  const root = makeRepo();
  try {
    assert.equal(runGuard(root, "--write-baseline").code, 0);
    commit(root, "chore: baseline");
    git(root, "checkout", "--quiet", "-b", "feature");
    put(root, "src/shared.ts", "export const s = 3;\n");
    put(root, "docs/internal/maps/src.md", "# Map: src\n\nrefreshed\n");
    commit(root, "fix: labelled\n\nLanes: personal, enterprise, hyp-ai, tester");
    const result = runGuard(root, "main...HEAD", "--strict");
    assert.equal(result.code, 0, result.out);
    assert.doesNotMatch(result.out, /WARN/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: skips cleanly with no lanes.json, with no docs/internal, on an empty range", () => {
  const root = makeRepo();
  try {
    assert.equal(runGuard(root, "--write-baseline").code, 0);
    commit(root, "chore: baseline");
    const empty = runGuard(root, "main...HEAD", "--strict");
    assert.equal(empty.code, 0, empty.out);
    assert.match(empty.out, /skipped/);

    git(root, "checkout", "--quiet", "-b", "feature");
    put(root, "src/shared.ts", "export const s = 9;\n");
    commit(root, "fix: x");

    rmSync(path.join(root, "docs", "internal"), { recursive: true, force: true });
    const noDocs = runGuard(root, "main...HEAD", "--strict");
    assert.equal(noDocs.code, 0, noDocs.out);
    assert.match(noDocs.out, /skipped/);

    rmSync(path.join(root, "lanes.json"));
    const noLanes = runGuard(root, "main...HEAD", "--strict");
    assert.equal(noLanes.code, 0, noLanes.out);
    assert.match(noLanes.out, /skipped/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: an unresolvable range skips instead of failing", () => {
  const root = makeRepo();
  try {
    const result = runGuard(root, "origin/nope...HEAD", "--strict");
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /skipped/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
