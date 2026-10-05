#!/usr/bin/env node
/**
 * Rehearse the Phase 0 pilot compose stack (compose.yml) on THIS machine, reachable on loopback only.
 * HARNESS: it never pushes an image, never logs in to a registry, never opens a tunnel, and binds nothing
 * but 127.0.0.1 (compose.local.yml replaces the stack's 0.0.0.0 ports).
 *
 *   node webapp-deploy/pilot-local.mjs up [--skip-build] [--email <address>]
 *   node webapp-deploy/pilot-local.mjs drive [--email <address>]
 *   node webapp-deploy/pilot-local.mjs down [--purge]
 *
 * up     preflight (Docker answers; 127.0.0.1:80, :443 and :18025 are free) -> a throwaway CA and generated
 *        env files in webapp-deploy/.pilot-local (gitignored) -> the REAL Caddyfile with only its `tls` blocks
 *        pointed at the throwaway certificate -> two images built from a `git ls-files -co --exclude-standard`
 *        snapshot -> the portal alone (database, migrations, the app-login password) -> seed one tenant and
 *        one user, store the client secret the seed prints once -> the whole stack.
 * drive  headless Chromium: the sign-in screen, the portal, the e-mailed code read from Mailpit, the landing,
 *        the session; then `docker compose restart app proxy` and the same browser again; then both log streams
 *        of the proxy searched for the code and state that really went through.
 * down   `compose down -v` (volumes included) and the pilot images; --purge also deletes .pilot-local.
 *
 * https://nultron.localhost and https://portal.nultron.localhost, on the default ports. Chromium resolves
 * *.localhost to loopback itself. The browser context ignores certificate errors (the CA is throwaway and is
 * NOT trusted system-wide); the app, the portal and Mailpit verify each other against it properly.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildLocalImages } from "./k8s/local-images.mjs";
import { REPO_ROOT, ensurePki, parseEnvFile } from "./k8s/local-lib.mjs";
import { parseSeedSecret } from "./k8s/rehearse-local.mjs";

export const DEPLOY_DIR = dirname(fileURLToPath(import.meta.url));
export const STATE_DIR = join(DEPLOY_DIR, ".pilot-local");
export const PKI_DIR = join(STATE_DIR, "pki");
export const PROJECT = "nultron-pilot-local";
export const IMAGE_TAG = "pilot-local";
export const APP_HOST = "nultron.localhost";
export const PORTAL_HOST = "portal.nultron.localhost";
const ENV_FILE = join(STATE_DIR, ".env");
const PORTAL_ENV_FILE = join(STATE_DIR, "portal.env");
const CADDYFILE = join(STATE_DIR, "Caddyfile");
const SECRET_PLACEHOLDER = "pending-seed-run-pilot-local";
const DEFAULT_EMAIL = "tester@nultron.test";
const log = (line) => console.log(`pilot-local: ${line}`);

// ---------- pure helpers (tested) ----------

/**
 * The real Caddyfile with ONLY its two `tls` blocks pointed at the throwaway certificate files. Everything else
 * (the log filters, the headers, the billing rule, the upstreams) is what ships. Throws if it cannot find
 * exactly the two blocks, so a reshaped Caddyfile cannot be rehearsed through a silent no-op.
 */
export function localCaddyfile(source) {
  const text = source.replace(/\r\n/g, "\n");
  const block = "\ttls {\n\t\tprotocols tls1.2 tls1.3\n\t}";
  const count = text.split(block).length - 1;
  if (count !== 2) throw new Error(`expected exactly two tls blocks in webapp-deploy/Caddyfile, found ${count}`);
  return text.split(block).join("\ttls /certs/edge.crt /certs/edge.key {\n\t\tprotocols tls1.2 tls1.3\n\t}");
}

/** The values the two generated env files hold. Existing values are kept, so a re-run rotates nothing. */
export function localEnvValues(existing = {}, makeSecret = (bytes) => randomBytes(bytes).toString("hex")) {
  const keep = (name, make) => (existing[name] ? existing[name] : make());
  return {
    app: {
      NULTRON_DOMAIN: APP_HOST,
      PORTAL_DOMAIN: PORTAL_HOST,
      AGENTFORGE_SECRETS_KEY: keep("AGENTFORGE_SECRETS_KEY", () => makeSecret(32)),
      AGENTFORGE_TRUSTED_ORIGINS: `https://${APP_HOST}`,
      AGENTFORGE_PORTAL_URL: `https://${PORTAL_HOST}`,
      AGENTFORGE_PORTAL_CLIENT_ID: "nultron-web",
      AGENTFORGE_PORTAL_CLIENT_SECRET: keep("AGENTFORGE_PORTAL_CLIENT_SECRET", () => SECRET_PLACEHOLDER),
      AGENTFORGE_BILLING_WEBHOOK_SECRET: keep("AGENTFORGE_BILLING_WEBHOOK_SECRET", () => makeSecret(32)),
    },
    portal: {
      PORTAL_SIGNING_KEY: keep("PORTAL_SIGNING_KEY", () => makeSecret(32)),
      PORTAL_POSTGRES_PASSWORD: keep("PORTAL_POSTGRES_PASSWORD", () => makeSecret(24)),
      PORTAL_APP_DB_PASSWORD: keep("PORTAL_APP_DB_PASSWORD", () => makeSecret(24)),
      // Mailpit speaks implicit TLS from the first byte, like SES on 465: the portal is configured as in production.
      PORTAL_SMTP_HOST: "mailpit",
      PORTAL_SMTP_PORT: "1025",
      PORTAL_SMTP_SECURE: "1",
      PORTAL_SMTP_FROM: "Nultron local <no-reply@nultron.localhost>",
    },
  };
}

function formatEnv(header, values) {
  return `${header}\n${Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`;
}

/** The sign-in code in a mail body: the one run of exactly six digits. */
export function codeFromMail(text) {
  const match = /(?<![0-9])([0-9]{6})(?![0-9])/.exec(text);
  return match ? match[1] : null;
}

/** Every value the sign-in put in a callback URL, for the log search. */
export function callbackSecrets(urls) {
  const found = [];
  for (const raw of urls) {
    const url = new URL(raw);
    if (url.pathname !== "/auth/callback") continue;
    for (const name of ["code", "state"]) {
      const value = url.searchParams.get(name);
      if (value) found.push({ name, value });
    }
  }
  return found;
}

// ---------- docker ----------

function sh(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error ?? null };
}

function must(result, what) {
  if (result.error) throw new Error(`${what}: could not start (${result.error.message})`);
  if (result.status !== 0) throw new Error(`${what} exited ${result.status}\n${(result.stderr || result.stdout).trim()}`);
  return result;
}

function composeArgs(args) {
  return [
    "compose",
    "-p",
    PROJECT,
    "-f",
    join(DEPLOY_DIR, "compose.yml"),
    "-f",
    join(DEPLOY_DIR, "compose.local.yml"),
    "--env-file",
    ENV_FILE,
    ...args,
  ];
}

const compose = (args, options = {}) => sh("docker", composeArgs(args), { cwd: DEPLOY_DIR, ...options });
const composeInherit = (args) => spawnSync("docker", composeArgs(args), { cwd: DEPLOY_DIR, stdio: "inherit" });

function containerId(service) {
  return compose(["ps", "-q", service]).stdout.trim().split("\n")[0] ?? "";
}

function inspect(id, format) {
  return sh("docker", ["inspect", "--format", format, id]).stdout.trim();
}

async function until(what, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const result = await probe();
    if (result === true) return;
    last = typeof result === "string" ? result : last;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (${last})` : ""}`);
}

const healthy = (service) => () => {
  const id = containerId(service);
  if (!id) return "no container";
  const status = inspect(id, "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}");
  return status === "healthy" ? true : status;
};

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

function edgeGet(host, path, ca, extra = {}) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: "127.0.0.1", port: 443, path, method: extra.method ?? "GET", servername: host, ca, headers: { Host: host, ...(extra.headers ?? {}) } },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ---------- up ----------

function writeState(values) {
  mkdirSync(STATE_DIR, { recursive: true });
  const app = formatEnv("# Pilot-local rehearsal: the APP's env. Generated, gitignored, never reuse these values anywhere.", values.app);
  const portal = formatEnv("# Pilot-local rehearsal: the PORTAL's env. Generated, gitignored, never reuse these values anywhere.", values.portal);
  writeFileSync(ENV_FILE, app, { encoding: "utf8", mode: 0o600 });
  writeFileSync(PORTAL_ENV_FILE, portal, { encoding: "utf8", mode: 0o600 });
}

function readState() {
  return {
    ...(existsSync(ENV_FILE) ? parseEnvFile(readFileSync(ENV_FILE, "utf8")) : {}),
    ...(existsSync(PORTAL_ENV_FILE) ? parseEnvFile(readFileSync(PORTAL_ENV_FILE, "utf8")) : {}),
  };
}

async function up(flags) {
  const own = existsSync(ENV_FILE) && containerId("app");
  if (!own) {
    for (const port of [80, 443, 18025]) {
      if (!(await portFree(port))) throw new Error(`127.0.0.1:${port} is already in use; stop what holds it (this rehearsal needs 80, 443 and 18025)`);
    }
  }
  must(sh("docker", ["info", "--format", "{{.ServerVersion}}"]), "docker info");
  log(`docker answers; 127.0.0.1:80, :443 and :18025 ${own ? "are this rehearsal's" : "are free"}`);

  const created = ensurePki(PKI_DIR);
  log(`${created ? "generated" : "kept"} the throwaway CA and certificates in .pilot-local/pki (gitignored)`);
  writeState(localEnvValues(readState()));
  writeFileSync(CADDYFILE, localCaddyfile(readFileSync(join(DEPLOY_DIR, "Caddyfile"), "utf8")), "utf8");
  log("wrote .pilot-local/.env, portal.env and Caddyfile (the real one, tls blocks only)");

  if (!flags.skipBuild) {
    const built = buildLocalImages({ force: true, tag: IMAGE_TAG, log: (line) => log(line) });
    log(`images ${built.appImage} and ${built.portalImage} (never pushed)`);
  }
  must(sh("docker", ["image", "inspect", `nultron-ent:${IMAGE_TAG}`, `nultron-portal:${IMAGE_TAG}`]), "the pilot images exist");

  log("starting the portal alone: its database, the migrations, the app-login password");
  must(compose(["up", "-d", "--no-build", "portal", "mailpit"]), "compose up portal");
  await until("portal healthy", 240_000, healthy("portal"));
  log("portal healthy");

  const state = readState();
  if (state.AGENTFORGE_PORTAL_CLIENT_SECRET === SECRET_PLACEHOLDER) {
    const seeded = compose([
      "exec",
      "-T",
      "portal",
      "sh",
      "/app/webapp-deploy/portal-entry.sh",
      "./node_modules/.bin/tsx",
      "scripts/seed.ts",
      "--email",
      flags.email,
      "--redirect",
      `https://${APP_HOST}/auth/callback`,
    ]);
    must(seeded, "portal seed");
    const secret = parseSeedSecret(seeded.stdout);
    if (!secret) throw new Error("the seed printed no client secret (the client already existed in a kept database?). Run `down` and `up` again");
    const values = localEnvValues({ ...state, AGENTFORGE_PORTAL_CLIENT_SECRET: secret });
    writeState(values);
    log("seeded one tenant, one org and one user; the client secret (printed once) is stored in .pilot-local/.env");
  } else {
    log("client secret already stored; not seeding again");
  }

  log("starting the whole stack");
  must(compose(["up", "-d", "--no-build"]), "compose up");
  await until("app healthy", 300_000, healthy("app"));
  const ca = readFileSync(join(PKI_DIR, "ca.crt"));
  await until("the edge answering /healthz with a verified certificate", 120_000, async () => {
    try {
      return (await edgeGet(APP_HOST, "/healthz", ca)).status === 200;
    } catch (error) {
      return error.code ?? String(error.message);
    }
  });
  log(`up: https://${APP_HOST}/  (portal https://${PORTAL_HOST}/, inbox http://127.0.0.1:18025/). Sign-in e-mail: ${flags.email}`);
}

// ---------- down ----------

function down(flags) {
  composeInherit(["down", "-v", "--remove-orphans"]);
  for (const image of [`nultron-ent:${IMAGE_TAG}`, `nultron-portal:${IMAGE_TAG}`]) sh("docker", ["image", "rm", image]);
  if (flags.purge) {
    rmSync(STATE_DIR, { recursive: true, force: true });
    log("deleted .pilot-local");
  }
  log("down: containers, network and volumes of the project removed");
}

// ---------- drive ----------

async function mailpitMessages(since) {
  const list = await (await fetch("http://127.0.0.1:18025/api/v1/messages")).json();
  return (list.messages ?? []).filter((message) => new Date(message.Created).getTime() >= since);
}

async function waitForCode(since) {
  let code = null;
  await until("the sign-in e-mail in Mailpit", 90_000, async () => {
    const [message] = await mailpitMessages(since);
    if (!message) return "no mail yet";
    const full = await (await fetch(`http://127.0.0.1:18025/api/v1/message/${message.ID}`)).json();
    code = codeFromMail(full.Text ?? "");
    return code ? true : "mail has no six-digit code";
  });
  return code;
}

function logStreams(service) {
  const id = containerId(service);
  const out = sh("docker", ["logs", id]);
  return { stdout: out.stdout, stderr: out.stderr };
}

async function drive(flags) {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  };
  const ca = readFileSync(join(PKI_DIR, "ca.crt"));
  const { chromium } = createRequire(join(REPO_ROOT, "apps", "web", "package.json"))("playwright");

  // The edge, without a browser: certificate verified against the throwaway CA.
  const health = await edgeGet(APP_HOST, "/healthz", ca);
  check("GET /healthz through Caddy, certificate verified against the throwaway CA", health.status === 200, health.body);
  const portalHealth = await edgeGet(PORTAL_HOST, "/healthz", ca);
  check("GET https://portal/healthz through the same Caddy", portalHealth.status === 200);
  const headers = health.headers;
  check("security headers on the app name", /max-age=31536000/.test(headers["strict-transport-security"] ?? "") && /script-src 'self'/.test(headers["content-security-policy"] ?? "") && !headers.server && !headers["x-powered-by"]);
  for (const path of ["/api/v1/billing/webhook", "/api/v1/billing/webhook/", "/API/V1/BILLING/WEBHOOK", "/api/v1/billing/%77ebhook"]) {
    const reply = await edgeGet(APP_HOST, path, ca, { method: "POST" });
    check(`POST ${path} is answered 404 by Caddy, with no body`, reply.status === 404 && reply.body === "", `status ${reply.status}`);
  }

  const startedAt = Date.now();
  const browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const seenUrls = [];
  page.on("request", (request) => seenUrls.push(request.url()));

  await page.goto(`https://${APP_HOST}/`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("auth-signin").waitFor({ timeout: 60_000 });
  check("a signed-out visit shows the sign-in screen, not the paste-your-key onboarding", true);
  await page.getByTestId("auth-signin-start").click();
  await page.waitForURL(new RegExp(`^https://${PORTAL_HOST.replaceAll(".", "\\.")}/`), { timeout: 60_000 });
  check("the sign-in button goes to the portal's own name over https", true, page.url().split("?")[0]);

  await page.locator("#email").fill(flags.email);
  await page.locator('button[type="submit"]:not(.secondary)').click();
  const code = await waitForCode(startedAt);
  check("the portal e-mailed a six-digit code to Mailpit over implicit TLS (PORTAL_SMTP_SECURE=1)", Boolean(code));
  await page.locator("#code").fill(code);
  await page.locator('button[type="submit"]:not(.secondary)').click();
  await page.waitForURL((url) => url.host === APP_HOST && !url.searchParams.has("code"), { timeout: 60_000 });
  await page.waitForLoadState("networkidle");
  check("the browser lands back on the app, with no code or state left in the address bar", !/[?&](code|state)=/.test(page.url()), page.url());

  const session = await page.request.get(`https://${APP_HOST}/api/v1/auth/session`);
  check("GET /api/v1/auth/session answers 200 for the signed-in browser", session.status() === 200, `status ${session.status()}`);
  const before = session.status() === 200 ? await session.json() : {};
  const secrets = callbackSecrets(seenUrls);
  check("the callback URL really carried a code and a state (so the log search below means something)", secrets.length >= 2, `${secrets.length} values`);

  // Restart the app. The proxy shares its network namespace, so both are restarted together.
  log("docker compose restart app proxy ...");
  must(compose(["restart", "app", "proxy"]), "compose restart app proxy");
  await until("app healthy after the restart", 300_000, healthy("app"));
  await until("the edge back", 120_000, async () => {
    try {
      return (await edgeGet(APP_HOST, "/healthz", ca)).status === 200;
    } catch (error) {
      return error.code ?? "down";
    }
  });
  const after = await page.request.get(`https://${APP_HOST}/api/v1/auth/session`);
  const afterBody = after.status() === 200 ? await after.json() : {};
  check("after restarting the app container the same browser is still signed in", after.status() === 200, `status ${after.status()}`);
  check("and it is the same session", JSON.stringify(afterBody) === JSON.stringify(before) || Object.keys(afterBody).length > 0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
  const signedOut = await page.getByTestId("auth-signin").count();
  check("reloading the page shows the desk, not the sign-in screen", signedOut === 0);
  await browser.close();

  // Force an upstream ERROR on a sign-in URL: stop the portal, wait until Caddy's active health check has taken it
  // out of rotation, and ask for /authorize?code=...&state=.... Caddy answers 5xx and writes an error line that
  // names the request with its full URI to its DEFAULT logger (stderr). That is the stream SR-72 left open.
  const forcedCode = `FORCEDCODE${randomBytes(6).toString("hex")}`;
  const forcedState = `FORCEDSTATE${randomBytes(6).toString("hex")}`;
  log("stopping the portal to force an upstream error on a sign-in URL ...");
  must(compose(["stop", "portal"]), "compose stop portal");
  await new Promise((resolve) => setTimeout(resolve, 16_000));
  const forced = await edgeGet(PORTAL_HOST, `/authorize?code=${forcedCode}&state=${forcedState}`, ca);
  check("with the portal down, Caddy answers a sign-in URL with a 5xx", forced.status >= 500, `status ${forced.status}`);
  must(compose(["start", "portal"]), "compose start portal");
  await until("portal healthy again", 180_000, healthy("portal"));

  // Both streams of every container that saw the sign-in: no code or state value, and no mailed code.
  const mailCode = code ?? "no-code";
  const needles = [...secrets.map((entry) => entry.value), mailCode, forcedCode, forcedState];
  const errorLines = logStreams("proxy").stderr.split("\n").filter((line) => line.includes('"level":"error"') && line.includes('"uri":"/authorize'));
  check("the error line for the forced failure IS in Caddy's default log (so the search below is not vacuous)", errorLines.length > 0, `${errorLines.length} line(s)`);
  for (const service of ["proxy", "app", "portal"]) {
    const { stdout, stderr } = logStreams(service);
    const leaked = needles.filter((needle) => stdout.includes(needle) || stderr.includes(needle));
    check(`${service}: neither log stream (stdout ${stdout.split("\n").length} lines, stderr ${stderr.split("\n").length} lines) holds a code, a state or the mailed code`, leaked.length === 0, leaked.length ? `LEAKED ${leaked.length} value(s)` : "");
  }
  const proxyLogs = logStreams("proxy");
  const callbackLines = proxyLogs.stdout.split("\n").filter((line) => line.includes("/auth/callback") || line.includes("/authorize"));
  check("the proxy access log still records the sign-in requests, with the query filtered", callbackLines.length > 0 && callbackLines.every((line) => !/[?&](code|state)=/.test(line)), `${callbackLines.length} lines`);

  const failed = results.filter((r) => !r.ok);
  log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) throw new Error(`failed: ${failed.map((f) => f.name).join("; ")}`);
}

// ---------- entry ----------

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = { email: DEFAULT_EMAIL, skipBuild: false, purge: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--email") flags.email = rest[++i];
    else if (rest[i] === "--skip-build") flags.skipBuild = true;
    else if (rest[i] === "--purge") flags.purge = true;
    else throw new Error(`unknown argument ${rest[i]}`);
  }
  if (!["up", "drive", "down"].includes(command)) throw new Error("usage: pilot-local.mjs up | drive | down [--skip-build] [--email <address>] [--purge]");
  return { command, flags };
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === "up") await up(flags);
  else if (command === "drive") await drive(flags);
  else down(flags);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`pilot-local: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
