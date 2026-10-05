#!/usr/bin/env node
/**
 * Release the Enterprise (hosted web app) to Kyoo032/NultronEnt, its deploy-bundle + release repo.
 * Modelled on apps/desktop/scripts/release-desktop.mjs, which does the same for the Personal app on
 * Kyoo032/Nultron. Run it after the deploy of <sha> is driven and logged in
 * docs/internal/web-pivot-2026-09-18.md (Deploy log).
 *
 *   node scripts/release-web.mjs --tag ent-2026.09.23 --sha <sha>
 *        [--dry-run] [--skip-image] [--draft] [--allow-dirty]
 *
 * In order:
 *   1. preflight: the tag is `ent-YYYY.MM.DD[.N]`, the tree is clean (unless --allow-dirty), <sha>
 *      resolves, docs/public/<tag>-notes.md exists and carries none of the five banned marks, and
 *      every file about to be published passes the same check;
 *   2. images: `git archive <sha>` into a temp dir, then from there
 *      `docker build -f webapp-deploy/Dockerfile -t ghcr.io/kyoo032/nultron-ent:<tag> .` and
 *      `docker build -f webapp-deploy/portal.Dockerfile -t ghcr.io/kyoo032/nultron-portal:<tag> .`
 *      (the app image cannot run the portal: it lacks the portal's node_modules), both built before
 *      either is `docker push`ed. Building from the archive, never from this checkout, is what keeps
 *      untracked local state (a webdev data dir with its .master-key, an apps/web/.env.local) out of
 *      the images - the dockerignore only excludes `data` and `.env*` at the repo root;
 *   3. bundle: clone NultronEnt into the same temp dir, write compose.yml (both images pinned to the
 *      tag), .env.example, portal.env.example, DEPLOY.md and Caddyfile, commit `Release <tag>` as the
 *      git user of this repo with no trailers, push `main`;
 *   4. release: `gh release create <tag>` with the notes + `Source: agentforge@<sha>` +
 *      `Image: <image>` + `Portal image: <portal image>`, then `gh release view` to confirm.
 * The temp dir is removed on every exit path.
 *
 * `--dry-run` runs no docker, no gh, and no git beyond reading this repo (status, rev-parse, and
 * `show <sha>:webapp-deploy/Caddyfile`). `--skip-image` skips step 2 only (both images for this tag
 * are already pushed). This script never pushes agentforge.
 *
 * Rizky has not confirmed the tag scheme; ent-CalVer is the working default (AGENTS.md, Web release).
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { forbiddenMarksIn } from "./release-marks.mjs";

// The refusal list and its matcher live in ./release-marks.mjs, shared with the Personal release
// (apps/desktop/scripts/release-desktop.mjs). Re-exported so this module's API does not change.
export { FORBIDDEN_MARKS, forbiddenMarksIn } from "./release-marks.mjs";

export const RELEASE_REPO = "Kyoo032/NultronEnt";
export const RELEASE_REPO_URL = `https://github.com/${RELEASE_REPO}.git`;
export const SOURCE_REPO_NAME = "agentforge";
export const IMAGE_REPO = "ghcr.io/kyoo032/nultron-ent";
/** The portal stand-in's own image (webapp-deploy/portal.Dockerfile). The app image cannot run it. */
export const PORTAL_IMAGE_REPO = "ghcr.io/kyoo032/nultron-portal";
/** The proxy image, pinned to the minor: the Caddyfile's sign-in log filters need Caddy 2.8 or later (SR-72). */
export const PROXY_IMAGE = "caddy:2.11-alpine";
export const DATABASE_IMAGE = "postgres:16";
/**
 * What the hosted app refuses to boot without (packages/host/src/hosted-env.ts, hostedEnvProblems,
 * with NODE_ENV=production), plus the two domains the Caddyfile serves. This is the APP's .env: the
 * app container loads it. The portal side's secrets are REQUIRED_PORTAL_ENV, in a second file the app
 * never sees.
 */
export const REQUIRED_ENV = [
  "NULTRON_DOMAIN",
  "PORTAL_DOMAIN",
  "AGENTFORGE_SECRETS_KEY",
  "AGENTFORGE_TRUSTED_ORIGINS",
  "AGENTFORGE_PORTAL_URL",
  "AGENTFORGE_PORTAL_CLIENT_ID",
  "AGENTFORGE_PORTAL_CLIENT_SECRET",
  "AGENTFORGE_BILLING_WEBHOOK_SECRET",
];
/**
 * What the portal, its one-shot prepare step and its database need (apps/portal/src/config.ts, with
 * NODE_ENV=production): the signing key, the two database passwords, and the SMTP login. Loaded by those
 * three services only (compose.yml), never by the app or the proxy.
 */
export const REQUIRED_PORTAL_ENV = [
  "PORTAL_SIGNING_KEY",
  "PORTAL_POSTGRES_PASSWORD",
  "PORTAL_APP_DB_PASSWORD",
  "PORTAL_SMTP_HOST",
  "PORTAL_SMTP_PORT",
  "PORTAL_SMTP_SECURE",
  "PORTAL_SMTP_USER",
  "PORTAL_SMTP_PASS",
  "PORTAL_SMTP_FROM",
];
/** The few template values that are not empty: the seed's default client id and the SES settings (implicit TLS on 465). */
export const ENV_DEFAULTS = {
  AGENTFORGE_PORTAL_CLIENT_ID: "nultron-web",
  PORTAL_SMTP_HOST: "sg-smtp.qcloudmail.com",
  PORTAL_SMTP_PORT: "465",
  PORTAL_SMTP_SECURE: "1",
};
export const BUNDLE_FILES = ["compose.yml", ".env.example", "portal.env.example", "DEPLOY.md", "Caddyfile"];

const TAG_PATTERN = /^ent-(\d{4})\.(\d{2})\.(\d{2})(?:\.([1-9]\d*))?$/;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const defaultRepoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export class ReleaseError extends Error {}

function fail(reason) {
  throw new ReleaseError(reason);
}

/** Returns null when the tag is valid, otherwise the reason it is not. */
export function tagProblem(tag) {
  const match = TAG_PATTERN.exec(tag ?? "");
  if (!match) return `tag "${tag}" is not ent-YYYY.MM.DD or ent-YYYY.MM.DD.N`;
  const [, year, month, day, sequence] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const real =
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day);
  if (!real) return `tag "${tag}" names a date that does not exist`;
  if (sequence !== undefined && Number(sequence) < 2) {
    return `tag "${tag}": the same-day suffix starts at .2 (the first release of a day has none)`;
  }
  return null;
}

/**
 * The notes check (forbiddenMarksIn, ./release-marks.mjs) for a generated file. The one exception
 * is the source repo's own name, which the app's env names (AGENTFORGE_*), the image's
 * /opt/agentforge path and the `Source:` line cannot avoid. Every other "agent" is still refused,
 * so "Agents" or "agent-written" fails.
 */
export function forbiddenMarksInPublished(text) {
  return forbiddenMarksIn(text.replace(/agentforge/gi, ""));
}

function assertPublishable(name, text) {
  const marks = forbiddenMarksInPublished(text);
  if (marks.length > 0) fail(`refusing to publish ${name}: it contains ${marks.map((m) => `"${m}"`).join(", ")}`);
}

export function imageRef(tag) {
  return `${IMAGE_REPO}:${tag}`;
}

export function portalImageRef(tag) {
  return `${PORTAL_IMAGE_REPO}:${tag}`;
}

/** The notes, then `Source:` and one line per pushed image. */
export function releaseBody(notes, fullSha, image, portalImage) {
  const imageLine = image ? `Image: ${image}\n` : "";
  const portalLine = portalImage ? `Portal image: ${portalImage}\n` : "";
  return `${notes.trimEnd()}\n\nSource: ${SOURCE_REPO_NAME}@${fullSha}\n${imageLine}${portalLine}`;
}

// ---------- the bundle ----------

/**
 * The released stack: the same five services as webapp-deploy/compose.yml with the hardening kept in step
 * (scripts/pilot-deploy.test.mjs compares them), images pinned to the release tag and nothing built on the
 * server. The comments live in the source file; this one is generated.
 */
export function composeFile(tag) {
  return `# Nultron Enterprise ${tag}. Run it with DEPLOY.md. Generated per release; do not edit here.
# One of each service, on purpose: the app's and the portal's limiters and refresh lock live in
# process memory, so a second replica of either would double every ceiling.
name: nultron-ent

services:
  app:
    image: ${imageRef(tag)}
    # .env is the APP's. The portal's secrets are in portal.env, which only the portal side loads.
    env_file:
      - path: .env
        required: true
    environment:
      NODE_ENV: production
      PORT: "3000"
      AGENTFORGE_SERVER: "1"
      AGENTFORGE_DATA_DIR: /data
      AGENTFORGE_COMPONENTS_DIR: /opt/agentforge/components
      TMPDIR: /tmp
      XDG_CACHE_HOME: /tmp/.cache
      NPM_CONFIG_CACHE: /tmp/.npm
      AGENTFORGE_SECRETS_KEY: \${AGENTFORGE_SECRETS_KEY:-}
    # The app reaches the portal over https, through the proxy that shares this network namespace: the
    # portal's public name resolves to this container's own loopback, where the proxy listens on 443.
    extra_hosts:
      - "\${PORTAL_DOMAIN:?set it in .env}:127.0.0.1"
    read_only: true
    tmpfs:
      - /tmp:mode=1777,size=512m,nosuid,nodev,noexec
    volumes:
      - nultron-data:/data
      - nultron-components:/opt/agentforge/components
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    init: true
    pids_limit: 512
    mem_limit: 6g
    mem_reservation: 1g
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
    # The app binds loopback; the proxy shares this network namespace, so the ports live here. The
    # explicit 0.0.0.0 keeps Docker from also binding [::] on a box with a public IPv6 address.
    ports:
      - "0.0.0.0:80:80"
      - "0.0.0.0:443:443"
      - "0.0.0.0:443:443/udp"
    restart: unless-stopped

  proxy:
    image: ${PROXY_IMAGE}
    network_mode: "service:app"
    depends_on:
      - app
    # The Caddyfile reads these two names and nothing else, so the secrets in .env stay with the app.
    environment:
      NULTRON_DOMAIN: \${NULTRON_DOMAIN:?set it in .env}
      PORTAL_DOMAIN: \${PORTAL_DOMAIN:?set it in .env}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    read_only: true
    tmpfs:
      - /tmp:mode=1777,size=64m,nosuid,nodev,noexec
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
    init: true
    pids_limit: 128
    mem_limit: 512m
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
    restart: unless-stopped

  portal-db:
    image: ${DATABASE_IMAGE}
    user: "999:999"
    env_file:
      - path: portal.env
        required: true
    environment:
      POSTGRES_USER: portal
      POSTGRES_DB: tokotoken_portal
      POSTGRES_INITDB_ARGS: "--encoding=UTF8 --locale=C"
      PGDATA: /var/lib/postgresql/data/pgdata
    entrypoint:
      - sh
      - -c
      - exec env -u PORTAL_SIGNING_KEY -u PORTAL_SMTP_USER -u PORTAL_SMTP_PASS -u PORTAL_APP_DB_PASSWORD POSTGRES_PASSWORD="$$PORTAL_POSTGRES_PASSWORD" docker-entrypoint.sh postgres
    volumes:
      - portal-pgdata:/var/lib/postgresql/data
    read_only: true
    tmpfs:
      - /var/run/postgresql:mode=0755,uid=999,gid=999
      - /tmp:mode=1777,size=128m,nosuid,nodev,noexec
    networks:
      - portal-db
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U portal -d tokotoken_portal"]
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 20s
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    init: true
    pids_limit: 200
    mem_limit: 1g
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
    restart: unless-stopped

  portal-prepare:
    image: ${portalImageRef(tag)}
    env_file:
      - path: portal.env
        required: true
    environment:
      NODE_ENV: production
      PORTAL_DATA_DIR: /portal-data
      PORTAL_PUBLIC_URL: https://\${PORTAL_DOMAIN:?set it in .env}
      PORTAL_TRUST_PROXY: "1"
      TMPDIR: /tmp
      XDG_CACHE_HOME: /tmp/.cache
    entrypoint:
      - sh
      - /app/webapp-deploy/portal-entry.sh
    command:
      - node
      - /app/webapp-deploy/k8s/base/scripts/prepare-db.mjs
    read_only: true
    tmpfs:
      - /tmp:mode=1777,size=128m,nosuid,nodev,noexec
      - /portal-data:mode=0700,size=16m,uid=1000,gid=1000
    networks:
      - portal-db
    depends_on:
      portal-db:
        condition: service_healthy
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    init: true
    pids_limit: 128
    mem_limit: 768m
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
    restart: "no"

  portal:
    image: ${portalImageRef(tag)}
    env_file:
      - path: portal.env
        required: true
    environment:
      NODE_ENV: production
      PORTAL_HOST: 0.0.0.0
      PORTAL_PORT: "4000"
      PORTAL_DATA_DIR: /portal-data
      PORTAL_PUBLIC_URL: https://\${PORTAL_DOMAIN:?set it in .env}
      PORTAL_TRUST_PROXY: "1"
      TMPDIR: /tmp
      XDG_CACHE_HOME: /tmp/.cache
    entrypoint:
      - sh
      - /app/webapp-deploy/portal-entry.sh
    command:
      - ./node_modules/.bin/tsx
      - src/main.ts
    depends_on:
      portal-prepare:
        condition: service_completed_successfully
    read_only: true
    tmpfs:
      - /tmp:mode=1777,size=128m,nosuid,nodev,noexec
      - /portal-data:mode=0700,size=16m,uid=1000,gid=1000
    networks:
      - default
      - portal-db
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "fetch('http://127.0.0.1:'+(process.env.PORTAL_PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 60s
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    init: true
    pids_limit: 256
    mem_limit: 768m
    mem_reservation: 128m
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
    restart: unless-stopped

networks:
  portal-db:
    internal: true

volumes:
  nultron-data:
  nultron-components:
  caddy-data:
  caddy-config:
  portal-pgdata:
`;
}

/** An env template: a comment line, then NAME= with its default or an empty value. */
function envTemplate(header, entries) {
  const body = entries.map(([name, comment]) => `# ${comment}\n${name}=${ENV_DEFAULTS[name] ?? ""}`).join("\n");
  return `${header}\n\n${body}\n`;
}

export function envExample() {
  return envTemplate(
    `# Nultron Enterprise: the APP's environment. Every variable the hosted app refuses to start without.
# Copy to .env next to compose.yml and fill each one in. Never commit .env, and never put a real secret
# in this file. The portal's secrets are in portal.env, which the app never loads.`,
    [
      ["NULTRON_DOMAIN", "Public hostname of the app. The proxy serves it and obtains its TLS certificate."],
      [
        "PORTAL_DOMAIN",
        "Public hostname of the portal, where people sign in: a second DNS record for this server. The host of AGENTFORGE_PORTAL_URL.",
      ],
      ["AGENTFORGE_SECRETS_KEY", "32-byte hex wrap key for stored secrets (openssl rand -hex 32). Generate once and keep it."],
      [
        "AGENTFORGE_TRUSTED_ORIGINS",
        "The app's public origin with its scheme, https://<NULTRON_DOMAIN>. Comma-separated for more than one.",
      ],
      [
        "AGENTFORGE_PORTAL_URL",
        "The portal's bare https origin, https://<PORTAL_DOMAIN>, with no path. The app reaches it through the proxy.",
      ],
      [
        "AGENTFORGE_PORTAL_CLIENT_ID",
        "This app's OAuth client at the portal (<tenant>-web). The first start is portal-only: see DEPLOY.md.",
      ],
      [
        "AGENTFORGE_PORTAL_CLIENT_SECRET",
        "Printed once by the portal's seed (DEPLOY.md). Put it here, then start the app.",
      ],
      [
        "AGENTFORGE_BILLING_WEBHOOK_SECRET",
        "Required to boot, and given to nobody: the proxy answers 404 on the billing webhook until a payment provider is bound (openssl rand -hex 32).",
      ],
    ],
  );
}

export function portalEnvExample() {
  return envTemplate(
    `# Nultron Enterprise: the PORTAL side's environment. Loaded only by the portal, its prepare step and its
# database, never by the app or the proxy. Copy to portal.env next to compose.yml and fill each one in.
# Never commit portal.env. Passwords must be URL-safe (openssl rand -hex 24).`,
    [
      [
        "PORTAL_SIGNING_KEY",
        "Ed25519 seed that signs access tokens, 64 hex characters (openssl rand -hex 32). Rotating it signs everyone out.",
      ],
      ["PORTAL_POSTGRES_PASSWORD", "Schema owner's password for the portal database. Read by initdb once, on an empty volume."],
      ["PORTAL_APP_DB_PASSWORD", "Password of portal_app_login, the role the portal serves as. Not the same value."],
      ["PORTAL_SMTP_HOST", "Tencent Cloud SES, International site. smtp.qcloudmail.com is the Hong Kong (China site) host."],
      ["PORTAL_SMTP_PORT", "465, implicit TLS. SES documents no other SMTP port."],
      ["PORTAL_SMTP_SECURE", "1 = TLS from the first byte, which is what port 465 speaks."],
      ["PORTAL_SMTP_USER", "The verified SES sender address, in full."],
      ["PORTAL_SMTP_PASS", "The SMTP password set for that sender address in the SES console."],
      ["PORTAL_SMTP_FROM", "The From header, e.g. Nultron <no-reply@mail.example.com>. Its address must be the verified sender."],
    ],
  );
}

export function deployDoc(tag) {
  return `# Deploy Nultron Enterprise ${tag}

This folder runs one release of the hosted app on one server: the app image \`${imageRef(tag)}\`, the portal
image \`${portalImageRef(tag)}\` (where people sign in) with its own Postgres, and a Caddy proxy in front of
both. Nothing is built on the server. One of each service: do not scale any of them.

1. \`docker login ghcr.io\` with a GitHub token that can read packages. Both images are private.
2. \`cp .env.example .env\` and \`cp portal.env.example portal.env\`, fill in every name in both, and keep both
   off git (\`chmod 600\`). Generate \`AGENTFORGE_SECRETS_KEY\` and \`PORTAL_SIGNING_KEY\` once and keep them: a
   new wrap key cannot read the old data, and a new signing key signs everyone out.
3. Point two DNS A records, \`NULTRON_DOMAIN\` and \`PORTAL_DOMAIN\`, at this server (no AAAA record) and open
   TCP 80 and 443 and UDP 443, inbound, IPv4 only.
4. Start the portal first, because the app will not boot without the client secret it prints:
   \`docker compose pull && docker compose up -d portal\` (this starts its database and migrations too).
5. Seed the first tenant and user. The secret is shown once:
   \`docker compose exec -T portal sh /app/webapp-deploy/portal-entry.sh ./node_modules/.bin/tsx scripts/seed.ts --email <you> --redirect https://<NULTRON_DOMAIN>/auth/callback\`
   Put the client secret it prints in \`.env\` as \`AGENTFORGE_PORTAL_CLIENT_SECRET\`.
6. \`docker compose up -d\`, then \`docker compose ps\` until \`app\` and \`portal\` are \`healthy\`, and open
   \`https://<NULTRON_DOMAIN>\`.

Back up the \`nultron-data\` and \`portal-pgdata\` volumes before an upgrade: the databases migrate forward only. To
roll back, check out the previous release tag of this repo and repeat steps 6 onward.
`;
}

/** webapp-deploy/Caddyfile at <sha>, with its comment lines dropped (they cite source paths). */
export function caddyfileFrom(source, tag) {
  const directives = source
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return `# Nultron Enterprise ${tag}. Generated per release; do not edit here.\n${directives}\n`;
}

export function renderBundle(tag, caddySource) {
  return {
    "compose.yml": composeFile(tag),
    ".env.example": envExample(),
    "portal.env.example": portalEnvExample(),
    "DEPLOY.md": deployDoc(tag),
    Caddyfile: caddyfileFrom(caddySource, tag),
  };
}

// ---------- arguments ----------

export function ghReleaseArgs(tag, notesFile, flags) {
  return [
    "release",
    "create",
    tag,
    "--repo",
    RELEASE_REPO,
    "--title",
    tag,
    "--notes-file",
    notesFile,
    ...(flags.draft ? ["--draft"] : []),
  ];
}

/** The app image, then the portal image: each is built from the same extracted archive, at its own Dockerfile. */
export function dockerArgs(image, portalImage) {
  return {
    build: ["build", "-f", "webapp-deploy/Dockerfile", "-t", image, "."],
    push: ["push", image],
    portalBuild: ["build", "-f", "webapp-deploy/portal.Dockerfile", "-t", portalImage, "."],
    portalPush: ["push", portalImage],
  };
}

export function parseArgs(argv) {
  const defaults = { tag: null, sha: null, dryRun: false, draft: false, allowDirty: false, skipImage: false };
  const valueFlags = { "--tag": "tag", "--sha": "sha" };
  const boolFlags = {
    "--dry-run": "dryRun",
    "--draft": "draft",
    "--allow-dirty": "allowDirty",
    "--skip-image": "skipImage",
  };
  const pairs = argv.flatMap((arg, i) => {
    if (boolFlags[arg]) return [[boolFlags[arg], true]];
    if (valueFlags[arg]) {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) fail(`${arg} needs a value`);
      return [[valueFlags[arg], argv[i + 1]]];
    }
    if (argv[i - 1] in valueFlags) return [];
    return fail(`unknown argument ${arg}`);
  });
  const flags = { ...defaults, ...Object.fromEntries(pairs) };
  if (!flags.tag) fail("--tag is required (ent-YYYY.MM.DD)");
  if (!flags.sha) fail("--sha is required (the agentforge commit that is deployed)");
  return flags;
}

// ---------- side effects, all through deps ----------

function ghBin() {
  return process.platform === "win32" ? "gh.exe" : "gh";
}

/** Windows' own bsdtar: Git Bash's GNU tar reads `C:\...` as a remote host. */
function tarBin() {
  return process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
}

const defaultDeps = {
  repoRoot: defaultRepoRoot,
  git: (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" }),
  docker: (args, cwd) => spawnSync("docker", args, { cwd, stdio: "inherit" }),
  tar: (args, cwd) => spawnSync(tarBin(), args, { cwd, encoding: "utf8" }),
  gh: (args, cwd) => spawnSync(ghBin(), args, { cwd, stdio: "inherit" }),
  ghView: (tag) =>
    spawnSync(ghBin(), ["release", "view", tag, "--repo", RELEASE_REPO, "--json", "tagName"], { encoding: "utf8" }),
  log: (line) => console.log(`web-release: ${line}`),
};

function expectOk(result, what) {
  if (result.error) fail(`could not start ${what}: ${result.error.message}`);
  if (result.status !== 0) fail(`${what} exited ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  return result;
}

function checkGitClean(flags, deps) {
  const status = deps.git(["status", "--porcelain"], deps.repoRoot);
  if (status.status !== 0) fail("git status failed");
  const dirty = status.stdout.trim().length > 0;
  if (dirty && !flags.allowDirty) fail("working tree is dirty (use --allow-dirty)");
  deps.log(`ok - ${dirty ? "dirty tree allowed (the image and bundle still come from <sha>)" : "working tree clean"}`);
}

function resolveSha(sha, deps) {
  if (!SHA_PATTERN.test(sha)) fail(`--sha "${sha}" is not a hex commit id`);
  const parsed = deps.git(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], deps.repoRoot);
  const full = parsed.status === 0 ? parsed.stdout.trim() : "";
  if (!/^[0-9a-f]{40}$/.test(full)) fail(`commit ${sha} does not exist in this repo`);
  deps.log(`ok - commit ${full}`);
  return full;
}

function readNotes(tag, deps) {
  const file = join(deps.repoRoot, "docs", "public", `${tag}-notes.md`);
  if (!existsSync(file)) fail(`notes file not found: docs/public/${tag}-notes.md`);
  const notes = readFileSync(file, "utf8");
  if (notes.trim().length === 0) fail(`notes file is empty: docs/public/${tag}-notes.md`);
  const marks = forbiddenMarksIn(notes);
  if (marks.length > 0) {
    fail(`refusing docs/public/${tag}-notes.md: it contains ${marks.map((m) => `"${m}"`).join(", ")}`);
  }
  deps.log(`ok - notes docs/public/${tag}-notes.md`);
  return notes;
}

function readCaddyfile(fullSha, deps) {
  const shown = deps.git(["show", `${fullSha}:webapp-deploy/Caddyfile`], deps.repoRoot);
  if (shown.status !== 0 || !shown.stdout?.trim()) fail(`webapp-deploy/Caddyfile not found at ${fullSha}`);
  return shown.stdout;
}

/**
 * What the two images are built from. A release is cut from a sha, so a sha that predates one of these
 * files would fail halfway through `docker build` (after the app image had been built); this fails first.
 */
export const REQUIRED_SOURCE_FILES = [
  "webapp-deploy/Dockerfile",
  "webapp-deploy/portal.Dockerfile",
  "webapp-deploy/portal.Dockerfile.dockerignore",
  "webapp-deploy/portal-entry.sh",
  "webapp-deploy/k8s/base/scripts/prepare-db.mjs",
];

function checkSourceFiles(fullSha, deps) {
  const missing = REQUIRED_SOURCE_FILES.filter(
    (path) => deps.git(["cat-file", "-e", `${fullSha}:${path}`], deps.repoRoot).status !== 0,
  );
  if (missing.length > 0) {
    fail(`commit ${fullSha} does not contain ${missing.join(", ")}: the images cannot be built from it (commit them first)`);
  }
  deps.log("ok - the sha carries both Dockerfiles and the portal's scripts");
}

function buildAndPushImages(fullSha, image, portalImage, workDir, deps) {
  const contextTar = join(workDir, "context.tar");
  const contextDir = join(workDir, "context");
  expectOk(
    deps.git(["-c", "core.autocrlf=false", "archive", "--format=tar", "--output", contextTar, fullSha], deps.repoRoot),
    "git archive",
  );
  mkdirSync(contextDir);
  expectOk(deps.tar(["-xf", contextTar, "-C", contextDir], workDir), "tar");
  deps.log(`ok - build context = git archive ${fullSha}`);
  const args = dockerArgs(image, portalImage);
  // Both images are built before either is pushed: a failed portal build must not leave an app image on
  // the registry with no portal image of the same tag beside it.
  expectOk(deps.docker(args.build, contextDir), "docker build (app)");
  expectOk(deps.docker(args.portalBuild, contextDir), "docker build (portal)");
  expectOk(deps.docker(args.push, contextDir), "docker push (app)");
  expectOk(deps.docker(args.portalPush, contextDir), "docker push (portal)");
  deps.log(`ok - pushed ${image} and ${portalImage}`);
}

function gitIdentity(deps) {
  const read = (key) => deps.git(["config", key], deps.repoRoot).stdout?.trim() ?? "";
  const name = read("user.name");
  const email = read("user.email");
  if (!name || !email) fail("git user.name / user.email are not set for this repo");
  return ["-c", `user.name=${name}`, "-c", `user.email=${email}`];
}

function assertTreePublishable(cloneDir) {
  for (const entry of readdirSync(cloneDir, { recursive: true, withFileTypes: true })) {
    const rel = relative(cloneDir, join(entry.parentPath ?? entry.path, entry.name));
    if (!entry.isFile() || rel.split(sep)[0] === ".git") continue;
    assertPublishable(rel, readFileSync(join(cloneDir, rel), "utf8"));
  }
}

function pushBundle(tag, bundle, workDir, deps) {
  const cloneDir = join(workDir, "NultronEnt");
  if (resolve(cloneDir) === resolve(deps.repoRoot)) fail("refusing to push from the source repo");
  const identity = gitIdentity(deps);
  expectOk(
    deps.git(["clone", "--quiet", "--depth", "1", "--branch", "main", RELEASE_REPO_URL, cloneDir], workDir),
    "git clone",
  );
  for (const [name, content] of Object.entries(bundle)) writeFileSync(join(cloneDir, name), content, "utf8");
  assertTreePublishable(cloneDir);
  expectOk(deps.git(["add", "--", ...Object.keys(bundle)], cloneDir), "git add");
  const changed = expectOk(deps.git(["status", "--porcelain"], cloneDir), "git status").stdout.trim();
  if (!changed) {
    deps.log(`ok - bundle already matches ${RELEASE_REPO} main, nothing to commit`);
    return;
  }
  expectOk(deps.git([...identity, "commit", "--quiet", "-m", `Release ${tag}`], cloneDir), "git commit");
  expectOk(deps.git(["push", "--quiet", "origin", "HEAD:main"], cloneDir), "git push");
  deps.log(`ok - pushed bundle to ${RELEASE_REPO} main`);
}

function publish(args, tag, deps) {
  const run = deps.gh(args, deps.repoRoot);
  if (run.error) fail(`could not start gh: ${run.error.message}`);
  if (run.status !== 0) fail(`gh release create exited ${run.status}`);
  const view = deps.ghView(tag);
  if (view.status !== 0) fail(`release ${tag} not visible on ${RELEASE_REPO} after create`);
  deps.log(`ok - published ${tag} to ${RELEASE_REPO}`);
}

function quoteArgs(args) {
  return args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
}

function logPlan(flags, image, portalImage, ghArgs, bundle, deps) {
  const docker = dockerArgs(image, portalImage);
  if (flags.skipImage) {
    deps.log(`skip - images (--skip-image): ${image} and ${portalImage} must already be pushed`);
  } else {
    deps.log(`plan - git archive <sha> into a temp dir, then docker ${quoteArgs(docker.build)}`);
    deps.log(`plan - docker ${quoteArgs(docker.portalBuild)}`);
    deps.log(`plan - docker ${quoteArgs(docker.push)}`);
    deps.log(`plan - docker ${quoteArgs(docker.portalPush)}`);
  }
  deps.log(`plan - clone ${RELEASE_REPO} into a temp dir, write ${Object.keys(bundle).join(", ")}`);
  for (const [name, content] of Object.entries(bundle))
    deps.log(`       ${name} (${Buffer.byteLength(content)} bytes)`);
  deps.log(`plan - commit "Release ${flags.tag}" (no trailers), push main, delete the temp dir`);
  deps.log(`gh ${quoteArgs(ghArgs)}`);
}

/**
 * Returns what it ran (or would run). Throws ReleaseError on refusal. `deps` is injectable so the
 * tests can drive every path against a fake repo root, a fake git, docker, tar and gh.
 */
export function main(argv = process.argv.slice(2), overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const flags = parseArgs(argv);
  const problem = tagProblem(flags.tag);
  if (problem) fail(problem);
  const image = imageRef(flags.tag);
  const portalImage = portalImageRef(flags.tag);
  deps.log(`ok - target ${RELEASE_REPO} ${flags.tag}, images ${image} and ${portalImage}`);
  checkGitClean(flags, deps);
  const fullSha = resolveSha(flags.sha, deps);
  checkSourceFiles(fullSha, deps);
  const body = releaseBody(readNotes(flags.tag, deps), fullSha, image, portalImage);
  assertPublishable("the release body", body);
  const bundle = renderBundle(flags.tag, readCaddyfile(fullSha, deps));
  for (const [name, content] of Object.entries(bundle)) assertPublishable(name, content);
  deps.log(`ok - bundle has none of the banned marks`);
  const workDir = mkdtempSync(join(tmpdir(), "nultron-ent-release-"));
  try {
    const bodyFile = join(workDir, `${flags.tag}-body.md`);
    writeFileSync(bodyFile, body, "utf8");
    const args = ghReleaseArgs(flags.tag, bodyFile, flags);
    logPlan(flags, image, portalImage, args, bundle, deps);
    if (flags.dryRun) {
      deps.log(`dry run, nothing published. Body:\n${body}`);
      return { args, body, bundle, image, portalImage, workDir, published: false };
    }
    if (!flags.skipImage) buildAndPushImages(fullSha, image, portalImage, workDir, deps);
    pushBundle(flags.tag, bundle, workDir, deps);
    publish(args, flags.tag, deps);
    return { args, body, bundle, image, portalImage, workDir, published: true };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    if (!(error instanceof ReleaseError)) throw error;
    console.error(`web-release: ${error.message}`);
    process.exit(1);
  }
}
