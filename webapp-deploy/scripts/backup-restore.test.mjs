import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The restore path's contract, exercised against the real shell scripts — not a copy of them.
 *
 * restore.sh and restore-portal.sh are the destructive half of the backup story: they empty a
 * volume or drop a database. What a fake-docker harness can prove without a daemon is exactly
 * what SR-171 changed: a fresh AES-256-GCM backup restores, a legacy openssl one still does,
 * and a tampered or keyless ciphertext dies BEFORE the first destructive docker call. The stub
 * `docker` on PATH answers `compose version` and `ps`, logs every invocation and consumes its
 * stdin; no daemon is involved.
 *
 * Everything shell-dependent skips cleanly where sh, tar, openssl or cygpath is missing, so a
 * bare Windows host runs the pure-file checks and nothing breaks.
 */

const SCRIPTS_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const KEY = "correct-horse-battery-staple-backup-key";
const WRONG_KEY = "wrong-horse-battery-staple-backup-key";

function probe(command, args = ["-c", "true"]) {
  const run = spawnSync(command, args, { stdio: "ignore" });
  return run.status === 0;
}

const HAS_SH = probe("sh");
const HAS_BASH = probe("bash");
const HAS_TAR = probe("tar", ["--version"]);
const HAS_OPENSSL = probe("openssl", ["version"]);
const HAS_KUBECTL = probe("kubectl", ["version", "--client"]);
const SHELL_OPTS = { shellSkip: !HAS_SH || !HAS_TAR, opensslSkip: !HAS_OPENSSL };

/**
 * MSYS-flavoured paths for the MSYS children (sh, tar, the shell scripts): no-op off Windows,
 * cygpath on it. NEVER for node.exe or openssl.exe — those are native Windows programs, and a
 * posix path like /tmp/x means nothing to them (cygpath happily maps the temp dir onto /tmp,
 * which Windows then misreads as C:\tmp).
 */
function posixPath(input) {
  if (process.platform !== "win32") return input;
  const out = spawnSync("cygpath", ["-u", input], { encoding: "utf8" });
  return out.status === 0 ? out.stdout.trim() : input.replace(/\\/g, "/");
}

/** For native Windows programs: forward slashes, which the Win32 file APIs accept as-is. */
function nativePath(input) {
  return process.platform === "win32" ? input.replace(/\\/g, "/") : input;
}

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runCapture(command, args, options = {}) {
  const run = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 60000,
    ...options,
  });
  return {
    status: run.status,
    stdout: run.stdout ?? "",
    stderr: run.stderr ?? "",
    output: `${run.stdout ?? ""}\n${run.stderr ?? ""}`,
  };
}

/** A tiny gzipped tar with real content, built with the system tar, plus its listing for assertions. */
function makeTarFixture(dir) {
  const data = join(dir, "data");
  mkdirSync(join(data, "sub"), { recursive: true });
  writeFileSync(join(data, "hello.txt"), "hello nultron backup\n");
  writeFileSync(join(data, "sub", "second.txt"), "second file\n");
  const tarPath = join(dir, "fixture.tar.gz");
  const tar = runCapture("tar", ["-czf", posixPath(tarPath), "-C", posixPath(data), "."]);
  assert.equal(tar.status, 0, tar.output);
  return tarPath;
}

function encryptGcm(input, output, key = KEY) {
  const run = runCapture(
    process.execPath,
    [join(SCRIPTS_DIR, "aead-crypt.mjs"), "encrypt", "--in", nativePath(input), "--out", nativePath(output)],
    { env: { ...process.env, BACKUP_KEY: key } },
  );
  assert.equal(run.status, 0, run.output);
  return output;
}

function encryptLegacyCbc(input, output, key = KEY) {
  const run = runCapture(
    "openssl",
    ["enc", "-aes-256-cbc", "-pbkdf2", "-iter", "200000", "-pass", "env:BACKUP_KEY", "-in", nativePath(input), "-out", nativePath(output)],
    { env: { ...process.env, BACKUP_KEY: key } },
  );
  assert.equal(run.status, 0, run.output);
  return output;
}

function tamperedCopy(input, output) {
  const bytes = readFileSync(input);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  writeFileSync(output, bytes);
  return output;
}

/**
 * A fake `docker` that lets the compose wrappers in _common.sh run with no daemon: answers the
 * version probe, prints a container id for `ps`, logs every other invocation one per line into
 * $DOCKER_STUB_LOG, and consumes stdin so piped plaintext never deadlocks the writer.
 */
function installDockerStub(dir) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(dir, "docker-stub.log");
  writeFileSync(
    join(bin, "docker"),
    [
      "#!/bin/sh",
      'if [ "$1" = "compose" ] && [ "$2" = "version" ]; then echo "Docker Compose version v2.99.0-stub"; exit 0; fi',
      'printf "%s\\n" "$*" >> "$DOCKER_STUB_LOG"',
      'for a in "$@"; do [ "$a" = "ps" ] && echo 0123456789ab; done',
      "cat >/dev/null 2>&1 || true",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "docker"), 0o755);
  return { bin, log };
}

const DESTRUCTIVE = ["stop", "run", "up", "exec"];

function destructiveCalls(logPath) {
  let lines = [];
  try {
    lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  return lines.filter((line) => DESTRUCTIVE.some((word) => line.split(" ").includes(word)));
}

/** Run one of the restore scripts with the stubbed docker on PATH and capture everything. */
function runRestoreScript(script, args, { key = KEY, dir }) {
  const stub = installDockerStub(dir);
  const tmp = join(dir, "tmp");
  mkdirSync(tmp, { recursive: true });
  const env = {
    ...process.env,
    PATH: `${posixPath(stub.bin)}:${process.env.PATH}`,
    DOCKER_STUB_LOG: posixPath(stub.log),
    TMPDIR: posixPath(tmp),
  };
  if (key === null) {
    delete env.BACKUP_KEY;
  } else {
    env.BACKUP_KEY = key;
  }
  const run = runCapture("sh", [script, ...args.map(posixPath)], { env });
  return { ...run, log: stub.log };
}

describe("backup/restore shell wiring", () => {
  it("bash -n accepts backup.sh, restore.sh, restore-portal.sh and the k8s encrypt.sh", { skip: !HAS_BASH }, () => {
    const run = runCapture("bash", [
      "-n",
      "webapp-deploy/scripts/backup.sh",
      "webapp-deploy/scripts/restore.sh",
      "webapp-deploy/scripts/restore-portal.sh",
      "webapp-deploy/k8s/base/scripts/encrypt.sh",
    ]);
    assert.equal(run.status, 0, run.output);
  });

  it("backup_format reads the cipher from the first 8 bytes, never the name", { skip: SHELL_OPTS.shellSkip }, () => {
    const dir = tempDir("backup-format-");
    const tarPath = makeTarFixture(dir);
    const gcm = encryptGcm(tarPath, join(dir, "fresh-backup-no-extension"));
    const plain = join(dir, "plain.tar.gz");
    writeFileSync(plain, readFileSync(tarPath));
    const garbage = join(dir, "garbage.enc");
    writeFileSync(garbage, "not a backup at all, just text bytes\n");

    const format = (file) =>
      runCapture("sh", ["-c", ". webapp-deploy/scripts/_backup-crypt.sh && backup_format \"$1\"", "driver", posixPath(file)]);
    assert.equal(format(gcm).stdout.trim(), "gcm");
    assert.equal(format(plain).stdout.trim(), "plain");
    assert.equal(format(garbage).stdout.trim(), "plain");

    if (HAS_OPENSSL) {
      const cbc = encryptLegacyCbc(tarPath, join(dir, "legacy.tar.gz.enc"));
      assert.equal(format(cbc).stdout.trim(), "cbc");
    }
  });

  it("restore.sh restores a fresh AES-256-GCM backup end to end", { skip: SHELL_OPTS.shellSkip }, () => {
    const dir = tempDir("restore-gcm-");
    const backup = encryptGcm(makeTarFixture(dir), join(dir, "nultron-data-test.tar.gz.enc"));
    const run = runRestoreScript("webapp-deploy/scripts/restore.sh", [backup, "--yes"], { dir });
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /restored from/);
    const destructive = destructiveCalls(run.log);
    assert.ok(destructive.some((line) => line.split(" ").includes("stop")), `expected a stop call, saw: ${destructive}`);
    assert.ok(destructive.some((line) => line.split(" ").includes("run")), `expected a run call, saw: ${destructive}`);
  });

  it("restore.sh refuses a tampered GCM backup before any destructive docker call", { skip: SHELL_OPTS.shellSkip }, () => {
    const dir = tempDir("restore-tampered-");
    const backup = encryptGcm(makeTarFixture(dir), join(dir, "good.tar.gz.enc"));
    const bad = tamperedCopy(backup, join(dir, "tampered.tar.gz.enc"));
    const run = runRestoreScript("webapp-deploy/scripts/restore.sh", [bad, "--yes"], { dir });
    assert.notEqual(run.status, 0, "a tampered backup must not restore");
    assert.match(run.output, /could not decrypt/);
    assert.deepEqual(destructiveCalls(run.log), [], "nothing destructive may run after a failed authentication");
  });

  it("restore.sh refuses a GCM backup under the wrong key before any destructive docker call", { skip: SHELL_OPTS.shellSkip }, () => {
    const dir = tempDir("restore-wrongkey-");
    const backup = encryptGcm(makeTarFixture(dir), join(dir, "backup.tar.gz.enc"));
    const run = runRestoreScript("webapp-deploy/scripts/restore.sh", [backup, "--yes"], { dir, key: WRONG_KEY });
    assert.notEqual(run.status, 0);
    assert.deepEqual(destructiveCalls(run.log), []);
  });

  it("restore.sh still restores a legacy openssl CBC backup", { skip: SHELL_OPTS.shellSkip || SHELL_OPTS.opensslSkip }, () => {
    const dir = tempDir("restore-cbc-");
    const backup = encryptLegacyCbc(makeTarFixture(dir), join(dir, "nultron-data-legacy.tar.gz.enc"));
    const run = runRestoreScript("webapp-deploy/scripts/restore.sh", [backup, "--yes"], { dir });
    assert.equal(run.status, 0, run.output);
    assert.ok(destructiveCalls(run.log).length > 0, "the restore should have reached the docker calls");
  });

  it("restore.sh restores a plain tar.gz with no BACKUP_KEY at all", { skip: SHELL_OPTS.shellSkip }, () => {
    const dir = tempDir("restore-plain-");
    const plain = join(dir, "nultron-data-plain.tar.gz");
    writeFileSync(plain, readFileSync(makeTarFixture(dir)));
    const run = runRestoreScript("webapp-deploy/scripts/restore.sh", [plain, "--yes"], { dir, key: null });
    assert.equal(run.status, 0, run.output);
  });

  it("restore.sh refuses a plain tarball disguised with a .enc extension before any destructive docker call", { skip: SHELL_OPTS.shellSkip }, () => {
    const dir = tempDir("restore-disguised-enc-");
    const fakeEnc = join(dir, "backup.tar.gz.enc");
    writeFileSync(fakeEnc, readFileSync(makeTarFixture(dir)));
    const run = runRestoreScript("webapp-deploy/scripts/restore.sh", [fakeEnc, "--yes"], { dir });
    assert.notEqual(run.status, 0);
    assert.match(run.output, /no encryption header/);
    assert.deepEqual(destructiveCalls(run.log), []);
  });

  it("restore.sh refuses an encrypted backup when BACKUP_KEY is empty", { skip: SHELL_OPTS.shellSkip }, () => {
    const dir = tempDir("restore-nokey-");
    const backup = encryptGcm(makeTarFixture(dir), join(dir, "backup.tar.gz.enc"));
    const run = runRestoreScript("webapp-deploy/scripts/restore.sh", [backup, "--yes"], { dir, key: null });
    assert.notEqual(run.status, 0);
    assert.match(run.output, /BACKUP_KEY/);
    assert.deepEqual(destructiveCalls(run.log), []);
  });

  it("restore-portal.sh restores a fresh GCM dump in its destructive form", { skip: SHELL_OPTS.shellSkip }, () => {
    const dir = tempDir("restore-portal-gcm-");
    const dump = encryptGcm(makeTarFixture(dir), join(dir, "nultron-portal-test.dump.enc"));
    const run = runRestoreScript("webapp-deploy/scripts/restore-portal.sh", [dump, "--yes"], { dir });
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /restored from/);
    const destructive = destructiveCalls(run.log);
    assert.ok(destructive.some((line) => line.split(" ").includes("exec")), `expected pg_restore execs, saw: ${destructive}`);
  });

  it("restore-portal.sh refuses a tampered GCM dump before any destructive docker call", { skip: SHELL_OPTS.shellSkip }, () => {
    const dir = tempDir("restore-portal-tampered-");
    const dump = encryptGcm(makeTarFixture(dir), join(dir, "good.dump.enc"));
    const bad = tamperedCopy(dump, join(dir, "tampered.dump.enc"));
    const run = runRestoreScript("webapp-deploy/scripts/restore-portal.sh", [bad, "--yes"], { dir });
    assert.notEqual(run.status, 0, "a tampered dump must not restore");
    assert.deepEqual(destructiveCalls(run.log), [], "nothing destructive may run after a failed authentication");
  });

  it("restore-portal.sh refuses a file with no encryption header", { skip: SHELL_OPTS.shellSkip }, () => {
    const dir = tempDir("restore-portal-plain-");
    const plain = join(dir, "raw.dump");
    writeFileSync(plain, "PGDMP fake unencrypted dump bytes\n");
    const run = runRestoreScript("webapp-deploy/scripts/restore-portal.sh", [plain, "--yes"], { dir });
    assert.notEqual(run.status, 0);
    assert.match(run.output, /no encryption header/);
  });
});

describe("kubernetes backup wiring", () => {
  it("keeps the k8s copy of aead-crypt.mjs byte-identical to webapp-deploy/scripts", () => {
    const canonical = readFileSync(join(SCRIPTS_DIR, "aead-crypt.mjs"));
    const copy = readFileSync(join(REPO_ROOT, "webapp-deploy/k8s/base/scripts/aead-crypt.mjs"));
    assert.ok(canonical.equals(copy), "webapp-deploy/k8s/base/scripts/aead-crypt.mjs drifted from webapp-deploy/scripts/aead-crypt.mjs");
  });

  it("generates the backup scripts ConfigMap with aead-crypt.mjs in it", () => {
    const kustomization = readFileSync(join(REPO_ROOT, "webapp-deploy/k8s/base/kustomization.yaml"), "utf8");
    assert.match(kustomization, /aead-crypt\.mjs=scripts\/aead-crypt\.mjs/);
  });

  it("pins the CronJob archive container to the Dockerfile's node image, not postgres", () => {
    const dockerfile = readFileSync(join(REPO_ROOT, "webapp-deploy/Dockerfile"), "utf8");
    const pin = dockerfile.match(/^ARG NODE_VERSION=(\S+)$/m);
    assert.ok(pin, "webapp-deploy/Dockerfile carries no ARG NODE_VERSION pin");
    const cronjob = readFileSync(join(REPO_ROOT, "webapp-deploy/k8s/base/backup-cronjob.yaml"), "utf8");
    assert.match(cronjob, new RegExp(`image: node:${pin[1].replace(/[.]/g, "\\.")}\\b`), "the archive container should run the same node pin");
    assert.doesNotMatch(cronjob, /image: postgres/, "postgres:16 has no node; the archive container cannot run aead-crypt.mjs from it");
  });

  it("renders the base overlay with kubectl kustomize, carrying aead-crypt.mjs", { skip: !HAS_KUBECTL }, () => {
    const run = runCapture("kubectl", ["kustomize", "webapp-deploy/k8s/base"]);
    assert.equal(run.status, 0, run.output);
    assert.match(run.stdout, /aead-crypt\.mjs/);
  });
});
