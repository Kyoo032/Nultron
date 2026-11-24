/**
 * Tests for the deploy gate: scripts/deploy-preflight.mjs (the offline checks) and the gate in
 * webapp-deploy/scripts/deploy.sh (preflight, :previous tags, health waits, public probe, rollback).
 *
 * Node's runner, like scripts/deploy-scripts.test.mjs. The fixtures are generated here: env files come from the
 * release templates (envExample / portalEnvExample in release-web.mjs), with fake values. No real secret, host or
 * server is touched. The deploy.sh tests run the real script under `sh` against a copy of the repo layout, with a
 * fake `docker` and `curl` first on PATH that record every call and answer from variables.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import {
  checkAppEnv,
  checkComposeConfig,
  checkComposeImages,
  checkPortalEnv,
  main,
  parseArgs,
  parseEnvText,
  runDocker,
  runPreflight,
  UsageError,
} from "./deploy-preflight.mjs";
import { composeFile, envExample, portalEnvExample } from "./release-web.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./deploy-preflight.mjs", import.meta.url));
const DOCKER_AVAILABLE = runDocker(["compose", "version"]).ok;

/** Every temp dir the tests make, removed when the file is done. */
const TEMP_DIRS = [];
after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});
function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

/** A fake secret that must never show up in any output. Its name says what it is. */
const PLANTED = "PLANTED-SECRET-MARKER-9d2e";
const KEY_FIXTURE = "0123456789abcdef".repeat(4);

const APP_VALUES = {
  NULTRON_DOMAIN: "nultron.example.com",
  PORTAL_DOMAIN: "portal.example.com",
  AGENTFORGE_SECRETS_KEY: KEY_FIXTURE,
  AGENTFORGE_TRUSTED_ORIGINS: "https://nultron.example.com",
  AGENTFORGE_PORTAL_URL: "https://portal.example.com",
  AGENTFORGE_PORTAL_CLIENT_SECRET: "fixture-client-secret",
  AGENTFORGE_BILLING_WEBHOOK_SECRET: "fixture-billing-secret",
};
const PORTAL_VALUES = {
  PORTAL_SIGNING_KEY: "fixture-signing-key",
  PORTAL_POSTGRES_PASSWORD: "fixture-owner-password",
  PORTAL_APP_DB_PASSWORD: "fixture-app-password",
};

/** Fills the release template's NAME= lines with the given values. Comments and other lines are left alone. */
function fill(template, values) {
  return template
    .split("\n")
    .map((line) => {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      return match && values[match[1]] !== undefined ? `${match[1]}=${values[match[1]]}` : line;
    })
    .join("\n");
}

const appEnvText = (overrides = {}) => fill(envExample(), { ...APP_VALUES, ...overrides });
const portalEnvText = (overrides = {}) => fill(portalEnvExample(), { ...PORTAL_VALUES, ...overrides });

// ---------- parsing ----------

test("parseEnvText reads NAME=value, export, quotes, comments and CRLF, and the last value wins", () => {
  const values = parseEnvText(
    "# a comment\r\nexport A=one\r\nB=\"two words\"\r\nC='three'\r\nD=four # trailing note\r\nA=again\r\n# E=hidden\r\n",
  );
  assert.equal(values.get("A"), "again");
  assert.equal(values.get("B"), "two words");
  assert.equal(values.get("C"), "three");
  assert.equal(values.get("D"), "four");
  assert.equal(values.has("E"), false);
});

test("parseEnvText keeps an empty value as empty, so presence can see it", () => {
  assert.equal(parseEnvText("EMPTY=\nSPACED=   \n").get("EMPTY"), "");
  assert.equal(parseEnvText("SPACED=   \n").get("SPACED"), "");
});

// ---------- the app's .env ----------

test("the release template, filled with real-looking values, passes every app check", () => {
  assert.deepEqual(checkAppEnv(parseEnvText(appEnvText())), []);
});

test("every name the release writes into .env.example is checked for presence", () => {
  for (const name of [
    "NULTRON_DOMAIN",
    "PORTAL_DOMAIN",
    "AGENTFORGE_SECRETS_KEY",
    "AGENTFORGE_TRUSTED_ORIGINS",
    "AGENTFORGE_PORTAL_URL",
    "AGENTFORGE_PORTAL_CLIENT_SECRET",
    "AGENTFORGE_BILLING_WEBHOOK_SECRET",
  ]) {
    const problems = checkAppEnv(parseEnvText(appEnvText({ [name]: "" })));
    assert.ok(
      problems.some((problem) => problem.includes(`.env: ${name} is`)),
      `${name} blank was not reported: ${problems.join(" | ")}`,
    );
  }
});

test("AGENTFORGE_SECRETS_KEY may come from the shell, which is how USE_SSM=1 supplies it", () => {
  const blank = parseEnvText(appEnvText({ AGENTFORGE_SECRETS_KEY: "" }));
  assert.deepEqual(checkAppEnv(blank, { AGENTFORGE_SECRETS_KEY: KEY_FIXTURE }), []);
  const problems = checkAppEnv(blank, {});
  assert.equal(problems.length, 1);
  assert.match(problems[0], /AGENTFORGE_SECRETS_KEY is empty in .env and was not exported/);
  assert.match(problems[0], /USE_SSM=1/);
});

test("the shell does not stand in for any other name, because only the key reaches the container through it", () => {
  const problems = checkAppEnv(parseEnvText(appEnvText({ AGENTFORGE_PORTAL_CLIENT_SECRET: "" })), {
    AGENTFORGE_PORTAL_CLIENT_SECRET: "exported-but-not-in-the-container",
  });
  assert.ok(problems.some((problem) => problem.includes("AGENTFORGE_PORTAL_CLIENT_SECRET is missing or empty")));
});

test("AGENTFORGE_PORTAL_URL must be an https origin with no path", () => {
  for (const bad of [
    "http://portal.example.com",
    "https://portal.example.com/sign-in",
    "not a url",
    "https://portal.example.com?x=1",
  ]) {
    const problems = checkAppEnv(parseEnvText(appEnvText({ AGENTFORGE_PORTAL_URL: bad })));
    assert.ok(
      problems.some((problem) => problem.includes("AGENTFORGE_PORTAL_URL must be an https origin with no path")),
      `${bad} was not refused`,
    );
  }
  assert.deepEqual(checkAppEnv(parseEnvText(appEnvText({ AGENTFORGE_PORTAL_URL: "https://portal.example.com/" }))), []);
});

test("every AGENTFORGE_TRUSTED_ORIGINS entry must be an https origin, and the count is reported", () => {
  const problems = checkAppEnv(
    parseEnvText(appEnvText({ AGENTFORGE_TRUSTED_ORIGINS: "https://nultron.example.com,http://nultron.example.com" })),
  );
  assert.deepEqual(problems, [
    ".env: AGENTFORGE_TRUSTED_ORIGINS has 1 entry that is not an https origin with no path. Server mode drops those without a message, so fix them here.",
  ]);
});

test("NULTRON_DOMAIN must be one of the trusted origins' hosts", () => {
  const problems = checkAppEnv(parseEnvText(appEnvText({ AGENTFORGE_TRUSTED_ORIGINS: "https://other.example.com" })));
  assert.ok(problems.some((problem) => problem.includes("NULTRON_DOMAIN is not the host of any https origin")));
});

test("PORTAL_DOMAIN must be the host of AGENTFORGE_PORTAL_URL", () => {
  const problems = checkAppEnv(parseEnvText(appEnvText({ PORTAL_DOMAIN: "sign.example.com" })));
  assert.deepEqual(problems, [
    ".env: PORTAL_DOMAIN must be the host of AGENTFORGE_PORTAL_URL. The app reaches the portal through a loopback alias of that name, so the two must match.",
  ]);
});

test("NULTRON_DOMAIN and PORTAL_DOMAIN must be bare host names", () => {
  for (const bad of [
    "https://nultron.example.com",
    "nultron.example.com/app",
    "nultron.example.com:8443",
    "localhost",
  ]) {
    const problems = checkAppEnv(parseEnvText(appEnvText({ NULTRON_DOMAIN: bad })));
    assert.ok(
      problems.some((problem) => problem.includes("NULTRON_DOMAIN must be a bare host name")),
      `${bad} was not refused`,
    );
  }
});

test("a problem names the variable and never prints its value", () => {
  const problems = checkAppEnv(
    parseEnvText(appEnvText({ AGENTFORGE_SECRETS_KEY: PLANTED, AGENTFORGE_PORTAL_URL: "http://portal.example.com" })),
  );
  assert.ok(problems.length > 0);
  assert.ok(
    problems.every((problem) => !problem.includes(PLANTED)),
    problems.join(" | "),
  );
});

// ---------- portal.env ----------

test("the portal template, filled in, passes in password mode with the SMTP secrets blank", () => {
  assert.deepEqual(checkPortalEnv(parseEnvText(portalEnvText())), []);
});

test("an unset PORTAL_SIGNIN_MODE means code, so the SMTP secrets are then required", () => {
  const values = parseEnvText(portalEnvText().replace(/^PORTAL_SIGNIN_MODE=.*$/m, "PORTAL_SIGNIN_MODE="));
  const problems = checkPortalEnv(values);
  assert.ok(
    problems.includes(
      "portal.env: PORTAL_SMTP_USER is missing or empty. It is needed because sign-in is by e-mailed code (PORTAL_SIGNIN_MODE is unset or code).",
    ),
    problems.join(" | "),
  );
  assert.ok(problems.some((problem) => problem.startsWith("portal.env: PORTAL_SMTP_PASS is missing")));
  assert.ok(!problems.some((problem) => problem.includes("PORTAL_SMTP_HOST")), "the template still fills the host in");
});

test("a sign-in mode other than code or password is refused, as the portal refuses it", () => {
  const problems = checkPortalEnv(parseEnvText(portalEnvText({ PORTAL_SIGNIN_MODE: "Password" })));
  assert.deepEqual(problems, [
    "portal.env: PORTAL_SIGNIN_MODE must be code or password. The portal refuses to start on any other value.",
  ]);
});

test("a blank portal secret is reported by name", () => {
  const problems = checkPortalEnv(parseEnvText(portalEnvText({ PORTAL_SIGNING_KEY: "" })));
  assert.deepEqual(problems, ["portal.env: PORTAL_SIGNING_KEY is missing or empty. The stack needs it to start."]);
});

// ---------- images ----------

test("the repo's compose file names only pinned or build tags", () => {
  const text = readFileSync(join(ROOT, "webapp-deploy", "compose.yml"), "utf8");
  assert.deepEqual(checkComposeImages(text), []);
  assert.ok(/image: nultron-web:local/.test(text), "the app image is no longer nultron-web:local");
});

test("the released compose, rendered for a release tag, passes", () => {
  assert.deepEqual(checkComposeImages(composeFile("ent-2026.10.14")), []);
  assert.deepEqual(checkComposeImages(composeFile("ent-2026.10.14.2")), []);
});

test("latest, an untagged image, a variable and a malformed release tag are each refused", () => {
  const problems = checkComposeImages(
    [
      "services:",
      "  a:",
      "    image: foo:latest",
      "  b:",
      "    image: bar",
      "  c:",
      // A compose variable, split so no single string literal holds a placeholder.
      "    image: $" + "{IMAGE_FROM_ENV}",
      "  d:",
      "    image: ghcr.io/kyoo032/nultron-ent:2026-10-14",
    ].join("\n"),
  );
  assert.equal(problems.length, 4, problems.join(" | "));
  assert.match(problems[0], /foo:latest uses the latest tag/);
  assert.match(problems[1], /image bar has no tag/);
  assert.match(problems[2], /names a variable/);
  assert.match(problems[3], /not an ent-YYYY.MM.DD release tag/);
});

test("a digest pins an image, and a registry port is not mistaken for a tag", () => {
  assert.deepEqual(checkComposeImages("    image: busybox@sha256:abc123\n"), []);
  assert.match(checkComposeImages("    image: registry.local:5000/app\n")[0], /has no tag/);
});

// ---------- docker compose config ----------

test("checkComposeConfig reports a compose file docker cannot read, with its first error line", () => {
  const run = (args) =>
    args[0] === "compose" && args[1] === "version"
      ? { ok: true, status: 0, stderr: "" }
      : { ok: false, status: 1, stderr: "\n  services.app.image must be a string\nmore\n" };
  const result = checkComposeConfig({ composePath: "/x/compose.yml", envPath: "/x/.env", run });
  assert.deepEqual(result.notes, []);
  assert.deepEqual(result.problems, [
    "compose file /x/compose.yml: docker compose could not read it (services.app.image must be a string).",
  ]);
});

test("checkComposeConfig passes the same env file deploy.sh interpolates from, and says so when docker is absent", () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    return { ok: true, status: 0, stderr: "" };
  };
  checkComposeConfig({ composePath: "/x/compose.yml", envPath: "/x/.env", run });
  assert.deepEqual(calls.at(-1), ["compose", "-f", "/x/compose.yml", "--env-file", "/x/.env", "config", "-q"]);

  const absent = checkComposeConfig({ composePath: "/x/compose.yml", envPath: "/x/.env", run: () => ({ ok: false }) });
  assert.deepEqual(absent.problems, []);
  assert.match(absent.notes[0], /not available on this machine/);
});

test("the real docker parses the repo's compose file with a complete env file", { skip: !DOCKER_AVAILABLE }, () => {
  const { problems } = checkComposeConfig({
    composePath: join(ROOT, "webapp-deploy", "compose.yml"),
    envPath: join(ROOT, "webapp-deploy", ".env.example"),
    run: runDocker,
  });
  assert.deepEqual(problems, []);
});

// ---------- the whole check, and the command line ----------

test("runPreflight with every file present, and no docker, is clean and says docker was not run", () => {
  const { problems, notes } = runPreflight({
    appEnvText: appEnvText(),
    portalEnvText: portalEnvText(),
    composeText: composeFile("ent-2026.10.14"),
    envPath: "/x/.env",
    composePath: "/x/compose.yml",
    run: () => ({ ok: false }),
  });
  assert.deepEqual(problems, []);
  assert.equal(notes.length, 1);
});

test("parseArgs takes the three flags, each once, and refuses anything else", () => {
  assert.deepEqual(parseArgs(["--env", "a", "--portal-env", "b", "--compose", "c"]), {
    env: "a",
    portalEnv: "b",
    compose: "c",
  });
  assert.deepEqual(parseArgs(["--env", "a"]), { env: "a", portalEnv: null, compose: null });
  assert.throws(() => parseArgs([]), UsageError);
  assert.throws(() => parseArgs(["--portal-env", "b"]), UsageError);
  assert.throws(() => parseArgs(["--env"]), UsageError);
  assert.throws(() => parseArgs(["--env", "a", "--force"]), UsageError);
});

/** A temp dir with the given files. Each is written with its own text. */
function tempFiles(files) {
  const dir = makeTempDir("deploy-preflight-");
  const paths = {};
  for (const [name, text] of Object.entries(files)) {
    paths[name] = join(dir, name);
    writeFileSync(paths[name], text, "utf8");
  }
  return paths;
}

function runCli(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 120_000 });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

test("the CLI exits 0 with every file complete", () => {
  const paths = tempFiles({ ".env": appEnvText(), "portal.env": portalEnvText() });
  const result = runCli(["--env", paths[".env"], "--portal-env", paths["portal.env"]]);
  assert.equal(result.status, 0, result.err);
  assert.match(result.out, /deploy preflight: ok/);
});

test("the CLI exits 1 with one sentence per problem, and not one value", () => {
  const paths = tempFiles({
    ".env": appEnvText({ AGENTFORGE_SECRETS_KEY: PLANTED, AGENTFORGE_PORTAL_URL: "http://portal.example.com" }),
    "portal.env": portalEnvText({ PORTAL_SIGNING_KEY: "" }),
  });
  const result = runCli(["--env", paths[".env"], "--portal-env", paths["portal.env"]]);
  assert.equal(result.status, 1);
  assert.match(result.err, /deploy preflight failed with 2 problems\. Nothing has been switched/);
  assert.match(result.err, /- .env: AGENTFORGE_PORTAL_URL must be an https origin/);
  assert.match(result.err, /- portal.env: PORTAL_SIGNING_KEY is missing or empty/);
  assert.ok(!result.err.includes(PLANTED) && !result.out.includes(PLANTED));
});

test("the CLI names a file it cannot read, and refuses the run", () => {
  const paths = tempFiles({ ".env": appEnvText() });
  const missing = join(paths[".env"], "..", "no-such-portal.env");
  const result = runCli(["--env", paths[".env"], "--portal-env", missing]);
  assert.equal(result.status, 1);
  assert.match(result.err, /portal\.env: .* cannot be read/);
});

test("the CLI exits 2 on bad arguments", () => {
  const result = runCli(["--portal-env", "x"]);
  assert.equal(result.status, 2);
  assert.match(result.err, /usage: node scripts\/deploy-preflight\.mjs --env/);
});

test("main returns the status and prints through the injected sinks", () => {
  const paths = tempFiles({ ".env": appEnvText({ NULTRON_DOMAIN: "" }) });
  const out = [];
  const err = [];
  const status = main(["--env", paths[".env"]], { log: (line) => out.push(line), error: (line) => err.push(line) });
  assert.equal(status, 1);
  assert.deepEqual(out, []);
  assert.ok(err.some((line) => line.includes(".env: NULTRON_DOMAIN is missing or empty")));
});

// ---------- the gate in deploy.sh, with a fake docker ----------

const FAKE_DOCKER = `#!/bin/sh
# Fake docker for webapp-deploy/scripts/deploy.sh. Records each call; answers from the FAKE_* variables.
echo "docker $*" >>"$FAKE_DOCKER_LOG"
case "$*" in
"compose version") exit 0 ;;
esac
case "$*" in
*" config -q"*) exit 0 ;;
*" build "*) exit "\${FAKE_BUILD_EXIT:-0}" ;;
*" up -d"*)
	n=$(($(cat "$FAKE_STATE" 2>/dev/null || echo 0) + 1))
	echo "$n" >"$FAKE_STATE"
	exit "\${FAKE_UP_EXIT:-0}"
	;;
*" ps -q app"*)
	if [ "$(cat "$FAKE_STATE" 2>/dev/null || echo 0)" -gt 0 ] || [ "\${FAKE_PREV:-1}" = 1 ]; then echo app-cid; fi
	exit 0
	;;
*" ps -q portal"*) echo portal-cid; exit 0 ;;
*" logs "*) echo "fake logs" >&2; exit 0 ;;
*inspect*Config.Image*)
	case "$*" in *app-cid*) echo nultron-web:local ;; *) echo nultron-portal:local ;; esac
	exit 0
	;;
*inspect*Health*)
	n="$(cat "$FAKE_STATE" 2>/dev/null || echo 0)"
	case "$*" in
	*portal-cid*) if [ "$n" -ge 2 ] && [ -n "\${FAKE_PORTAL_HEALTH_UP2:-}" ]; then echo "$FAKE_PORTAL_HEALTH_UP2"; else echo "\${FAKE_PORTAL_HEALTH:-healthy running 0}"; fi ;;
	*) if [ "$n" -ge 2 ]; then echo "\${FAKE_HEALTH_UP2:-healthy running 0}"; else echo "\${FAKE_HEALTH_UP1:-healthy running 0}"; fi ;;
	esac
	exit 0
	;;
*inspect*)
	case "$*" in *app-cid*) echo sha256:prev-app ;; *) echo sha256:prev-portal ;; esac
	exit 0
	;;
esac
exit 0
`;

const FAKE_CURL = `#!/bin/sh
echo "curl $*" >>"$FAKE_DOCKER_LOG"
printf '%s' "\${FAKE_CURL_CODE:-200}"
exit "\${FAKE_CURL_EXIT:-0}"
`;

const GATE_SOURCES = [
  "scripts/deploy-preflight.mjs",
  "scripts/release-web.mjs",
  "scripts/release-web-compose.mjs",
  "scripts/release-web-docs.mjs",
  "scripts/release-web-sites.mjs",
  "scripts/release-marks.mjs",
];

/** The relative imports one source file makes, as repo-relative paths. */
function relativeImports(repoPath) {
  const text = readFileSync(join(ROOT, repoPath), "utf8");
  return [...text.matchAll(/(?:from|import) +["'](\.{1,2}\/[^"']+)["']/g)].map((match) =>
    posix.normalize(posix.join(posix.dirname(repoPath), match[1])),
  );
}

/**
 * The gate's source files and every relative import they reach, so a new import in release-web.mjs cannot leave the
 * copy short. where-am-i.mjs was such an import, added by another lane.
 */
function gateSources() {
  const seen = new Set();
  const queue = [...GATE_SOURCES];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...relativeImports(name));
  }
  return [...seen];
}

/**
 * A copy of the repo layout deploy.sh needs (REPO_ROOT/scripts for the preflight, REPO_ROOT/webapp-deploy for the
 * script, its env files and compose file), plus a bin folder holding the fakes. Every file is made here.
 */
function gateFixture({ app = appEnvText(), portal = portalEnvText() } = {}) {
  const root = makeTempDir("deploy-gate-");
  const repo = join(root, "repo");
  const deploy = join(repo, "webapp-deploy");
  const bin = join(root, "bin");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(deploy, "scripts"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const name of gateSources()) {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    copyFileSync(join(ROOT, name), join(repo, name));
  }
  for (const name of readdirSync(join(ROOT, "webapp-deploy", "scripts"))) {
    if (name.endsWith(".sh")) copyFileSync(join(ROOT, "webapp-deploy", "scripts", name), join(deploy, "scripts", name));
  }
  copyFileSync(join(ROOT, "webapp-deploy", "compose.yml"), join(deploy, "compose.yml"));
  writeFileSync(join(deploy, ".env"), app, "utf8");
  writeFileSync(join(deploy, "portal.env"), portal, "utf8");
  writeFileSync(join(deploy, "DEPLOY-LOG.md"), "", "utf8");
  writeFileSync(join(bin, "docker"), FAKE_DOCKER, "utf8");
  writeFileSync(join(bin, "curl"), FAKE_CURL, "utf8");
  chmodSync(join(bin, "docker"), 0o755);
  chmodSync(join(bin, "curl"), 0o755);
  return { repo, deploy, bin, log: join(root, "docker.log"), state: join(root, "state") };
}

/** Runs deploy.sh --no-pull on a fixture. `fake` sets the FAKE_* answers. Returns status, output and the call log. */
function runGate(fixture, fake = {}, extraEnv = {}) {
  const env = {
    ...process.env,
    PATH: `${fixture.bin}${delimiter}${process.env.PATH ?? ""}`,
    FAKE_DOCKER_LOG: fixture.log,
    FAKE_STATE: fixture.state,
    DEPLOY_WHO: "test",
    ...fake,
    ...extraEnv,
  };
  const result = spawnSync("sh", [join(fixture.deploy, "scripts", "deploy.sh"), "--no-pull"], {
    cwd: fixture.repo,
    env,
    encoding: "utf8",
    timeout: 180_000,
  });
  const calls = readFileSync(fixture.log, "utf8").split("\n").filter(Boolean);
  return { status: result.status, out: result.stdout, err: result.stderr, calls };
}

const ups = (calls) => calls.filter((call) => / up -d/.test(call)).length;

test("deploy.sh: a complete env and a healthy stack deploy, keep the old images, and record the row", () => {
  const fixture = gateFixture();
  const result = runGate(fixture, { FAKE_PREV: "1", FAKE_CURL_CODE: "200" });
  assert.equal(result.status, 0, result.err);
  assert.ok(result.calls.includes("docker image tag sha256:prev-app nultron-web:previous"), result.calls.join("\n"));
  assert.ok(result.calls.includes("docker image tag sha256:prev-portal nultron-portal:previous"));
  assert.equal(ups(result.calls), 1, "one up, no rollback");
  assert.ok(result.calls.some((call) => call.includes(" build app portal")));
  assert.match(result.out, /==> public \/healthz answered 200/);
  assert.match(readFileSync(join(fixture.deploy, "DEPLOY-LOG.md"), "utf8"), /\| test \|/);
});

test("deploy.sh: a preflight refusal stops before the build, and nothing is switched", () => {
  const fixture = gateFixture({ app: appEnvText({ AGENTFORGE_PORTAL_URL: "http://portal.example.com" }) });
  const result = runGate(fixture, { FAKE_PREV: "1" });
  assert.equal(result.status, 1);
  assert.match(result.err, /AGENTFORGE_PORTAL_URL must be an https origin/);
  assert.match(result.err, /Nothing was switched/);
  assert.equal(
    result.calls.some((call) => call.includes(" build ")),
    false,
  );
  assert.equal(ups(result.calls), 0);
  assert.equal(readFileSync(join(fixture.deploy, "DEPLOY-LOG.md"), "utf8"), "");
});

test("deploy.sh: a secret that is refused never reaches the output", () => {
  const fixture = gateFixture({
    app: appEnvText({ AGENTFORGE_SECRETS_KEY: PLANTED, AGENTFORGE_PORTAL_URL: "http://portal.example.com" }),
  });
  const result = runGate(fixture, { FAKE_PREV: "1" });
  assert.equal(result.status, 1);
  assert.ok(!result.out.includes(PLANTED) && !result.err.includes(PLANTED));
});

test("deploy.sh: an app that goes unhealthy after the swap is rolled back to the kept images, without a build", () => {
  const fixture = gateFixture();
  const result = runGate(fixture, {
    FAKE_PREV: "1",
    FAKE_HEALTH_UP1: "unhealthy running 0",
    FAKE_HEALTH_UP2: "healthy running 0",
  });
  assert.equal(result.status, 1);
  assert.match(result.err, /error: the app did not go healthy/);
  assert.match(result.err, /==> rolling back to the images from before this deploy/);
  assert.match(result.err, /==> rolled back: the previous app and portal are healthy again\. This deploy did NOT land\./);
  assert.ok(result.calls.includes("docker image tag nultron-web:previous nultron-web:local"));
  assert.ok(result.calls.includes("docker image tag nultron-portal:previous nultron-portal:local"));
  assert.ok(
    result.calls.some((call) => / up -d --no-build --force-recreate app proxy portal$/.test(call)),
    result.calls.join("\n"),
  );
  assert.equal(result.calls.filter((call) => call.includes(" build ")).length, 1, "the rollback must not build");
  assert.equal(ups(result.calls), 2);
  assert.match(readFileSync(join(fixture.deploy, "DEPLOY-LOG.md"), "utf8"), /^$/);
});

test("deploy.sh: a container that keeps restarting (a boot refusal) fails at once and is rolled back", () => {
  const fixture = gateFixture();
  const result = runGate(fixture, {
    FAKE_PREV: "1",
    FAKE_HEALTH_UP1: "starting restarting 3",
    FAKE_HEALTH_UP2: "healthy running 0",
  });
  assert.equal(result.status, 1);
  assert.match(result.err, /error: the app did not go healthy \(last: starting, restarting, 3 restarts\)/);
  assert.equal(ups(result.calls), 2);
});

test("deploy.sh: a first deploy with nothing to go back to says so, and does not roll anything back", () => {
  const fixture = gateFixture();
  const result = runGate(fixture, { FAKE_PREV: "0", FAKE_HEALTH_UP1: "unhealthy running 0" });
  assert.equal(result.status, 1);
  assert.match(result.err, /there is no previous app image to go back to/);
  assert.equal(ups(result.calls), 1, "no second up without a previous image");
  assert.equal(
    result.calls.some((call) => call.includes("--no-build")),
    false,
  );
});

test("deploy.sh: a public /healthz that does not answer through the proxy rolls the stack back", () => {
  const fixture = gateFixture();
  const result = runGate(
    fixture,
    { FAKE_PREV: "1", FAKE_HEALTH_UP2: "healthy running 0", FAKE_CURL_CODE: "000", FAKE_CURL_EXIT: "7" },
    { DEPLOY_PUBLIC_PROBE_TRIES: "1" },
  );
  assert.equal(result.status, 1);
  assert.match(result.err, /did not answer 200 through the proxy \(last: 000\)/);
  assert.equal(ups(result.calls), 2);
  assert.ok(
    result.calls.some(
      (call) => call.startsWith("curl ") && call.includes("--resolve nultron.example.com:443:127.0.0.1"),
    ),
  );
});

test("deploy.sh: a failed build touches nothing that runs, and puts :local back on the kept image", () => {
  const fixture = gateFixture();
  const result = runGate(fixture, { FAKE_PREV: "1", FAKE_BUILD_EXIT: "1" });
  assert.equal(result.status, 1);
  assert.match(result.err, /error: the build failed\. The running stack was not touched\./);
  assert.equal(ups(result.calls), 0);
  assert.ok(result.calls.includes("docker image tag nultron-web:previous nultron-web:local"));
});

test("deploy.sh: a portal that never comes up is rolled back as well", () => {
  const fixture = gateFixture();
  const result = runGate(fixture, {
    FAKE_PREV: "1",
    FAKE_PORTAL_HEALTH: "unhealthy running 0",
    FAKE_PORTAL_HEALTH_UP2: "healthy running 0",
    FAKE_HEALTH_UP2: "healthy running 0",
  });
  assert.equal(result.status, 1);
  assert.match(result.err, /error: the portal did not go healthy/);
  assert.match(result.err, /==> rolled back: the previous app and portal are healthy again\. This deploy did NOT land\./);
  assert.equal(ups(result.calls), 2);
});

test("deploy.sh: rollback also verifies portal health and reports failure when the rolled-back portal stays unhealthy", () => {
  const fixture = gateFixture();
  const result = runGate(fixture, {
    FAKE_PREV: "1",
    FAKE_HEALTH_UP1: "unhealthy running 0",
    FAKE_HEALTH_UP2: "healthy running 0",
    FAKE_PORTAL_HEALTH_UP2: "unhealthy running 0",
  });
  assert.equal(result.status, 1);
  assert.match(result.err, /error: the rolled-back portal did not go healthy/);
  assert.match(result.err, /error: the rolled-back portal is not healthy either/);
  assert.doesNotMatch(result.err, /previous app and portal are healthy again/);
  assert.equal(ups(result.calls), 2);
});

test("compose.yml portal command boots both bundled and pre-bundle portal images on rollback", () => {
  const compose = readFileSync(join(ROOT, "webapp-deploy", "compose.yml"), "utf8").replace(/\r\n/g, "\n");
  const portalSection = compose.slice(compose.indexOf("\n  portal:\n"));
  const cmdMatch = / {4}command:\n {6}- sh\n {6}- -c\n {6}- ([^\n]+)\n/.exec(portalSection);
  assert.ok(cmdMatch, "portal.command must use sh -c fallback for pre-bundle rollback images");
  const shellCmd = cmdMatch[1];

  // 1. Bundled portal image (dist/main.mjs exists, no src/main.ts or tsx).
  const bundledDir = makeTempDir("portal-bundled-");
  mkdirSync(join(bundledDir, "dist"), { recursive: true });
  writeFileSync(join(bundledDir, "dist", "main.mjs"), 'console.log("BOOT:bundled");\n', "utf8");
  const bundledRun = spawnSync("sh", ["-c", shellCmd], { cwd: bundledDir, encoding: "utf8" });
  assert.equal(bundledRun.status, 0, bundledRun.stderr);
  assert.equal(bundledRun.stdout.trim(), "BOOT:bundled");

  // 2. Pre-bundle portal image (no dist/main.mjs; ./node_modules/.bin/tsx + src/main.ts exist).
  const preBundleDir = makeTempDir("portal-prebundle-");
  mkdirSync(join(preBundleDir, "node_modules", ".bin"), { recursive: true });
  mkdirSync(join(preBundleDir, "src"), { recursive: true });
  writeFileSync(join(preBundleDir, "src", "main.ts"), "export {};\n", "utf8");
  writeFileSync(
    join(preBundleDir, "node_modules", ".bin", "tsx"),
    '#!/bin/sh\necho "BOOT:prebundle:$1"\n',
    "utf8",
  );
  chmodSync(join(preBundleDir, "node_modules", ".bin", "tsx"), 0o755);
  const preBundleRun = spawnSync("sh", ["-c", shellCmd], { cwd: preBundleDir, encoding: "utf8" });
  assert.equal(preBundleRun.status, 0, preBundleRun.stderr);
  assert.equal(preBundleRun.stdout.trim(), "BOOT:prebundle:src/main.ts");
});

test("deploy.sh is plain LF, so sh reads it (the .mjs files follow biome.json's CRLF)", () => {
  const text = readFileSync(join(ROOT, "webapp-deploy", "scripts", "deploy.sh"), "utf8");
  assert.equal(text.includes("\r"), false, "deploy.sh has CR characters");
});
