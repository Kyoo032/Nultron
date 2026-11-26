import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = fileURLToPath(new URL("../webapp-deploy/scripts/", import.meta.url));
const toPosix = (p) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
const scriptsPosix = toPosix(scriptsDir);

const SECRET_PATH = "/ping/0a1b2c3d-secret";
const DEAD_MONITOR = `http://127.0.0.1:9${SECRET_PATH}`;

let server;
let base;
let hostPort;
let sandbox;
let hits = [];

before(async () => {
  server = createServer((req, res) => {
    hits.push(req.url);
    res.end("OK");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  hostPort = `127.0.0.1:${server.address().port}`;
  base = `http://${hostPort}${SECRET_PATH}`;
  sandbox = mkdtempSync(join(tmpdir(), "backup-heartbeat-"));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(sandbox, { recursive: true, force: true });
});

const run = (args, env, timeout) =>
  new Promise((resolve) => {
    const child = spawn("sh", args, { env, stdio: ["ignore", "pipe", "pipe"], timeout });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

const ping = (url, rc) =>
  run(
    ["-c", `. "${scriptsPosix}_heartbeat.sh"; heartbeat_ping "$URL" ${rc}; echo "returned $?"`],
    { ...process.env, URL: url },
    60_000,
  );

test("a success ping hits the base URL", async () => {
  hits = [];
  const result = await ping(base, 0);
  assert.equal(result.status, 0);
  assert.deepEqual(hits, [SECRET_PATH]);
  assert.match(result.stdout, /returned 0/);
});

test("a failure ping hits <url>/fail, and a trailing slash does not double up", async () => {
  hits = [];
  await ping(`${base}/`, 3);
  assert.deepEqual(hits, [`${SECRET_PATH}/fail`]);
});

test("an unset URL pings nothing", async () => {
  hits = [];
  const result = await ping("", 0);
  assert.equal(result.status, 0);
  assert.deepEqual(hits, []);
});

test("a malformed URL pings nothing and still returns 0", async () => {
  hits = [];
  const malformed = {
    "no scheme": `${hostPort}/x`,
    "double quote": `http://${hostPort}/a"b`,
    space: `http://${hostPort}/a b`,
    tab: `http://${hostPort}/a\tb`,
    backslash: `http://${hostPort}/a\\b`,
  };
  for (const [name, bad] of Object.entries(malformed)) {
    const result = await ping(bad, 0);
    assert.equal(result.status, 0, name);
    assert.deepEqual(hits, [], `${name} reached the monitor`);
  }
});

test("a dead monitor never fails the caller and never prints the URL", async () => {
  const result = await ping(DEAD_MONITOR, 1);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /returned 0/);
  assert.ok(!result.stdout.includes("secret") && !result.stderr.includes("secret"));
});

function fakeDocker(dir, appRunning) {
  const data = join(dir, "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "file.txt"), "payload");
  // backup.sh's verify step requires the embedded desk meta in every archive.
  writeFileSync(join(data, "backup-meta.json"), '{"desk":"nultron-web","createdAt":"stub"}\n');
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const docker = join(bin, "docker");
  writeFileSync(
    docker,
    `#!/bin/sh
# Stub of the per-desk interface backup.sh drives: desks are compose projects with an
# \`app\` service, found by label filters; snapshots and tars run through docker exec.
case "$*" in
  *"compose version"*) exit 0 ;;
  *"compose ps -q portal-db"*) true ;;
  *"ps --filter"*) ${appRunning ? "echo nultron-web" : "true"} ;;
  *"ps -q --filter"*) ${appRunning ? "echo fake-app-id" : "true"} ;;
  *"exec -i "*" sh -s"*)
    # Emulate the snapshot step: stage a fake agentforge.sqlite under the per-run dir
    # named in -e SNAP_DIR=, so the tar below carries a .backup-staging* member and
    # backup.sh's test -f probe and snapshot-required verify run for real.
    _snap="$(printf '%s\\n' "$*" | sed -n 's/.*SNAP_DIR=\\([^ ]*\\).*/\\1/p')"
    mkdir -p "${toPosix(data)}/$_snap" && : > "${toPosix(data)}/$_snap/agentforge.sqlite"
    cat >/dev/null 2>&1 || true ;;
  *"tar -czf"*) tar -czf - -C "${toPosix(data)}" . ; echo "tar_exit=0" >&2 ;;
  *exec*)
    eval "_last=\${$#}"
    case "$_last" in
      "test -f"*) AGENTFORGE_DATA_DIR="${toPosix(data)}" eval "$_last" ;;
      *) cat >/dev/null 2>&1 || true ;;
    esac ;;
esac
exit 0
`,
  );
  chmodSync(docker, 0o755);
  return toPosix(bin);
}

function runBackup(name, { appRunning, heartbeat, scripts = scriptsPosix }) {
  const dir = join(sandbox, name);
  mkdirSync(dir, { recursive: true });
  const bin = fakeDocker(dir, appRunning);
  const out = toPosix(join(dir, "out"));
  return run(
    [`${scripts}backup.sh`, out],
    {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      BACKUP_KEY: "test-passphrase",
      BACKUP_HEARTBEAT_URL: heartbeat,
      COS_BACKUP_BUCKET: "",
      // These tests exercise the heartbeat, not the offsite gate: a skipped upload would
      // otherwise fail every desk (BACKUP_REQUIRE_OFFSITE=1 is covered in backup-restore.test.mjs).
      BACKUP_REQUIRE_OFFSITE: "0",
    },
    90_000,
  );
}

test("backup.sh end to end: a good run pings success once and keeps exit 0", async () => {
  hits = [];
  const result = await runBackup("good", { appRunning: true, heartbeat: base });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(hits, [SECRET_PATH]);
  assert.ok(!(result.stdout + result.stderr).includes("secret"), "the URL leaked into the log");
});

test("backup.sh end to end: a failed run pings /fail once and keeps its exit code", async () => {
  hits = [];
  const result = await runBackup("bad", { appRunning: false, heartbeat: base });
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.deepEqual(hits, [`${SECRET_PATH}/fail`]);
  assert.ok(!(result.stdout + result.stderr).includes("secret"), "the URL leaked into the log");
});

test("backup.sh end to end: with the variable unset nothing is pinged and behaviour is unchanged", async () => {
  hits = [];
  const good = await runBackup("unset-good", { appRunning: true, heartbeat: "" });
  const bad = await runBackup("unset-bad", { appRunning: false, heartbeat: "" });
  assert.equal(good.status, 0, good.stderr + good.stdout);
  assert.equal(bad.status, 1);
  assert.deepEqual(hits, []);
});

test("backup.sh end to end: an unreachable monitor does not fail a good backup", async () => {
  const result = await runBackup("dead-monitor", { appRunning: true, heartbeat: DEAD_MONITOR });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("backup.sh never reads the heartbeat URL from .env", async () => {
  hits = [];
  const deployDir = join(sandbox, "deploy-copy");
  const scriptsCopy = join(deployDir, "scripts");
  cpSync(scriptsDir, scriptsCopy, { recursive: true });
  writeFileSync(join(deployDir, ".env"), `BACKUP_HEARTBEAT_URL=${base}\n`);
  const result = await runBackup("dotenv-url", {
    appRunning: true,
    heartbeat: "",
    scripts: `${toPosix(scriptsCopy)}/`,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(hits, []);
});

test(".env.example sets no heartbeat URL and points at the README", () => {
  const example = readFileSync(join(scriptsDir, "..", ".env.example"), "utf8");
  assert.doesNotMatch(example, /^\s*#?\s*BACKUP_HEARTBEAT_URL\s*=/m);
  assert.match(example, /BACKUP_HEARTBEAT_URL[\s\S]*Backup alert/);
});
