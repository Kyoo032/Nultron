/**
 * Tests for scripts/release-web.mjs, the Enterprise release to Kyoo032/Nultron-Releases.
 *
 * Node's own runner, like scripts/review-proxy.test.mjs: repo tooling outside every workspace
 * package, so no vitest config collects it. `node --test "scripts/*.test.mjs"` runs it.
 *
 * Nothing here calls gh, docker or the network. Every release-web case drives `main` against a temp
 * repo root, a fake git (which "clones" by making a directory), and recording docker / tar / gh stubs.
 * The desktop cases at the end run apps/desktop/scripts/release-desktop.mjs --dry-run in a child
 * process, against a temp dist/. That script refuses off main, so the child is a copy in a temp repo on main
 * (desktopReleaseFixture): the same code, not this checkout's branch. Its git calls run in that temp repo only.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as sharedMarks from "./release-marks.mjs";
import { NDA_TERMS_PATH, parseNdaTerms, readNdaTerms } from "./release-nda.mjs";
import { DEPLOY_DOC_SECTIONS } from "./release-web-docs.mjs";
import {
  REQUIRED_SITE_FILES,
  SITE_FILE_MAX_BYTES,
  SitesError,
  bundlePathFor,
  readSiteFiles,
} from "./release-web-sites.mjs";
import {
  BUNDLE_FILES,
  OPTIONAL_ENV,
  caddyfileFrom,
  deployDoc,
  envExample,
  portalEnvExample,
  FORBIDDEN_MARKS,
  forbiddenMarksIn,
  forbiddenMarksInPublished,
  ENV_DEFAULTS,
  ghReleaseArgs,
  IMAGE_REPO,
  main,
  OPTIONAL_PORTAL_ENV,
  parseArgs,
  PORTAL_IMAGE_REPO,
  PROXY_IMAGE,
  RELEASE_REPO,
  RELEASE_REPO_URL,
  REQUIRED_ENV,
  REQUIRED_PORTAL_ENV,
  ReleaseError,
  releaseBody,
  renderBundle,
  tagProblem,
} from "./release-web.mjs";

const FULL_SHA = "0b73a68aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TAG = "ent-2026.09.23";
const CLEAN_NOTES = "# Nultron Enterprise, 23 September 2026\n\n- The warm desk is live.\n";
const IMAGE = `ghcr.io/kyoo032/nultron-ent:${TAG}`;
const PORTAL_IMAGE = `ghcr.io/kyoo032/nultron-portal:${TAG}`;
const CADDY_SOURCE =
  "# see packages/host/src/http-adapter.ts\n{\n\tadmin off\n}\n\n\n\n{$NULTRON_DOMAIN} {\n\t# comment\n\treverse_proxy 127.0.0.1:3000\n}\n";
const README = "# Nultron Enterprise\n";
const FAKE_NDA_TERMS = "# test terms only\nzebrapartner\n\n  Quokka Gateway  \n";
/** The git a dry run may run: reads of this repo only. */
const READ_ONLY_GIT = new Set(["status", "rev-parse", "show", "cat-file", "ls-tree"]);
/** The company sites' files at the released sha, as the fake git serves them (the real ones are read further down). */
const FAKE_SITE_FILES = {
  "webapp-deploy/sites/enable-sites.sh": '#!/bin/sh\n# switch\nexec "$@"\n',
  "webapp-deploy/sites/dpscloud.caddy":
    '# a comment that cites a source path: packages/host/x.ts\n{$DPS_DOMAIN} {\n\trespond "dps"\n}\n',
  "webapp-deploy/sites/tokotoken.caddy": '{$TOKOTOKEN_DOMAIN} {\n\trespond "toko"\n}\n',
  "webapp-deploy/sites/dpscloud/index.html": "<!doctype html><title>DPS Cloud</title>\n",
  "webapp-deploy/sites/tokotoken/index.html": "<!doctype html><title>Toko Token</title>\n",
};

const NUL = String.fromCharCode(0);
const refuse = (reason) => {
  throw new ReleaseError(reason);
};

/** readSiteFiles against a fake git that serves `files` ({ "webapp-deploy/sites/...": text }). */
function siteBundleFrom(files, tag = TAG) {
  const git = (args) => {
    if (args[0] === "ls-tree") return { status: 0, stdout: `${Object.keys(files).join(NUL)}${NUL}` };
    if (args[0] === "show") {
      const spec = args.at(-1);
      const path = spec.slice(spec.indexOf(":") + 1);
      return path in files ? { status: 0, stdout: files[path] } : { status: 128, stdout: "" };
    }
    return { status: 1, stdout: "" };
  };
  return readSiteFiles(FULL_SHA, tag, git, refuse);
}

/** The bundle's `sites/...` files for the fake sha. */
function fakeSiteBundle() {
  return siteBundleFrom(FAKE_SITE_FILES);
}

/** The bundle's `sites/...` files built from the real webapp-deploy/sites folder on disk. */
function realSiteFiles() {
  const dir = join(fileURLToPath(new URL("..", import.meta.url)), "webapp-deploy", "sites");
  const files = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath ?? entry.path, entry.name);
    files[`webapp-deploy/sites/${full.slice(dir.length + 1).replaceAll("\\", "/")}`] = readFileSync(full, "utf8");
  }
  return siteBundleFrom(files);
}

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fakeRepo(notesByTag, { ndaTerms = FAKE_NDA_TERMS } = {}) {
  const root = mkdtempSync(join(tmpdir(), "release-web-test-"));
  roots.push(root);
  mkdirSync(join(root, "docs", "public"), { recursive: true });
  if (ndaTerms !== null) {
    mkdirSync(dirname(join(root, NDA_TERMS_PATH)), { recursive: true });
    writeFileSync(join(root, NDA_TERMS_PATH), ndaTerms, "utf8");
  }
  for (const [tag, text] of Object.entries(notesByTag)) {
    writeFileSync(join(root, "docs", "public", `${tag}-notes.md`), text, "utf8");
  }
  return root;
}

/** The git subcommand, skipping leading `-c key=value` pairs. */
function subcommand(args) {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args[i];
}

/** Every file in the clone except .git, by path relative to it (forward slashes), nested folders included. */
function snapshot(dir) {
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
  const relative = (entry) =>
    join(entry.parentPath ?? entry.path, entry.name)
      .slice(dir.length + 1)
      .replaceAll("\\", "/");
  return Object.fromEntries(
    files
      .map((entry) => relative(entry))
      .filter((name) => name.split("/")[0] !== ".git")
      .map((name) => [name, readFileSync(join(dir, name), "utf8")]),
  );
}

/**
 * A fake git. Every call lands in `calls` with its cwd. `clone` makes the target directory with a
 * README, as Nultron-Releases' main has; `commit` snapshots the files in the clone at that moment.
 */
function fakeGit({
  dirty = false,
  known = [FULL_SHA],
  calls = [],
  commits = [],
  cloneReadme = README,
  missingAtSha = [],
  siteFiles = FAKE_SITE_FILES,
  branch = "main",
} = {}) {
  const handlers = {
    // `git cat-file -e <sha>:<path>`: does the released commit carry this file?
    "cat-file": (args) => ({ status: missingAtSha.some((path) => args.at(-1).endsWith(`:${path}`)) ? 128 : 0 }),
    status: (_args, cwd) => {
      if (cwd.endsWith("Nultron")) return { status: 0, stdout: "A  compose.yml\n" };
      return { status: 0, stdout: dirty ? " M AGENTS.md\n" : "" };
    },
    "rev-parse": (args) => {
      // `git rev-parse --abbrev-ref HEAD`: the checkout's branch, which a release must find on main.
      if (args.includes("--abbrev-ref")) return { status: 0, stdout: `${branch}\n` };
      const wanted = args.at(-1).replace("^{commit}", "");
      const hit = known.find((sha) => sha.startsWith(wanted));
      return hit ? { status: 0, stdout: `${hit}\n` } : { status: 1, stdout: "" };
    },
    // `git show <sha>:<path>`: the Caddyfile, or one of the company sites' files.
    show: (args) => {
      const path = args.at(-1).slice(args.at(-1).indexOf(":") + 1);
      if (path === "webapp-deploy/Caddyfile") return { status: 0, stdout: CADDY_SOURCE };
      return path in siteFiles ? { status: 0, stdout: siteFiles[path] } : { status: 128, stdout: "" };
    },
    "ls-tree": () => ({ status: 0, stdout: `${Object.keys(siteFiles).join(NUL)}${NUL}` }),
    config: (args) => ({ status: 0, stdout: args.at(-1) === "user.name" ? "rizky\n" : "rizky@example.com\n" }),
    clone: (args) => {
      const dir = args.at(-1);
      mkdirSync(join(dir, ".git"), { recursive: true });
      writeFileSync(join(dir, "README.md"), cloneReadme, "utf8");
      return { status: 0 };
    },
    commit: (args, cwd) => {
      commits.push({ args, cwd, files: snapshot(cwd) });
      return { status: 0 };
    },
    archive: () => ({ status: 0 }),
    add: () => ({ status: 0 }),
    push: () => ({ status: 0 }),
  };
  return (args, cwd) => {
    const sub = subcommand(args);
    calls.push({ args, cwd, sub });
    if (!handlers[sub]) throw new Error(`unexpected git ${args.join(" ")}`);
    return handlers[sub](args, cwd);
  };
}

const neverGh = () => assert.fail("gh must not run in a dry run");

function deps(root, gitOptions = {}) {
  const lines = [];
  const gitCalls = [];
  const commits = [];
  const dockerCalls = [];
  const tarCalls = [];
  const record = (list) => (args, cwd) => {
    list.push({ args, cwd });
    return { status: 0 };
  };
  return {
    repoRoot: root,
    git: fakeGit({ ...gitOptions, calls: gitCalls, commits }),
    docker: record(dockerCalls),
    tar: record(tarCalls),
    gh: neverGh,
    ghView: neverGh,
    log: (l) => lines.push(l),
    lines,
    gitCalls,
    commits,
    dockerCalls,
    tarCalls,
  };
}

function recordingGh() {
  const calls = [];
  return {
    calls,
    gh: (args) => {
      calls.push(args);
      return { status: 0 };
    },
    ghView: (tag) => {
      calls.push(["view", tag]);
      return { status: 0 };
    },
  };
}

// ---------- tag format ----------

test("accepts ent-YYYY.MM.DD and a same-day suffix from .2", () => {
  for (const tag of ["ent-2026.09.23", "ent-2026.09.23.2", "ent-2026.12.31.10", "ent-2028.02.29"]) {
    assert.equal(tagProblem(tag), null, tag);
  }
});

test("refuses malformed tags, impossible dates, and .0 / .1 suffixes", () => {
  const bad = [
    "v0.15.0",
    "2026.09.23",
    "ent-2026.9.23",
    "ent-2026-09-23",
    "ent-2026.09.23.",
    "ent-2026.09.23.01",
    "ENT-2026.09.23",
    "ent-2026.09.23 ",
    "ent-2026.13.01",
    "ent-2026.02.30",
    "ent-2027.02.29",
    "ent-2026.09.23.0",
    "ent-2026.09.23.1",
    "",
    undefined,
  ];
  for (const tag of bad) assert.notEqual(tagProblem(tag), null, String(tag));
});

// ---------- notes refusal list ----------

test("the refusal list is exactly the five marks", () => {
  assert.deepEqual(FORBIDDEN_MARKS, ["Claude", "Anthropic", "agent", "Co-Authored", "docs/internal"]);
});

test("each mark is caught case-insensitively, including inside a longer word", () => {
  const cases = [
    ["Written with claude.", ["Claude"]],
    ["ANTHROPIC", ["Anthropic"]],
    ["Custom Agents are parked.", ["agent"]],
    ["See agentforge@abc", ["agent"]],
    ["co-authored-by: someone", ["Co-Authored"]],
    ["details in DOCS/INTERNAL/unreleased.md", ["docs/internal"]],
  ];
  for (const [text, expected] of cases) assert.deepEqual(forbiddenMarksIn(text), expected, text);
  assert.deepEqual(forbiddenMarksIn(CLEAN_NOTES), []);
});

test("main refuses a notes file that carries a mark, and names the marks", () => {
  const root = fakeRepo({ [TAG]: "# Notes\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n" });
  assert.throws(
    () => main(["--tag", TAG, "--sha", FULL_SHA, "--dry-run"], deps(root)),
    (error) => error instanceof ReleaseError && /"Claude", "Anthropic", "Co-Authored"/.test(error.message),
  );
});

test("main refuses a missing or empty notes file", () => {
  const missing = fakeRepo({});
  assert.throws(() => main(["--tag", TAG, "--sha", FULL_SHA, "--dry-run"], deps(missing)), /notes file not found/);
  const empty = fakeRepo({ [TAG]: "  \n" });
  assert.throws(() => main(["--tag", TAG, "--sha", FULL_SHA, "--dry-run"], deps(empty)), /notes file is empty/);
});

// ---------- NDA terms, read from a gitignored file ----------

test("parseNdaTerms keeps one lowercased term per line and drops blanks and comments", () => {
  assert.deepEqual(parseNdaTerms(FAKE_NDA_TERMS), ["zebrapartner", "quokka gateway"]);
  assert.deepEqual(parseNdaTerms("# only a comment\r\n\r\n"), []);
  assert.deepEqual(parseNdaTerms("\uFEFFzebrapartner\r\n"), ["zebrapartner"]);
});

test("the NDA terms file is gitignored", () => {
  const check = spawnSync("git", ["check-ignore", "-q", NDA_TERMS_PATH], { cwd: REPO_ROOT });
  assert.equal(check.status, 0, `${NDA_TERMS_PATH} must be gitignored`);
});

test("main refuses a missing or empty NDA terms file before the target check, dry runs included", () => {
  const missing = fakeRepo({ [TAG]: CLEAN_NOTES }, { ndaTerms: null });
  const d = deps(missing);
  assert.throws(
    () => main(["--tag", TAG, "--sha", FULL_SHA, "--dry-run"], d),
    (error) =>
      error instanceof ReleaseError && error.message.startsWith(`NDA terms file not found: ${NDA_TERMS_PATH}`),
  );
  assert.equal(
    d.lines.some((line) => line.startsWith("ok - target")),
    false,
  );
  const empty = fakeRepo({ [TAG]: CLEAN_NOTES }, { ndaTerms: "# nothing yet\n\n" });
  assert.throws(() => main(["--tag", TAG, "--sha", FULL_SHA, "--dry-run"], deps(empty)), /NDA terms file has no terms/);
});

test("main refuses notes that carry an NDA term in any letter case, and never prints the term", () => {
  const root = fakeRepo({ [TAG]: "# Notes\n\nNow live for ZebraPartner.\n" });
  assert.throws(
    () => main(["--tag", TAG, "--sha", FULL_SHA, "--dry-run"], deps(root)),
    (error) =>
      error instanceof ReleaseError &&
      error.message === `refusing to publish docs/public/${TAG}-notes.md: it contains 1 term(s) from ${NDA_TERMS_PATH}` &&
      !/zebra/i.test(error.message),
  );
});

test("a company site file that carries an NDA term stops the release before any clone", () => {
  const root = fakeRepo({ [TAG]: CLEAN_NOTES });
  const siteFiles = {
    ...FAKE_SITE_FILES,
    "webapp-deploy/sites/dpscloud/index.html": "<!doctype html><p>Trusted by Quokka Gateway</p>\n",
  };
  const d = deps(root, { siteFiles });
  assert.throws(
    () => main(["--tag", TAG, "--sha", FULL_SHA, "--dry-run"], d),
    /refusing to publish sites\/dpscloud\/index\.html: it contains 1 term\(s\)/,
  );
  assert.ok(!d.gitCalls.some((call) => call.sub === "clone"));
});

test("a file in the release repo that carries an NDA term stops the push", () => {
  const root = fakeRepo({ [TAG]: CLEAN_NOTES });
  const d = deps(root, { cloneReadme: "# Nultron Enterprise\n\nBuilt with zebrapartner.\n" });
  assert.throws(
    () => main(["--tag", TAG, "--sha", FULL_SHA, "--skip-image"], { ...d, ...recordingGh() }),
    /refusing to publish README\.md: it contains 1 term\(s\)/,
  );
  assert.equal(d.commits.length, 0);
  assert.ok(!d.gitCalls.some((call) => call.sub === "push"));
});

test("a clean dry run reports how many NDA terms it checked", () => {
  const root = fakeRepo({ [TAG]: CLEAN_NOTES });
  const d = deps(root);
  main(["--tag", TAG, "--sha", FULL_SHA, "--dry-run"], d);
  assert.ok(d.lines.includes("ok - bundle has none of the banned marks and none of the 2 NDA terms"));
});

// ---------- rails before the notes ----------

test("main refuses a dirty tree unless --allow-dirty, and an unknown sha", () => {
  const root = fakeRepo({ [TAG]: CLEAN_NOTES });
  assert.throws(
    () => main(["--tag", TAG, "--sha", FULL_SHA, "--dry-run"], deps(root, { dirty: true })),
    /working tree is dirty/,
  );
  assert.doesNotThrow(() =>
    main(["--tag", TAG, "--sha", FULL_SHA, "--dry-run", "--allow-dirty"], deps(root, { dirty: true })),
  );
  assert.throws(
    () => main(["--tag", TAG, "--sha", "deadbeef", "--dry-run"], deps(root)),
    /does not exist in this repo/,
  );
  assert.throws(() => main(["--tag", TAG, "--sha", "HEAD~1", "--dry-run"], deps(root)), /not a hex commit id/);
});

test("main refuses a sha that predates the portal image's files, before any docker command", () => {
  const root = fakeRepo({ [TAG]: CLEAN_NOTES });
  for (const missing of [
    "webapp-deploy/portal.Dockerfile",
    "webapp-deploy/portal-entry.sh",
    "webapp-deploy/k8s/base/scripts/prepare-db.mjs",
  ]) {
    const d = deps(root, { missingAtSha: [missing] });
    assert.throws(
      () => main(["--tag", TAG, "--sha", FULL_SHA], d),
      (error) => error instanceof ReleaseError && error.message.includes(missing),
    );
    assert.deepEqual(d.dockerCalls, [], "nothing was built");
  }
});

test("parseArgs requires --tag and --sha and rejects unknown flags", () => {
  assert.throws(() => parseArgs(["--sha", FULL_SHA]), /--tag is required/);
  assert.throws(() => parseArgs(["--tag", TAG]), /--sha is required/);
  assert.throws(() => parseArgs(["--tag", "--sha", FULL_SHA]), /--tag needs a value/);
  assert.throws(() => parseArgs(["--tag", TAG, "--sha", FULL_SHA, "--push"]), /unknown argument --push/);
});

// ---------- dry run ----------

test("dry run builds the gh argv and the body, and never runs gh", () => {
  const root = fakeRepo({ [TAG]: CLEAN_NOTES });
  const d = deps(root);
  const result = main(["--tag", TAG, "--sha", FULL_SHA.slice(0, 7), "--dry-run"], d);
  assert.equal(result.published, false);
  assert.deepEqual(result.args.slice(0, 8), [
    "release",
    "create",
    TAG,
    "--repo",
    RELEASE_REPO,
    "--title",
    TAG,
    "--notes-file",
  ]);
  assert.equal(result.args.length, 9, "no assets, no --draft, nothing after the notes file");
  assert.match(result.args[8], new RegExp(`${TAG}-body\\.md$`));
  assert.equal(RELEASE_REPO, "Kyoo032/Nultron-Releases");
  assert.equal(RELEASE_REPO_URL, "https://github.com/Kyoo032/Nultron-Releases.git");
  assert.equal(
    result.body,
    `${CLEAN_NOTES.trimEnd()}\n\nSource: agentforge@${FULL_SHA}\nImage: ${IMAGE}\nPortal image: ${PORTAL_IMAGE}\n`,
    "full sha, not the short one, then both images",
  );
  assert.ok(!result.args.includes("push"), "never a push");
  assert.ok(d.lines.some((line) => line.startsWith(`gh release create ${TAG} --repo ${RELEASE_REPO}`)));
  assert.ok(d.lines.some((line) => line.startsWith("dry run, nothing published")));
});

test("--draft is passed through to gh", () => {
  assert.deepEqual(ghReleaseArgs(TAG, "body.md", { draft: true }).at(-1), "--draft");
  assert.equal(releaseBody("x\n\n\n", FULL_SHA), `x\n\nSource: agentforge@${FULL_SHA}\n`);
});

test("a real run calls gh once with the dry-run argv, then checks the release is visible", () => {
  const root = fakeRepo({ [TAG]: CLEAN_NOTES });
  const calls = [];
  const d = {
    ...deps(root),
    gh: (args) => {
      calls.push(args);
      return { status: 0 };
    },
    ghView: (tag) => {
      calls.push(["view", tag]);
      return { status: 0 };
    },
  };
  const result = main(["--tag", TAG, "--sha", FULL_SHA], d);
  assert.equal(result.published, true);
  assert.deepEqual(calls, [result.args, ["view", TAG]]);
});

// ---------- the deploy bundle ----------

test("compose.yml pins both images to the tag, and the proxy and database to a tag, and builds nothing", () => {
  const compose = renderBundle(TAG, CADDY_SOURCE)["compose.yml"];
  assert.equal(IMAGE_REPO, "ghcr.io/kyoo032/nultron-ent");
  assert.equal(PORTAL_IMAGE_REPO, "ghcr.io/kyoo032/nultron-portal");
  assert.ok(serviceBlock(compose, "app").includes(`    image: ${IMAGE}\n`), "app image pinned to the tag");
  for (const name of ["portal", "portal-prepare"]) {
    assert.ok(
      serviceBlock(compose, name).includes(`    image: ${PORTAL_IMAGE}\n`),
      `${name}: portal image pinned to the tag`,
    );
  }
  assert.equal(
    compose.match(/image: ghcr\.io/g).length,
    3,
    "the app image once, the portal image twice, nothing else from ghcr",
  );
  assert.equal(
    PROXY_IMAGE,
    "caddy:2.11-alpine",
    "the proxy is pinned to a minor: the sign-in log filters need Caddy 2.8+",
  );
  assert.ok(serviceBlock(compose, "proxy").includes(`    image: ${PROXY_IMAGE}\n`));
  assert.doesNotMatch(compose, /^\s*build:/m, "the server never builds");
  assert.doesNotMatch(compose, /:latest\b/, "never a floating tag");
  assert.doesNotMatch(compose, /caddy:2-alpine/, "no floating major tag for the proxy");
  assert.match(compose, /AGENTFORGE_SERVER: "1"/, "hosted mode is pinned, not left to .env");
  assert.match(compose, /\.\/Caddyfile:\/etc\/caddy\/Caddyfile:ro/);
});

/** Every `NAME=value` line of an env template, in order. */
function assignments(env) {
  return env
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]);
}

test(".env.example and portal.env.example name every required variable, empty unless the template has a default", () => {
  const bundle = renderBundle(TAG, CADDY_SOURCE);
  for (const [file, required, optional] of [
    [".env.example", REQUIRED_ENV, []],
    ["portal.env.example", REQUIRED_PORTAL_ENV, OPTIONAL_PORTAL_ENV],
  ]) {
    const names = assignments(bundle[file]).map(([name]) => name);
    // What nothing refuses to boot without may stand anywhere in the file; what is required is all there, in order.
    assert.deepEqual(
      names.filter((name) => !optional.includes(name)),
      required,
      file,
    );
    assert.deepEqual(
      names.filter((name) => optional.includes(name)),
      optional,
      file,
    );
    for (const [name, value] of assignments(bundle[file])) {
      assert.equal(value, ENV_DEFAULTS[name] ?? "", `${file}: ${name}`);
    }
  }
  // The two files never share a name: a portal secret in the app's file is the leak the split exists to prevent.
  const app = new Set(REQUIRED_ENV);
  assert.deepEqual(
    REQUIRED_PORTAL_ENV.filter((name) => app.has(name)),
    [],
  );
  assert.deepEqual(
    OPTIONAL_PORTAL_ENV.filter((name) => app.has(name)),
    [],
  );
  assert.deepEqual(
    Object.keys(ENV_DEFAULTS).filter(
      (name) => !app.has(name) && !REQUIRED_PORTAL_ENV.includes(name) && !OPTIONAL_PORTAL_ENV.includes(name),
    ),
    [],
    "a default for a name no template carries",
  );
});

test("portal.env.example sets the sign-in mode to password, says code is still selectable, and the compose files leave it to portal.env", () => {
  const bundle = renderBundle(TAG, CADDY_SOURCE);
  const example = bundle["portal.env.example"];
  // Owner decision 2026-10-09: the Enterprise bundle signs people in with a username and a password by default.
  assert.equal(ENV_DEFAULTS.PORTAL_SIGNIN_MODE, "password");
  const lines = example.split("\n");
  assert.ok(lines.includes("PORTAL_SIGNIN_MODE=password"), "the line is there, uncommented, set to password");
  assert.equal(lines.filter((line) => line.startsWith("PORTAL_SIGNIN_MODE=")).length, 1, "exactly one assignment");
  const comment = lines
    .slice(0, lines.indexOf("PORTAL_SIGNIN_MODE=password"))
    .filter((line) => line.startsWith("#"))
    .at(-1);
  assert.match(comment ?? "", /\bpassword\b.*default/i, "the comment above it says password is the default");
  assert.match(comment ?? "", /\bcode\b/, "and names code as the other value");
  assert.match(comment ?? "", /account/i, "and says an operator creates the accounts");
  assert.match(comment ?? "", /SMTP/, "and says the SMTP settings may stay blank");
  // Password mode needs no mail: the SMTP login stays an empty secret, and the portal boots with it empty.
  const values = Object.fromEntries(assignments(example));
  assert.equal(values.PORTAL_SMTP_USER, "");
  assert.equal(values.PORTAL_SMTP_PASS, "");
  // Reaches the container the way every other portal setting does: through the env_file both services load. A
  // value pinned under `environment:` would WIN over portal.env and make the line above a lie.
  const code = (compose, name) =>
    serviceBlock(compose, name)
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
  for (const compose of [bundle["compose.yml"], SOURCE_COMPOSE]) {
    for (const name of ["portal", "portal-prepare"]) {
      assert.match(code(compose, name), /- path: portal\.env\b/, `${name} loads portal.env`);
      assert.doesNotMatch(code(compose, name), /PORTAL_SIGNIN_MODE/, `${name} must not pin the mode`);
    }
  }
});

test("DEPLOY.md tells the operator to create the first owner account, that no mail sender is needed, and how to go back to code", () => {
  const doc = deployDoc(TAG);
  assert.match(doc, /PORTAL_SIGNIN_MODE=password/);
  assert.match(doc, /scripts\/account\.ts create .*--role owner/, "names the portal account command");
  assert.match(doc, /before anyone can sign in/i, "no one signs in until the owner account exists");
  assert.match(doc, /no mail sender|no e-mail is sent|needs no mail/i, "says no mail sender is needed");
  assert.match(doc, /PORTAL_SIGNIN_MODE=code/, "says how to switch back to the e-mailed code");
  assert.match(doc, /SR-165/, "points at the residual risks");
  // The seed step must come before the account step, and neither may be told to put the one-time code in a mailbox.
  assert.ok(doc.indexOf("scripts/seed.ts") < doc.indexOf("scripts/account.ts"));
  assert.doesNotMatch(doc, /receive the code on a real inbox/i);
});

test("the SES defaults are implicit TLS on 465, which the portal's PORTAL_SMTP_SECURE=1 selects", () => {
  assert.equal(ENV_DEFAULTS.PORTAL_SMTP_HOST, "sg-smtp.qcloudmail.com");
  assert.equal(ENV_DEFAULTS.PORTAL_SMTP_PORT, "465");
  assert.equal(ENV_DEFAULTS.PORTAL_SMTP_SECURE, "1");
});

test("the portal's secrets are never in the app's file, and the compose files load them only on the portal side", () => {
  const bundle = renderBundle(TAG, CADDY_SOURCE);
  // Comments are not configuration: the assertions read each service without them.
  const code = (compose, name) =>
    serviceBlock(compose, name)
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
  for (const compose of [bundle["compose.yml"], SOURCE_COMPOSE]) {
    assert.match(code(compose, "app"), /- path: \.env\b/);
    assert.doesNotMatch(code(compose, "app"), /portal\.env/, "the app must not load portal.env");
    assert.doesNotMatch(code(compose, "proxy"), /^\s*env_file:/m, "the proxy loads no env file at all");
    for (const name of ["portal", "portal-prepare", "portal-db"]) {
      assert.match(code(compose, name), /- path: portal\.env\b/, `${name} loads portal.env`);
      assert.doesNotMatch(code(compose, name), /- path: \.env\b/, `${name} must not load the app's .env`);
    }
  }
});

test("the Caddyfile loses its comment lines, and every bundle file passes the mark check", () => {
  const bundle = renderBundle(TAG, CADDY_SOURCE);
  assert.deepEqual(Object.keys(bundle), BUNDLE_FILES);
  assert.doesNotMatch(bundle.Caddyfile, /packages\/host|# comment/);
  assert.match(bundle.Caddyfile, /reverse_proxy 127\.0\.0\.1:3000/);
  for (const [name, text] of Object.entries(bundle)) assert.deepEqual(forbiddenMarksInPublished(text), [], name);
  assert.deepEqual(forbiddenMarksInPublished("AGENTFORGE_SECRETS_KEY and agentforge@abc"), []);
  assert.deepEqual(forbiddenMarksInPublished("Custom Agents are parked"), ["agent"]);
});

test("--dry-run runs no docker, no tar, no gh, and only read-only git in this repo", () => {
  const root = fakeRepo({ [TAG]: CLEAN_NOTES });
  const d = deps(root);
  const result = main(["--tag", TAG, "--sha", FULL_SHA, "--dry-run"], d);
  assert.equal(result.published, false);
  assert.deepEqual(d.dockerCalls, []);
  assert.deepEqual(d.tarCalls, []);
  assert.ok(d.gitCalls.length > 0);
  for (const call of d.gitCalls) {
    assert.ok(READ_ONLY_GIT.has(call.sub), `git ${call.sub} in a dry run`);
    assert.equal(call.cwd, root);
  }
  assert.equal(existsSync(result.workDir), false, "the temp dir is gone");
});

test("a real run builds from a git archive of the sha, pushes the image, then the bundle, then the release", () => {
  const root = fakeRepo({ [TAG]: CLEAN_NOTES });
  const d = deps(root);
  const gh = recordingGh();
  const result = main(["--tag", TAG, "--sha", FULL_SHA], { ...d, ...gh });
  const archive = d.gitCalls.find((call) => call.sub === "archive");
  assert.equal(archive.cwd, root);
  assert.equal(archive.args.at(-1), FULL_SHA, "the image comes from <sha>, not the working tree");
  // The app image cannot run the portal, so the portal has its own Dockerfile, built from the same extracted
  // archive. Both are built before either is pushed, so a failed portal build leaves nothing on the registry.
  assert.deepEqual(
    d.dockerCalls.map((call) => call.args),
    [
      ["build", "-f", "webapp-deploy/Dockerfile", "-t", IMAGE, "."],
      ["build", "-f", "webapp-deploy/portal.Dockerfile", "-t", PORTAL_IMAGE, "."],
      ["push", IMAGE],
      ["push", PORTAL_IMAGE],
    ],
  );
  assert.ok(d.dockerCalls.every((call) => call.cwd.endsWith("context") && call.cwd !== root));
  const order = d.gitCalls.map((call) => call.sub);
  assert.ok(order.indexOf("archive") < order.indexOf("clone"), "image before bundle");
  assert.deepEqual(gh.calls, [result.args, ["view", TAG]]);
  assert.equal(existsSync(result.workDir), false, "the temp dir, clone and context are gone");
});

test("the temp-dir bundle commit holds exactly the five files and the company sites' files, as rizky, 'Release <tag>', no trailers", () => {
  const root = fakeRepo({ [TAG]: CLEAN_NOTES });
  const d = deps(root);
  const result = main(["--tag", TAG, "--sha", FULL_SHA, "--skip-image"], { ...d, ...recordingGh() });
  assert.equal(d.commits.length, 1);
  const [commit] = d.commits;
  assert.deepEqual(commit.files, { ...renderBundle(TAG, CADDY_SOURCE, fakeSiteBundle()), "README.md": README });
  assert.deepEqual(
    Object.keys(commit.files)
      .filter((name) => name.startsWith("sites/"))
      .sort(),
    [
      "sites/dpscloud.caddy",
      "sites/dpscloud/index.html",
      "sites/enable-sites.sh",
      "sites/tokotoken.caddy",
      "sites/tokotoken/index.html",
    ],
  );
  const add = d.gitCalls.find((call) => call.sub === "add");
  assert.deepEqual(
    add.args.slice(0, 3),
    ["add", "--all", "--"],
    "--all, so a file dropped from sites/ is dropped from the repo too",
  );
  assert.ok(add.args.includes("sites"), "the whole sites/ folder is staged");
  assert.ok(commit.cwd.startsWith(result.workDir) && commit.cwd.endsWith("Nultron"), "a temp clone");
  assert.deepEqual(commit.args.slice(-4), ["commit", "--quiet", "-m", `Release ${TAG}`], "plain message, no trailer");
  assert.ok(commit.args.includes("user.name=rizky"));
  const clone = d.gitCalls.find((call) => call.sub === "clone");
  assert.ok(clone.args.includes(RELEASE_REPO_URL));
  const pushes = d.gitCalls.filter((call) => call.sub === "push");
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].cwd, commit.cwd, "only the temp clone is pushed, never this repo");
  assert.deepEqual(pushes[0].args.slice(-2), ["origin", "HEAD:main"]);
  assert.equal(existsSync(commit.cwd), false, "the clone is deleted");
});

test("--skip-image skips docker and the archive only; bundle and release still run", () => {
  const root = fakeRepo({ [TAG]: CLEAN_NOTES });
  const d = deps(root);
  const gh = recordingGh();
  const result = main(["--tag", TAG, "--sha", FULL_SHA, "--skip-image"], { ...d, ...gh });
  assert.deepEqual(d.dockerCalls, []);
  assert.deepEqual(d.tarCalls, []);
  assert.ok(!d.gitCalls.some((call) => call.sub === "archive"));
  assert.ok(d.gitCalls.some((call) => call.sub === "push"));
  assert.deepEqual(gh.calls, [result.args, ["view", TAG]]);
  assert.ok(
    result.body.endsWith(`Image: ${IMAGE}\nPortal image: ${PORTAL_IMAGE}\n`),
    "the body still names both pinned images",
  );
});

test("a file in the release repo that carries a banned mark stops the push", () => {
  const root = fakeRepo({ [TAG]: CLEAN_NOTES });
  const d = deps(root, { cloneReadme: "Written by an agent.\n" });
  assert.throws(
    () => main(["--tag", TAG, "--sha", FULL_SHA, "--skip-image"], { ...d, ...recordingGh() }),
    /refusing to publish README\.md: it contains "agent"/,
  );
  assert.equal(d.commits.length, 0);
  assert.ok(!d.gitCalls.some((call) => call.sub === "push"));
});

// ---------- what the bundle ships: the real Caddyfile and both compose files ----------

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_CADDYFILE = readFileSync(join(REPO_ROOT, "webapp-deploy", "Caddyfile"), "utf8");
const SOURCE_COMPOSE = readFileSync(join(REPO_ROOT, "webapp-deploy", "compose.yml"), "utf8");

/** One service of a compose file: the lines under its key, up to the next line at its depth or less. */
function serviceBlock(compose, name) {
  const lines = compose.replace(/\r\n/g, "\n").split("\n");
  const start = lines.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `no ${name} service`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trim() !== "" && !line.startsWith("   "));
  return rest.slice(0, end < 0 ? rest.length : end).join("\n");
}

/** The names under a service's `environment:` map. */
function environmentNames(block) {
  const match = /^ {4}environment:\n((?: {6}.*\n?)*)/m.exec(block);
  return match ? [...match[1].matchAll(/^ {6}([A-Za-z_]\w*):/gm)].map((m) => m[1]).sort() : [];
}

/** Every env var a Caddyfile reads, `{$NAME}` at adapt time or `{env.NAME}` at run time; comments excluded. */
function caddyEnvNames(source) {
  const names = [...caddyfileFrom(source, TAG).matchAll(/\{(?:\$|env\.)([A-Za-z_]\w*)/g)].map((m) => m[1]);
  return [...new Set(names)].sort();
}

test("the shipped Caddyfile keeps the sign-in code and state out of the access log AND the default log (SR-72)", () => {
  const shipped = renderBundle(TAG, SOURCE_CADDYFILE).Caddyfile;
  // The request URI and Referer, and the portal's redirect Location: the portal sits behind this proxy, so its
  // 302 to /auth/callback?code=...&state=... would otherwise be written into the access line's response headers.
  for (const field of ["request>uri", "request>headers>Referer", "resp_headers>Location"]) {
    const filter = new RegExp(`^\\s*${field} query \\{\\n\\s*delete code\\n\\s*delete state\\n\\s*\\}$`, "m");
    assert.match(shipped, filter, `${field} is not filtered in the bundle's Caddyfile`);
  }
  // One list of filters, imported by BOTH loggers: the site access log and Caddy's default logger, which is
  // where the error line for a failed upstream request (with the request's full URI) is written.
  assert.equal(shipped.match(/^\(sign_in_filters\) \{$/gm)?.length, 1, "one filter list");
  assert.equal(
    shipped.match(/^\s*import sign_in_filters$/gm)?.length,
    2,
    "imported by the default log and the access log",
  );
  assert.match(
    shipped,
    /^\tlog default \{\n\t\toutput stderr\n\t\tformat filter \{\n\t\t\twrap json\n\t\t\tfields \{\n\t\t\t\timport sign_in_filters\n/m,
  );
  assert.equal(shipped.match(/^\s*import access_log$/gm)?.length, 2, "both sites use the access log");
  const count = (char) => shipped.split(char).length - 1;
  assert.equal(count("{"), count("}"), "unbalanced braces in the shipped Caddyfile");
});

test("the shipped Caddyfile blocks the billing webhook at the edge, before the app, until a provider is bound (SR-03)", () => {
  const shipped = renderBundle(TAG, SOURCE_CADDYFILE).Caddyfile;
  assert.match(shipped, /^\t@billing_webhook path \/api\/v1\/billing\/webhook\*$/m);
  assert.match(shipped, /^\trespond @billing_webhook 404$/m);
  const appSite = shipped.slice(shipped.indexOf("\n{$NULTRON_DOMAIN} {"), shipped.indexOf("\n{$PORTAL_DOMAIN} {"));
  assert.ok(appSite.indexOf("respond @billing_webhook 404") > 0, "the rule is in the app's site block");
  assert.ok(
    appSite.indexOf("respond @billing_webhook 404") < appSite.indexOf("reverse_proxy 127.0.0.1:3000"),
    "the 404 is written before the app is proxied to",
  );
});

test("the shipped Caddyfile serves the portal on its own name, with its own headers, from the portal container only", () => {
  const shipped = renderBundle(TAG, SOURCE_CADDYFILE).Caddyfile;
  const portalSite = shipped.slice(shipped.indexOf("\n{$PORTAL_DOMAIN} {"));
  assert.match(portalSite, /reverse_proxy portal:4000 \{/);
  assert.match(portalSite, /health_uri \/healthz/);
  assert.match(portalSite, /^\t\tStrict-Transport-Security "max-age=31536000; includeSubDomains"$/m);
  assert.doesNotMatch(
    portalSite,
    /Content-Security-Policy/,
    "the portal sets its own CSP; the app's must not replace it",
  );
  assert.doesNotMatch(portalSite, /127\.0\.0\.1:3000/, "the portal site never proxies to the app");
  assert.doesNotMatch(portalSite, /billing/, "no billing rule belongs on the portal's name");
  assert.match(
    shipped,
    /^http:\/\/\{\$NULTRON_DOMAIN\}, http:\/\/\{\$PORTAL_DOMAIN\} \{\n\tredir https:\/\/\{host\}\{uri\} permanent\n\}$/m,
  );
});

test("the proxy gets exactly what the Caddyfile and the site files read, never the whole .env, in both compose files", () => {
  assert.deepEqual(
    caddyEnvNames(SOURCE_CADDYFILE),
    ["NULTRON_DOMAIN", "PORTAL_DOMAIN"],
    "the Caddyfile itself still reads only Nultron's two names (SR-73)",
  );
  const sites = realSiteFiles();
  const siteNames = Object.entries(sites)
    .filter(([path]) => path.endsWith(".caddy"))
    .flatMap(([, text]) => [...text.matchAll(/\{\$([A-Za-z_]\w*)/g)].map((m) => m[1]));
  assert.deepEqual(
    [...new Set(siteNames)].sort(),
    ["DPS_DOMAIN", "TOKOTOKEN_DOMAIN"],
    "each site file reads its own one variable",
  );
  const read = [...new Set([...caddyEnvNames(SOURCE_CADDYFILE), ...siteNames])].sort();
  const bundle = renderBundle(TAG, SOURCE_CADDYFILE, sites)["compose.yml"];
  for (const [name, compose] of [
    ["the bundle", bundle],
    ["webapp-deploy/compose.yml", SOURCE_COMPOSE],
  ]) {
    const proxy = serviceBlock(compose, "proxy");
    assert.doesNotMatch(proxy, /^\s*env_file:/m, `${name}: the proxy must not load .env`);
    assert.deepEqual(environmentNames(proxy), read, `${name}: the proxy's environment`);
    assert.match(serviceBlock(compose, "app"), /^\s*env_file:/m, `${name}: the app still loads .env`);
  }
  assert.match(serviceBlock(bundle, "proxy"), /NULTRON_DOMAIN: \$\{NULTRON_DOMAIN:\?/, "the bundle needs a domain");
  assert.match(
    serviceBlock(bundle, "proxy"),
    /PORTAL_DOMAIN: \$\{PORTAL_DOMAIN:\?/,
    "the bundle needs a portal domain",
  );
  // The two company names are optional: empty is allowed, and means that site is not served.
  for (const name of ["DPS_DOMAIN", "TOKOTOKEN_DOMAIN"]) {
    assert.match(
      serviceBlock(bundle, "proxy"),
      new RegExp(`${name}: \\$\\{${name}:-\\}`),
      `${name} is optional in the bundle`,
    );
  }
});

// ---------- the same refusal list on the Personal release ----------

// The files release-desktop.mjs reads or imports. Its checkCheckout() refuses off main, so these cases cannot
// run it from a feature checkout: they run a copy of exactly these files in a temp repo whose HEAD is main.
const DESKTOP_RELEASE_FILES = [
  "apps/desktop/scripts/release-desktop.mjs",
  "apps/desktop/scripts/release-artifacts.mjs",
  "apps/desktop/package.json",
  "apps/desktop/branding/agentforge/brand.json",
  "scripts/release-marks.mjs",
  "scripts/where-am-i.mjs",
];
let desktopFixture;

function desktopReleaseFixture() {
  if (desktopFixture) return desktopFixture;
  const dir = tempDir("release-desktop-repo-");
  for (const rel of DESKTOP_RELEASE_FILES) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    copyFileSync(join(REPO_ROOT, rel), join(dir, rel));
  }
  const init = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const head = spawnSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: dir, encoding: "utf8" });
  assert.equal(head.status, 0, head.stderr);
  // An unborn branch reads as detached to `git branch --show-current`, so the fixture needs one commit on main.
  const commit = spawnSync(
    "git",
    [
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
    ],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(commit.status, 0, commit.stderr);
  desktopFixture = join(dir, "apps", "desktop", "scripts", "release-desktop.mjs");
  return desktopFixture;
}

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function notesAt(relativePath, text) {
  const file = join(tempDir("release-desktop-notes-"), relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
  return file;
}

/**
 * A dist/ that release-desktop.mjs accepts: one Setup exe, its blockmap, and a latest.yml that matches.
 * The exe name comes from the desktop package's own `build.artifactName`, so this fixture follows the
 * installer name instead of repeating it (release-desktop.mjs's ARTIFACT_PREFIX must agree with it).
 */
function fakeDesktopDist() {
  const { version, build } = JSON.parse(readFileSync(join(REPO_ROOT, "apps", "desktop", "package.json"), "utf8"));
  const dist = tempDir("release-desktop-dist-");
  const exeName = build.artifactName.replace(/\$\{version\}/, version).replace(/\$\{ext\}/, "exe");
  const exe = Buffer.from("not an installer");
  writeFileSync(join(dist, exeName), exe);
  writeFileSync(join(dist, `${exeName}.blockmap`), "blockmap");
  const sha512 = createHash("sha512").update(exe).digest("base64");
  const url = exeName.replace(/ /g, "-");
  const latest = [
    `version: ${version}`,
    "files:",
    `  - url: ${url}`,
    `    sha512: ${sha512}`,
    `    size: ${exe.length}`,
    `path: ${url}`,
    `sha512: ${sha512}`,
  ];
  writeFileSync(join(dist, "latest.yml"), `${latest.join("\n")}\n`, "utf8");
  return dist;
}

/** release-desktop.mjs exits the process on refusal, so it is run, not imported. --dry-run: gh never runs. */
function desktopDryRun(notesFile, cwd = process.cwd()) {
  // --allow-retired: these cases are about notes and dist, not the retired refusal (release-desktop-retired.test.mjs).
  const args = [
    desktopReleaseFixture(),
    "--dry-run",
    "--allow-dirty",
    "--allow-retired",
    "--dist",
    fakeDesktopDist(),
    "--notes",
    notesFile,
  ];
  return spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
}

test("both release scripts share one refusal list", () => {
  assert.equal(forbiddenMarksIn, sharedMarks.forbiddenMarksIn);
  assert.equal(FORBIDDEN_MARKS, sharedMarks.FORBIDDEN_MARKS);
  assert.ok(Object.isFrozen(FORBIDDEN_MARKS));
});

test("a docs/internal path is caught in any letter case, with either separator, and through ..", () => {
  for (const path of [
    "docs/internal/0.15.0-changelog.md",
    "DOCS/Internal/notes.md",
    "Docs\\Internal\\notes.md",
    "docs/public/../internal/notes.md",
    join(tmpdir(), "x", "docs", "INTERNAL", "notes.md"),
  ]) {
    assert.equal(sharedMarks.isInternalDocsPath(path), true, path);
  }
  for (const path of ["docs/public/0.15.0-notes.md", join(tmpdir(), "notes.md")]) {
    assert.equal(sharedMarks.isInternalDocsPath(path), false, path);
  }
});

test("the desktop release refuses notes that carry a mark, and names the marks", () => {
  const run = desktopDryRun(notesAt("notes.md", "# Nultron\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n"));
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /refusing .*notes\.md: it contains "Claude", "Anthropic", "Co-Authored"/);
  assert.doesNotMatch(run.stdout, /dry run/);
});

test("the desktop release refuses notes under docs/internal in any letter case", () => {
  const run = desktopDryRun(notesAt(join("DOCS", "Internal", "notes.md"), CLEAN_NOTES));
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /refusing to publish docs\/internal notes/);
});

test("the desktop release hands gh the checked notes file by its absolute path", () => {
  // Relative, from another cwd: gh runs in apps/desktop and would resolve a relative name there.
  const notes = notesAt("notes.md", CLEAN_NOTES);
  const run = desktopDryRun("notes.md", dirname(notes));
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.ok(run.stdout.includes(`--notes-file ${notes}`) || run.stdout.includes(`--notes-file "${notes}"`), run.stdout);
  assert.match(run.stdout, /dry run, nothing uploaded/);
});

// ---------- the company sites in the bundle ----------

test("readSiteFiles maps webapp-deploy/sites to sites/, drops comments from Caddy files only, and sorts", () => {
  const bundle = fakeSiteBundle();
  assert.deepEqual(Object.keys(bundle), [
    "sites/dpscloud.caddy",
    "sites/dpscloud/index.html",
    "sites/enable-sites.sh",
    "sites/tokotoken.caddy",
    "sites/tokotoken/index.html",
  ]);
  assert.ok(
    bundle["sites/dpscloud.caddy"].startsWith(
      `# Nultron Enterprise ${TAG}. Generated per release; do not edit here.\n`,
    ),
  );
  assert.doesNotMatch(bundle["sites/dpscloud.caddy"], /packages\/host/, "a comment citing a source path is dropped");
  assert.match(bundle["sites/enable-sites.sh"], /# switch/, "a script keeps its comments");
});

test("readSiteFiles refuses a sha without a required file, a binary file, an oversize file and a path outside sites/", () => {
  for (const missing of REQUIRED_SITE_FILES) {
    const files = { ...FAKE_SITE_FILES };
    delete files[missing];
    assert.throws(
      () => siteBundleFrom(files),
      (error) => error instanceof ReleaseError && error.message.includes(missing),
      missing,
    );
  }
  assert.throws(
    () => siteBundleFrom({ ...FAKE_SITE_FILES, "webapp-deploy/sites/dpscloud/logo.png": "x" }),
    /text files only/,
  );
  assert.throws(
    () =>
      siteBundleFrom({
        ...FAKE_SITE_FILES,
        "webapp-deploy/sites/dpscloud/big.html": "x".repeat(SITE_FILE_MAX_BYTES + 1),
      }),
    /over \d+ bytes/,
  );
  for (const bad of [
    "webapp-deploy/other/a.html",
    "webapp-deploy/sites/../a.html",
    "webapp-deploy/sites//a.html",
    "webapp-deploy/sites/a\u005cb.html",
  ]) {
    assert.throws(() => bundlePathFor(bad), SitesError, bad);
  }
  assert.equal(bundlePathFor("webapp-deploy/sites/dpscloud/index.html"), "sites/dpscloud/index.html");
});

test("the real webapp-deploy/sites folder is a valid bundle, and nothing in it names a customer or the gateway host", () => {
  const bundle = realSiteFiles();
  for (const path of REQUIRED_SITE_FILES)
    assert.ok(`sites/${path.slice("webapp-deploy/sites/".length)}` in bundle, path);
  for (const [name, text] of Object.entries(bundle)) {
    assert.deepEqual(forbiddenMarksInPublished(text), [], name);
  }
  // No wildcard and no catch-all site, and no reverse proxy: a company site only serves its own files.
  for (const [name, text] of Object.entries(bundle).filter(([path]) => path.endsWith(".caddy"))) {
    assert.doesNotMatch(text, /reverse_proxy/, `${name}: serves files only`);
    assert.doesNotMatch(text, /^(\*|:\d+|https?:\/\/:)[^\n]*\{$/m, `${name}: no wildcard or catch-all address`);
    assert.doesNotMatch(text, /api\.tokotokenai\.com/, `${name}: the gateway host is never served`);
  }
});

test("the whole rendered bundle, sites included, has none of the banned marks or customer names", () => {
  const bundle = renderBundle(TAG, SOURCE_CADDYFILE, realSiteFiles());
  assert.ok(Object.keys(bundle).length >= BUNDLE_FILES.length + REQUIRED_SITE_FILES.length);
  const ndaTerms = existsSync(join(REPO_ROOT, NDA_TERMS_PATH)) ? readNdaTerms(REPO_ROOT) : [];
  for (const [name, text] of Object.entries(bundle)) {
    assert.deepEqual(forbiddenMarksInPublished(text), [], name);
    assert.equal(
      ndaTerms.filter((term) => text.toLowerCase().includes(term)).length,
      0,
      `${name}: no NDA term in a published file`,
    );
  }
});

test("DEPLOY.md carries the three extra sections once, and names the images of this tag", () => {
  const doc = deployDoc(TAG);
  for (const heading of Object.values(DEPLOY_DOC_SECTIONS)) {
    assert.equal(doc.split(`\n${heading}\n`).length - 1, 1, heading);
  }
  assert.ok(doc.includes(IMAGE) && doc.includes(PORTAL_IMAGE));
  assert.match(doc, /api\.tokotokenai\.com. is not served from here/);
});

test(".env.example lists the company-site variables as comments only, and the sender default is in portal.env.example", () => {
  const env = envExample();
  for (const [name] of OPTIONAL_ENV) {
    assert.ok(
      env.split("\n").includes(`# ${name}=${OPTIONAL_ENV.find(([n]) => n === name)[1]}`),
      `${name} is a comment`,
    );
    assert.ok(!assignments(env).some(([n]) => n === name), `${name} is never an assignment`);
  }
  assert.ok(portalEnvExample().split("\n").includes(`PORTAL_SMTP_FROM=${ENV_DEFAULTS.PORTAL_SMTP_FROM}`));
});

test("checkout: a release refuses any branch but main, dry runs included, before anything else runs", () => {
  const root = fakeRepo({ [TAG]: CLEAN_NOTES });
  const d = deps(root, { branch: "fix/feature" });
  assert.throws(
    () => main(["--tag", TAG, "--sha", FULL_SHA, "--dry-run"], d),
    (error) =>
      error instanceof ReleaseError &&
      /releases run from main only; this checkout is on fix\/feature/.test(error.message),
  );
  assert.deepEqual(d.dockerCalls, []);
  assert.deepEqual(d.tarCalls, []);
  assert.equal(
    d.lines.some((line) => line.startsWith("ok - target")),
    false,
    "the tag and target checks never ran",
  );
});

test("checkout: a detached HEAD is refused", () => {
  const root = fakeRepo({ [TAG]: CLEAN_NOTES });
  assert.throws(
    () => main(["--tag", TAG, "--sha", FULL_SHA, "--dry-run"], deps(root, { branch: "HEAD" })),
    (error) => error instanceof ReleaseError && /on a detached HEAD/.test(error.message),
  );
});

test("checkout: the tester folder is refused even when its branch reads main", () => {
  const parent = mkdtempSync(join(tmpdir(), "release-web-tester-"));
  roots.push(parent);
  const root = join(parent, "agentforge-chat");
  mkdirSync(join(root, "docs", "public"), { recursive: true });
  writeFileSync(join(root, "docs", "public", `${TAG}-notes.md`), CLEAN_NOTES, "utf8");
  const d = deps(root, { branch: "main" });
  assert.throws(
    () => main(["--tag", TAG, "--sha", FULL_SHA, "--dry-run"], d),
    (error) => error instanceof ReleaseError && /tester folder \(agentforge-chat\)/.test(error.message),
  );
  assert.deepEqual(
    d.gitCalls.map((call) => call.sub),
    ["rev-parse"],
    "the only git call before the refusal is the read-only branch read",
  );
});
