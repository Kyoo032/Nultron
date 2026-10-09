/**
 * Tests for the Phase 0 pilot stack (webapp-deploy/compose.yml and the files around it): the compose
 * file, the released compose file, the Caddyfile, the portal image's context allowlist, the env
 * templates and the portal's DSN wrapper. No docker, no network.
 *
 * Node's own runner, like scripts/release-web.test.mjs: `node --test "scripts/*.test.mjs"` runs it, and
 * `pnpm ci:local` does. What they cannot prove (that Caddy really drops the values, that the stack boots)
 * was driven by hand against real Caddy and a real compose project; see docs/internal/unreleased.md.
 *
 * Why these exist: the released compose file is a template in release-web.mjs that has to stay in step with
 * webapp-deploy/compose.yml by hand, the Caddy filters are copied into the Kubernetes rehearsal, and the
 * portal image's context is an allowlist. Each of those drifts silently.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ENV_DEFAULTS,
  PROXY_IMAGE,
  REQUIRED_ENV,
  REQUIRED_PORTAL_ENV,
  caddyfileFrom,
  composeFile,
} from "./release-web.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const SOURCE_COMPOSE = read("webapp-deploy", "compose.yml");
const BUNDLE_COMPOSE = composeFile("ent-2026.10.01");
const CADDYFILE = read("webapp-deploy", "Caddyfile");

const SERVICES = ["app", "proxy", "portal-db", "portal-prepare", "portal"];

// ---------- a small reader for the compose files (no YAML library at the repo root) ----------

/** Comments are not configuration: whole-line ones, and a trailing ` # note` (no value in these files carries a ` # `). */
function withoutComments(text) {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .map((line) => line.replace(/\s+# .*$/, ""))
    .join("\n");
}

/** `${NAME:-x}` and `${NAME:?why}` are the same variable; the source stack is lenient and the bundle strict. */
function normaliseInterpolation(text) {
  return text.replace(/\$\{([A-Z_]+)(?::[-?][^}]*)?\}/g, (_match, name) => variable(name));
}

/** The compose spelling of a variable reference, built so the source holds no template-looking string. */
function variable(name) {
  return `$${"{"}${name}}`;
}

/** name -> { key -> the lines under that key, comments removed }, for the services of a compose file. */
function parseServices(compose) {
  const lines = withoutComments(compose).split("\n");
  const start = lines.indexOf("services:");
  assert.ok(start >= 0, "no services block");
  const services = {};
  let service = null;
  let key = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // the next top-level block (networks:, volumes:)
    const serviceMatch = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (serviceMatch) {
      service = serviceMatch[1];
      services[service] = {};
      key = null;
      continue;
    }
    const keyMatch = /^ {4}([a-z_]+):(.*)$/.exec(line);
    if (service && keyMatch) {
      key = keyMatch[1];
      services[service][key] = [keyMatch[2].trim()];
      continue;
    }
    if (service && key && line.trim() !== "") services[service][key].push(line.trim());
  }
  return services;
}

const SOURCE = parseServices(SOURCE_COMPOSE);
const BUNDLE = parseServices(BUNDLE_COMPOSE);

/** The part of a service the two files must agree on: everything that is hardening, wiring or limits. */
const MUST_MATCH = [
  "user",
  "read_only",
  "tmpfs",
  "security_opt",
  "cap_drop",
  "cap_add",
  "init",
  "pids_limit",
  "mem_limit",
  "mem_reservation",
  "networks",
  "network_mode",
  "ports",
  "extra_hosts",
  "healthcheck",
  "entrypoint",
  "command",
  "depends_on",
  "logging",
  "restart",
  "volumes",
  "environment",
];

// ---------- the compose files ----------

test("the stack is exactly the five services, in both compose files", () => {
  assert.deepEqual(Object.keys(SOURCE).sort(), [...SERVICES].sort());
  assert.deepEqual(Object.keys(BUNDLE).sort(), [...SERVICES].sort());
});

test("the released compose file keeps the source file's hardening, wiring and limits, service by service", () => {
  for (const name of SERVICES) {
    for (const key of MUST_MATCH) {
      // An environment map has no order; every other key is a list or a scalar whose order is part of its meaning.
      const flat = (lines) => normaliseInterpolation((key === "environment" ? [...lines].sort() : lines).join("\n"));
      const source = SOURCE[name][key] && flat(SOURCE[name][key]);
      const bundle = BUNDLE[name][key] && flat(BUNDLE[name][key]);
      assert.equal(bundle, source, `${name}.${key} differs between webapp-deploy/compose.yml and composeFile() in release-web.mjs`);
    }
  }
});

test("every service is hardened the way the app is: read-only root, no capabilities, no new privileges, bounded", () => {
  for (const [label, services] of [
    ["compose.yml", SOURCE],
    ["the bundle", BUNDLE],
  ]) {
    for (const name of SERVICES) {
      const s = services[name];
      assert.equal(s.read_only?.[0], "true", `${label}: ${name} must have a read-only root`);
      assert.ok(s.cap_drop?.includes("- ALL"), `${label}: ${name} must drop every capability`);
      assert.ok(s.security_opt?.includes("- no-new-privileges:true"), `${label}: ${name} must set no-new-privileges`);
      assert.ok(s.pids_limit, `${label}: ${name} needs a pids limit`);
      assert.ok(s.mem_limit, `${label}: ${name} needs a memory limit`);
      assert.ok(s.logging?.some((line) => line.includes('max-size: "10m"')), `${label}: ${name} needs bounded logs`);
    }
    // The only capability handed back is Caddy's, to bind 80 and 443 in the shared namespace.
    assert.deepEqual(
      SERVICES.filter((name) => services[name].cap_add),
      ["proxy"],
    );
    assert.deepEqual(services.proxy.cap_add, ["", "- NET_BIND_SERVICE"]);
  }
});

test("only the app publishes ports, and only on IPv4 (SR-79); the portal and its database are not published", () => {
  for (const [label, services] of [
    ["compose.yml", SOURCE],
    ["the bundle", BUNDLE],
  ]) {
    for (const name of SERVICES) {
      if (name === "app") continue;
      assert.equal(services[name].ports, undefined, `${label}: ${name} must not publish a port`);
    }
    const published = services.app.ports.filter((line) => line.startsWith("-"));
    assert.deepEqual(published, ['- "0.0.0.0:80:80"', '- "0.0.0.0:443:443"', '- "0.0.0.0:443:443/udp"']);
  }
});

test("one process each: no replicas, no scale, no second portal (SR-29, SR-66)", () => {
  for (const compose of [SOURCE_COMPOSE, BUNDLE_COMPOSE]) {
    const code = withoutComments(compose);
    assert.doesNotMatch(code, /^\s*(deploy|replicas|scale):/m);
  }
});

test("the database is on an internal network the app is not on; the portal bridges the two", () => {
  for (const compose of [SOURCE_COMPOSE, BUNDLE_COMPOSE]) {
    assert.match(withoutComments(compose), /^networks:\n {2}portal-db:\n {4}internal: true$/m, "the database network has no way out");
  }
  for (const services of [SOURCE, BUNDLE]) {
    assert.deepEqual(services["portal-db"].networks, ["", "- portal-db"]);
    assert.deepEqual(services["portal-prepare"].networks, ["", "- portal-db"]);
    assert.deepEqual(services.portal.networks, ["", "- default", "- portal-db"]);
    assert.equal(services.app.networks, undefined, "the app is on the default network only, never the database's");
  }
});

test("start order: database healthy, then prepare completes, then the portal; the proxy follows the app", () => {
  for (const services of [SOURCE, BUNDLE]) {
    assert.ok(services["portal-prepare"].depends_on.some((line) => line === "condition: service_healthy"));
    assert.ok(services.portal.depends_on.some((line) => line === "condition: service_completed_successfully"));
    assert.deepEqual(services.proxy.depends_on, ["", "- app"]);
    assert.equal(services["portal-prepare"].restart[0], '"no"', "the one-shot must not restart");
  }
});

test("the portal runs as production with one trusted proxy hop, and no manual-OTP or dev-outbox switch exists (SR-10)", () => {
  for (const compose of [SOURCE_COMPOSE, BUNDLE_COMPOSE]) {
    const code = withoutComments(compose);
    assert.doesNotMatch(code, /PORTAL_ALLOW_MANUAL_OTP|PORTAL_DEV_OUTBOX/);
    for (const name of ["portal", "portal-prepare"]) {
      const env = (compose === SOURCE_COMPOSE ? SOURCE : BUNDLE)[name].environment.join("\n");
      assert.match(env, /NODE_ENV: production/, `${name} must run as production`);
      assert.match(env, /PORTAL_TRUST_PROXY: "1"/);
      assert.match(normaliseInterpolation(env), /PORTAL_PUBLIC_URL: https:\/\/\$\{PORTAL_DOMAIN\}/, `${name}: the public URL is derived from PORTAL_DOMAIN`);
    }
  }
});

test("the app reaches the portal over https through the proxy: its public name resolves to the shared loopback (SR-26)", () => {
  for (const services of [SOURCE, BUNDLE]) {
    assert.equal(normaliseInterpolation(services.app.extra_hosts.join("\n")), `\n- "${variable("PORTAL_DOMAIN")}:127.0.0.1"`);
  }
  assert.match(SOURCE_COMPOSE, /AGENTFORGE_SERVER: "1"/);
});

test("the proxy and the database are pinned to a tag, and the proxy's minor is the one every deploy path uses (SR-72)", () => {
  assert.equal(PROXY_IMAGE, "caddy:2.11-alpine");
  assert.ok(SOURCE.proxy.image[0] === PROXY_IMAGE && BUNDLE.proxy.image[0] === PROXY_IMAGE);
  assert.match(read("webapp-deploy", "k8s", "base", "app.yaml"), /image: caddy:2\.11-alpine\b/);
  for (const text of [SOURCE_COMPOSE, BUNDLE_COMPOSE, read("webapp-deploy", "k8s", "base", "app.yaml")]) {
    assert.doesNotMatch(withoutComments(text), /caddy:2-alpine/, "no floating major tag for the proxy");
  }
  assert.equal(SOURCE["portal-db"].image[0], "postgres:16");
  assert.equal(BUNDLE["portal-db"].image[0], "postgres:16");
});

// ---------- the Caddyfile ----------

/** The lines of one `(snippet) { ... }` block at column zero, trimmed. */
function snippetBody(text, name) {
  const lines = text.split("\n");
  const start = lines.indexOf(`(${name}) {`);
  assert.ok(start >= 0, `no (${name}) snippet`);
  const end = lines.indexOf("}", start);
  return lines
    .slice(start + 1, end)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

test("the Caddy sign-in filters are one list, in the Caddyfile and in the Kubernetes copy", () => {
  const main = snippetBody(CADDYFILE, "sign_in_filters");
  const k8s = snippetBody(read("webapp-deploy", "k8s", "base", "caddy", "security.caddy"), "sign_in_filters");
  assert.deepEqual(k8s, main, "k8s security.caddy drifted from webapp-deploy/Caddyfile");
  for (const field of ["request>uri", "request>headers>Referer", "resp_headers>Location"]) {
    const at = main.indexOf(`${field} query {`);
    assert.ok(at >= 0, `${field} is not filtered`);
    assert.deepEqual(main.slice(at + 1, at + 4), ["delete code", "delete state", "}"], `${field}: code and state`);
  }
  for (const gone of ["request>headers>Cookie delete", "request>headers>Authorization delete", "request>headers>Set-Cookie delete"]) {
    assert.ok(main.includes(gone), gone);
  }
});

test("the default logger is filtered too, on stderr, in the Caddyfile and in the Kubernetes copy (SR-72)", () => {
  const defaultLog = /log default \{\n\s*output stderr\n\s*format filter \{\n\s*wrap json\n\s*fields \{\n\s*import sign_in_filters\n\s*\}\n\s*\}\n\s*\}/;
  assert.match(CADDYFILE, defaultLog);
  assert.match(read("webapp-deploy", "k8s", "base", "caddy", "security.caddy"), defaultLog);
  // The snippet is read only after it is defined, so it has to come before the global options block that uses it.
  assert.ok(CADDYFILE.indexOf("(sign_in_filters) {") < CADDYFILE.indexOf("log default {"));
  const k8sCaddyfile = read("webapp-deploy", "k8s", "base", "caddy", "Caddyfile");
  assert.ok(k8sCaddyfile.indexOf("import /etc/caddy/security.caddy") < k8sCaddyfile.indexOf("import default_log"));
});

test("the billing webhook rule is the same in the Caddyfile and the Kubernetes copy (SR-03)", () => {
  for (const text of [CADDYFILE, read("webapp-deploy", "k8s", "base", "caddy", "Caddyfile")]) {
    const code = withoutComments(text);
    assert.match(code, /^\t@billing_webhook path \/api\/v1\/billing\/webhook\*$/m);
    assert.match(code, /^\trespond @billing_webhook 404$/m);
    assert.ok(
      code.indexOf("respond @billing_webhook 404") < code.indexOf("reverse_proxy 127.0.0.1:3000"),
      "the 404 must be answered before the app is proxied to",
    );
  }
});

test("the Caddyfile, with its comments stripped as the release writes it, still has the two names and balanced braces", () => {
  const shipped = caddyfileFrom(CADDYFILE, "ent-2026.10.01");
  for (const name of ["NULTRON_DOMAIN", "PORTAL_DOMAIN"]) assert.match(shipped, new RegExp(`\\{\\$${name}\\}`));
  assert.equal(shipped.split("{").length, shipped.split("}").length);
});

// ---------- the portal image ----------

test("the portal image's context is an allowlist: everything out, then exactly what the portal runs", () => {
  const rules = read("webapp-deploy", "portal.Dockerfile.dockerignore")
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"));
  assert.equal(rules[0], "*", "exclude everything first");
  assert.deepEqual(
    rules.filter((rule) => rule.startsWith("!")),
    [
      "!package.json",
      "!pnpm-lock.yaml",
      "!pnpm-workspace.yaml",
      "!.npmrc",
      "!patches",
      "!apps/*/package.json",
      "!packages/*/package.json",
      "!apps/portal",
      "!docs/internal/portal/migrations",
      "!webapp-deploy/portal-entry.sh",
      "!webapp-deploy/k8s/base/scripts/prepare-db.mjs",
    ],
  );
  for (const never of ["!docs", "!apps", "!apps/desktop", "!apps/web", "!packages/host", "!scripts", "!webapp-deploy"]) {
    assert.ok(!rules.includes(never), `${never} must not come back in whole`);
  }
  // Local state is excluded again after the allowlist, so it cannot ride in inside an allowed folder.
  const lastAllow = rules.reduce((at, rule, i) => (rule.startsWith("!") ? i : at), -1);
  for (const state of ["**/node_modules", "**/.env", "**/.env.*", "**/*.enc", "**/.master-key", "**/*.sqlite"]) {
    assert.ok(rules.indexOf(state) > lastAllow, `${state} must be excluded after the allowlist`);
  }
});

test("the Kubernetes rehearsal's narrow snapshot admits the same files the allowlist does", async () => {
  const { portalContextFiles } = await import(new URL("../webapp-deploy/k8s/local-lib.mjs", import.meta.url));
  const admitted = [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    "apps/portal/src/main.ts",
    "apps/web/package.json",
    "packages/core/package.json",
    "docs/internal/portal/migrations/0001_extensions_and_roles.sql",
    "webapp-deploy/portal.Dockerfile",
    "webapp-deploy/portal.Dockerfile.dockerignore",
    "webapp-deploy/portal-entry.sh",
    "webapp-deploy/k8s/base/scripts/prepare-db.mjs",
  ];
  const refused = [
    "apps/desktop/main.cjs",
    "apps/web/server.ts",
    "packages/host/src/index.ts",
    "docs/internal/security-register.md",
    "scripts/release-web.mjs",
    "webapp-deploy/compose.yml",
    "webapp-deploy/k8s/overlays/local/pki/ca.key",
  ];
  assert.deepEqual(portalContextFiles([...admitted, ...refused]).sort(), [...admitted].sort());
});

test("the app image's context cannot pick up local pki, secrets files or the deploy folders it never runs", () => {
  const rules = read("webapp-deploy", "Dockerfile.dockerignore");
  // nultron-files/ (4.5 GB of IP filings and brand work, git-ignored) is SR-131.
  for (const line of [
    "webapp-deploy/k8s",
    "webapp-deploy/.env",
    "webapp-deploy/*.env",
    "webapp-deploy/.pilot-local",
    "nultron-files",
  ]) {
    assert.ok(rules.split("\n").includes(line), `Dockerfile.dockerignore must exclude ${line}`);
  }
});

test("the app image's context keeps every tracked source folder named data", () => {
  // `**/data` keeps local data dirs out of the image, and also dropped packages/core/src/data (source), which
  // broke the image's load check (2026-10-06). Every tracked `<pkg>/src/.../data` needs its `!` re-include.
  const rules = read("webapp-deploy", "Dockerfile.dockerignore").split("\n");
  assert.ok(rules.includes("**/data"), "the local data dirs stay excluded");
  const listed = spawnSync("git", ["ls-files"], { cwd: join(dirname(fileURLToPath(import.meta.url)), ".."), encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  const sourceDataDirs = new Set(
    listed.stdout
      .split("\n")
      .map((file) => /^(.*\/src\/(?:.*\/)?data)\//.exec(file)?.[1])
      .filter(Boolean),
  );
  assert.ok(sourceDataDirs.has("packages/core/src/data"));
  for (const dir of sourceDataDirs) {
    assert.ok(rules.includes(`!${dir}`) && rules.includes(`!${dir}/**`), `Dockerfile.dockerignore must re-include ${dir}`);
  }
});

test("webapp-deploy/.dockerignore stays a byte-for-byte copy of Dockerfile.dockerignore", () => {
  // It drifted once (2026-10-01): the copy lacked the *.enc, .master-key, sqlite, k8s and pki lines,
  // so a build with webapp-deploy/ as its context would have re-opened SR-49.
  assert.equal(read("webapp-deploy", ".dockerignore"), read("webapp-deploy", "Dockerfile.dockerignore"));
});

// ---------- the env templates ----------

/** NAME -> value for the assignments of an env template. */
function envValues(file) {
  const values = {};
  for (const line of read(...file).split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

test("the env templates carry every variable the release writes, and the portal's secrets never sit in the app's", () => {
  const app = envValues(["webapp-deploy", ".env.example"]);
  const portal = envValues(["webapp-deploy", "portal.env.example"]);
  for (const name of REQUIRED_ENV) assert.ok(name in app, `.env.example is missing ${name}`);
  for (const name of REQUIRED_PORTAL_ENV) assert.ok(name in portal, `portal.env.example is missing ${name}`);
  for (const name of REQUIRED_PORTAL_ENV) assert.ok(!(name in app), `${name} is the portal's: it must not be in the app's .env.example`);
  assert.ok(!Object.keys(app).some((name) => name.startsWith("PORTAL_") && name !== "PORTAL_DOMAIN"), "no PORTAL_* but the domain in .env.example");
  assert.ok(!("PORTAL_ALLOW_MANUAL_OTP" in portal) && !("PORTAL_DEV_OUTBOX" in portal), "the portal refuses these in production");
});

test("the templates hold placeholders, never a secret", () => {
  const app = envValues(["webapp-deploy", ".env.example"]);
  const portal = envValues(["webapp-deploy", "portal.env.example"]);
  const secrets = [
    [app, ["AGENTFORGE_SECRETS_KEY", "AGENTFORGE_PORTAL_CLIENT_SECRET", "AGENTFORGE_BILLING_WEBHOOK_SECRET", "BACKUP_KEY", "COS_SECRET_KEY"]],
    [portal, ["PORTAL_SIGNING_KEY", "PORTAL_POSTGRES_PASSWORD", "PORTAL_APP_DB_PASSWORD", "PORTAL_SMTP_USER", "PORTAL_SMTP_PASS"]],
  ];
  for (const [values, names] of secrets) for (const name of names) assert.equal(values[name], "", `${name} must be empty in the template`);
});

test("AGENTFORGE_PORTAL_URL is the portal's bare https origin, on PORTAL_DOMAIN (SR-26), with no /api suffix", () => {
  const app = envValues(["webapp-deploy", ".env.example"]);
  const url = new URL(app.AGENTFORGE_PORTAL_URL);
  assert.equal(url.protocol, "https:");
  assert.equal(url.pathname, "/", "the stand-in portal serves /auth/token at its root");
  assert.equal(app.AGENTFORGE_PORTAL_URL.endsWith("/"), false);
  assert.equal(url.host, app.PORTAL_DOMAIN);
  assert.equal(app.AGENTFORGE_TRUSTED_ORIGINS, `https://${app.NULTRON_DOMAIN}`);
});

test("the SES template is implicit TLS on 465, which the portal's config reads as PORTAL_SMTP_SECURE=1", () => {
  const portal = envValues(["webapp-deploy", "portal.env.example"]);
  for (const name of ["PORTAL_SMTP_HOST", "PORTAL_SMTP_PORT", "PORTAL_SMTP_SECURE"]) assert.equal(portal[name], ENV_DEFAULTS[name], name);
  assert.equal(portal.PORTAL_SMTP_HOST, "sg-smtp.qcloudmail.com");
  assert.equal(portal.PORTAL_SMTP_PORT, "465");
  assert.equal(portal.PORTAL_SMTP_SECURE, "1");
});

test("the source portal.env.example sets the same sign-in mode as the release template", () => {
  const portal = envValues(["webapp-deploy", "portal.env.example"]);
  assert.equal(portal.PORTAL_SIGNIN_MODE, "password");
  assert.equal(portal.PORTAL_SIGNIN_MODE, ENV_DEFAULTS.PORTAL_SIGNIN_MODE);
});

// ---------- the DSN wrapper and the operator script ----------

const ENTRY = join(ROOT, "webapp-deploy", "portal-entry.sh");

function entry(env, ...command) {
  const result = spawnSync("sh", [ENTRY, ...command], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("portal-entry.sh builds both DSNs from the two passwords and runs the command", () => {
  const run = entry(
    { PORTAL_POSTGRES_PASSWORD: "ownerpw1", PORTAL_APP_DB_PASSWORD: "loginpw2" },
    "sh",
    "-c",
    'echo "$PORTAL_MIGRATE_DATABASE_URL"; echo "$PORTAL_DATABASE_URL"',
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split("\n"), [
    "postgres://portal:ownerpw1@portal-db:5432/tokotoken_portal",
    "postgres://portal_app_login:loginpw2@portal-db:5432/tokotoken_portal",
  ]);
});

test("portal-entry.sh takes a managed database's host from the environment", () => {
  const run = entry(
    { PORTAL_POSTGRES_PASSWORD: "a", PORTAL_APP_DB_PASSWORD: "b", PORTAL_DB_HOST: "db.internal", PORTAL_DB_PORT: "6432", PORTAL_DB_OWNER: "owner" },
    "sh",
    "-c",
    'echo "$PORTAL_MIGRATE_DATABASE_URL"',
  );
  assert.equal(run.stdout.trim(), "postgres://owner:a@db.internal:6432/tokotoken_portal");
});

test("portal-entry.sh refuses a missing password, and a password that would not survive a URL, without echoing it", () => {
  const missing = entry({ PORTAL_POSTGRES_PASSWORD: "a" }, "true");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /PORTAL_APP_DB_PASSWORD is not set/);
  for (const bad of ["p@ss", "p:ss", "p/ss", "p ss", "p#ss", "p%40"]) {
    const run = entry({ PORTAL_POSTGRES_PASSWORD: bad, PORTAL_APP_DB_PASSWORD: "b" }, "true");
    assert.equal(run.status, 1, bad);
    assert.match(run.stderr, /PORTAL_POSTGRES_PASSWORD may contain only/);
    assert.ok(!run.stderr.includes(bad) && !run.stdout.includes(bad), "the value must never be echoed");
  }
});

test("portal.sh refuses otp (SR-10), runs scripts only through the DSN wrapper, and takes a plain script name", () => {
  const script = read("webapp-deploy", "scripts", "portal.sh");
  assert.match(script, /^otp\)$/m);
  assert.match(script, /\*\[!a-z0-9-\]\*\)/, "the script name is validated");
  assert.match(script, /dc exec -T portal sh \/app\/webapp-deploy\/portal-entry\.sh \.\/node_modules\/\.bin\/tsx "scripts\/\$NAME\.ts" "\$@"/);
  assert.doesNotMatch(
    script
      .split("\n")
      .filter((line) => !line.startsWith("#"))
      .join("\n"),
    /PORTAL_ALLOW_MANUAL_OTP/,
  );
});

// ---------- the local rehearsal's pure helpers (webapp-deploy/pilot-local.mjs) ----------

const local = await import(new URL("../webapp-deploy/pilot-local.mjs", import.meta.url));

test("the rehearsal's Caddyfile is the real one with ONLY its two tls blocks pointed at the throwaway certificate", () => {
  const rehearsal = local.localCaddyfile(CADDYFILE);
  const changed = [];
  const a = CADDYFILE.split("\n");
  const b = rehearsal.split("\n");
  assert.equal(a.length, b.length, "no lines added or removed outside the tls blocks");
  a.forEach((line, i) => {
    if (line !== b[i]) changed.push([line, b[i]]);
  });
  assert.deepEqual(changed, [
    ["\ttls {", "\ttls /certs/edge.crt /certs/edge.key {"],
    ["\ttls {", "\ttls /certs/edge.crt /certs/edge.key {"],
  ]);
  assert.throws(() => local.localCaddyfile("example.com {\n\ttls internal\n}\n"), /exactly two tls blocks/);
  // Everything the rehearsal exists to exercise is still there, untouched.
  for (const kept of ["log default {", "resp_headers>Location query {", "@billing_webhook path /api/v1/billing/webhook*", "reverse_proxy portal:4000 {"]) {
    assert.ok(rehearsal.includes(kept), kept);
  }
});

test("the rehearsal's generated env keeps the portal's secrets out of the app's file, keeps what exists, and uses URL-safe passwords", () => {
  const first = local.localEnvValues({}, (bytes) => "ab".repeat(bytes));
  for (const name of Object.keys(first.portal).filter((n) => /SIGNING|PASSWORD/.test(n))) assert.ok(!(name in first.app), name);
  assert.match(first.portal.PORTAL_POSTGRES_PASSWORD, /^[A-Za-z0-9._~-]+$/);
  assert.equal(new URL(first.app.AGENTFORGE_PORTAL_URL).host, first.app.PORTAL_DOMAIN);
  assert.equal(first.app.AGENTFORGE_TRUSTED_ORIGINS, `https://${first.app.NULTRON_DOMAIN}`);
  assert.equal(first.portal.PORTAL_SMTP_SECURE, "1", "the rehearsal runs the SES-shaped mail path");
  const again = local.localEnvValues({ ...first.app, ...first.portal }, () => "SHOULD-NOT-BE-USED");
  assert.deepEqual(again, first, "a re-run rotates nothing");
});

test("the rehearsal reads the code from a mail and the secrets from a callback URL", () => {
  assert.equal(local.codeFromMail("Your Nultron code is 482913. It expires in 10 minutes."), "482913");
  assert.equal(local.codeFromMail("order 1234567 and 12345"), null, "only a run of exactly six digits");
  assert.deepEqual(
    local.callbackSecrets(["https://nultron.localhost/auth/callback?code=abc&state=def", "https://nultron.localhost/chat?code=zzz"]),
    [
      { name: "code", value: "abc" },
      { name: "state", value: "def" },
    ],
  );
  assert.throws(() => local.parseArgs(["nope"]), /usage/);
  assert.equal(local.parseArgs(["up", "--skip-build", "--email", "a@b.c"]).flags.email, "a@b.c");
});
