/**
 * webapp-deploy/sites/enable-sites.sh: the proxy's entrypoint, which decides which company sites run.
 * Run with `node --test scripts/multisite-edge.test.mjs`. Needs a POSIX `sh` on PATH (Git for Windows has one);
 * without it the tests are skipped, not failed.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SITES = join(REPO_ROOT, "webapp-deploy", "sites");
const SCRIPT = join(SITES, "enable-sites.sh");
const HAS_SH = spawnSync("sh", ["-c", "exit 0"]).status === 0;
const skip = HAS_SH ? false : "no POSIX sh on PATH";
const posix = (path) => path.replaceAll("\\", "/");

const outDirs = [];
after(() => {
  for (const dir of outDirs) rmSync(dir, { recursive: true, force: true });
});

/** Run the script with `env` over a clean environment; the command it execs just prints MARKER. */
function run(env) {
  const out = mkdtempSync(join(tmpdir(), "enable-sites-"));
  outDirs.push(out);
  const result = spawnSync("sh", [posix(SCRIPT), "echo", "MARKER"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      SITES_DIR: posix(SITES),
      SITES_OUT_DIR: posix(join(out, "enabled")),
      NULTRON_DOMAIN: "app.example.test",
      PORTAL_DOMAIN: "portal.example.test",
      ...env,
    },
  });
  return { ...result, enabled: join(out, "enabled") };
}

const enabledFiles = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);

test("both sites unset: only the comment file, the command still runs", { skip }, () => {
  const r = run({});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /MARKER/);
  assert.deepEqual(enabledFiles(r.enabled), ["00-enabled.caddy"]);
  assert.match(readFileSync(join(r.enabled, "00-enabled.caddy"), "utf8"), /enabled: none/);
});

test("a set variable enables exactly that site's file", { skip }, () => {
  const r = run({ DPS_DOMAIN: "dps.example.test" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(enabledFiles(r.enabled), ["00-enabled.caddy", "dpscloud.caddy"]);
  const both = run({ DPS_DOMAIN: "dps.example.test", TOKOTOKEN_DOMAIN: "toko.example.test" });
  assert.deepEqual(enabledFiles(both.enabled), ["00-enabled.caddy", "dpscloud.caddy", "tokotoken.caddy"]);
});

test("api.tokotokenai.com is refused in every variable, in any case, under a name, and as a www form", { skip }, () => {
  for (const variable of ["DPS_DOMAIN", "TOKOTOKEN_DOMAIN", "NULTRON_DOMAIN", "PORTAL_DOMAIN"]) {
    for (const value of ["api.tokotokenai.com", "API.TokoTokenAI.com", "x.api.tokotokenai.com"]) {
      const r = run({ [variable]: value });
      assert.notEqual(r.status, 0, `${variable}=${value}`);
      assert.match(r.stderr, /reserved|not a plain lower-case hostname/, `${variable}=${value}`);
      assert.doesNotMatch(r.stdout, /MARKER/, "the proxy command never runs");
    }
  }
  const www = run({ TOKOTOKEN_DOMAIN: "api.tokotokenai.com" });
  assert.notEqual(www.status, 0);
});

test("a malformed name or a duplicate is refused before anything starts", { skip }, () => {
  for (const value of ["*.example.test", "example.test:8443", "https://example.test", "exam ple.test", "example.test}", "localhost", "-a.example.test"]) {
    const r = run({ DPS_DOMAIN: value });
    assert.notEqual(r.status, 0, value);
    assert.match(r.stderr, /not a plain lower-case hostname/, value);
  }
  const twice = run({ DPS_DOMAIN: "same.example.test", TOKOTOKEN_DOMAIN: "same.example.test" });
  assert.notEqual(twice.status, 0);
  assert.match(twice.stderr, /already used/);
  const clash = run({ DPS_DOMAIN: "app.example.test" });
  assert.notEqual(clash.status, 0, "a site cannot take Nultron's own name");
});
