/**
 * Helpers for the local Kubernetes rehearsal (rehearse-local.mjs, teardown-local.mjs,
 * forward-local.mjs). HARNESS: nothing here ships in the image or the release bundle.
 *
 * Three jobs live here because each is a way to leak or mis-deploy something:
 *   1. the build snapshot  - only `git ls-files -co --exclude-standard` is ever copied into a Docker
 *      build context, so ignored files (.env, .webdev-data*, .master-key, apps/web/.env.local) can
 *      never reach an image layer (SR-49, half 2). Untracked files that LOOK like secrets abort the
 *      build even though git does not ignore them;
 *   2. the generated secrets - strong random values, written once to a gitignored env file and never
 *      rotated by a re-run (a changed wrap key cannot read the data it sealed);
 *   3. the throwaway CA - one root and two leaf certificates, so the app can reach the portal over
 *      https and the portal can reach Mailpit over STARTTLS under NODE_ENV=production.
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, posix, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const K8S_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(K8S_DIR, "..", "..");
export const LOCAL_OVERLAY_DIR = join(K8S_DIR, "overlays", "local");
export const SECRETS_FILE = join(LOCAL_OVERLAY_DIR, "secrets.env");
export const PKI_DIR = join(LOCAL_OVERLAY_DIR, "pki");
export const STATE_DIR = join(K8S_DIR, ".local");

export const CONTEXT = "docker-desktop";
export const NAMESPACE = "nultron";
export const APP_HOST = "nultron.localhost";
export const PORTAL_HOST = "portal.nultron.localhost";
export const LOCAL_PORT = 8443;
export const APP_ORIGIN = `https://${APP_HOST}:${LOCAL_PORT}`;
export const PORTAL_ORIGIN = `https://${PORTAL_HOST}:${LOCAL_PORT}`;

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------

/** spawnSync with a UTF-8 result, never through a shell. */
export function run(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null,
  };
}

/** kubectl pinned to the docker-desktop context, so a stray current-context can never be applied to. */
export function kubectl(args, options = {}) {
  return run("kubectl", ["--context", CONTEXT, ...args], options);
}

export function mustSucceed(result, what) {
  if (result.error) throw new Error(`${what}: could not start (${result.error.message})`);
  if (result.status !== 0) throw new Error(`${what} exited ${result.status}\n${result.stderr.trim() || result.stdout.trim()}`);
  return result;
}

// ---------------------------------------------------------------------------
// the build snapshot
// ---------------------------------------------------------------------------

/**
 * An UNTRACKED file with one of these names is refused outright. A tracked file with the same name is
 * not this script's business (the Dockerfile's own ignore list already drops the common ones); the
 * risk this guard exists for is the file git does not know about and does not ignore either.
 */
const SECRET_NAME_PATTERNS = [
  /^\.env$/i,
  /^\.env\.(?!example$)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.enc$/i,
  /^\.master-key$/i,
  /\.sqlite(-.*)?$/i,
  /^id_(rsa|ed25519|ecdsa)/i,
  /^secrets\.env$/i,
  /^review\.env$/i,
  /^\.npmrc$/i,
];
const SECRET_DIR_PATTERNS = [/(^|\/)\.webdev-data/, /(^|\/)\.nultron-review(\/|$)/, /(^|\/)pki(\/|$)/];

export function looksSecret(path) {
  const normalised = path.split(sep).join("/");
  const name = posix.basename(normalised);
  return SECRET_NAME_PATTERNS.some((pattern) => pattern.test(name)) || SECRET_DIR_PATTERNS.some((p) => p.test(normalised));
}

/** Paths git will let into the working snapshot: tracked plus untracked-and-not-ignored. */
export function snapshotFileList(repoRoot = REPO_ROOT) {
  const tracked = mustSucceed(run("git", ["ls-files", "-z"], { cwd: repoRoot }), "git ls-files").stdout;
  const others = mustSucceed(
    run("git", ["ls-files", "-z", "--others", "--exclude-standard"], { cwd: repoRoot }),
    "git ls-files --others",
  ).stdout;
  const split = (text) => text.split("\0").filter(Boolean);
  return { tracked: split(tracked), untracked: split(others) };
}

/** The refusal list: untracked files whose names say "secret". */
export function untrackedSecrets(list) {
  return list.untracked.filter(looksSecret);
}

/**
 * Copy the snapshot into `destDir`. A tracked file that is deleted in the working tree is skipped;
 * a symbolic link is skipped (a link could point outside the tree and drag in anything).
 */
export function copySnapshot(repoRoot, destDir, files) {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  const copied = [];
  const skipped = [];
  for (const relative of files) {
    const from = join(repoRoot, relative);
    if (!existsSync(from)) {
      skipped.push({ path: relative, why: "missing in the working tree" });
      continue;
    }
    if (lstatSync(from).isSymbolicLink()) {
      skipped.push({ path: relative, why: "symbolic link" });
      continue;
    }
    const to = join(destDir, relative);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied.push(relative);
  }
  return { copied, skipped };
}

/**
 * The portal image needs only the workspace manifests, the portal itself and the shared migrations
 * (docs/internal/portal/migrations, read by path at boot). Everything else stays out of its context.
 */
export function portalContextFiles(files) {
  return files.filter((path) => {
    const p = path.split(sep).join("/");
    return (
      ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"].includes(p) ||
      /^(apps|packages)\/[^/]+\/package\.json$/.test(p) ||
      p.startsWith("apps/portal/") ||
      p.startsWith("docs/internal/portal/migrations/") ||
      p === "webapp-deploy/portal.Dockerfile" ||
      p === "webapp-deploy/portal.Dockerfile.dockerignore" ||
      p === "webapp-deploy/portal-entry.sh" ||
      p === "webapp-deploy/k8s/base/scripts/prepare-db.mjs" ||
      p.startsWith("patches/")
    );
  });
}

export function gitShortSha(repoRoot = REPO_ROOT) {
  return mustSucceed(run("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot }), "git rev-parse").stdout.trim();
}

export function imageTag(shortSha) {
  return `local-${shortSha}-dirty`;
}

// ---------------------------------------------------------------------------
// generated secrets
// ---------------------------------------------------------------------------

/** The client secret is minted by the portal's seed and shown once; until then the app gets this. */
export const CLIENT_SECRET_PLACEHOLDER = "pending-seed-run-rehearse-local";

/** Every name the local overlay's Secret carries, with how a fresh value is made. */
export const SECRET_RECIPES = {
  AGENTFORGE_SECRETS_KEY: () => randomBytes(32).toString("hex"),
  AGENTFORGE_BILLING_WEBHOOK_SECRET: () => randomBytes(32).toString("hex"),
  AGENTFORGE_PORTAL_CLIENT_ID: () => "nultron-web",
  AGENTFORGE_PORTAL_CLIENT_SECRET: () => CLIENT_SECRET_PLACEHOLDER,
  PORTAL_SIGNING_KEY: () => randomBytes(32).toString("base64url"),
  PORTAL_POSTGRES_PASSWORD: () => randomBytes(24).toString("base64url"),
  PORTAL_APP_DB_PASSWORD: () => randomBytes(24).toString("base64url"),
  BACKUP_KEY: () => randomBytes(32).toString("base64url"),
};

export function parseEnvFile(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at < 1) continue;
    values[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return values;
}

export function formatEnvFile(values) {
  const header = [
    "# Nultron local Kubernetes rehearsal. Generated by webapp-deploy/k8s/rehearse-local.mjs.",
    "# Real secrets for a THROWAWAY cluster: never commit this file, never reuse these values anywhere.",
    "# Re-running the script keeps every value here; delete a line to have it generated again.",
    "# AGENTFORGE_PORTAL_CLIENT_SECRET is replaced by the portal seed's one-time output.",
    "",
  ];
  return `${[...header, ...Object.entries(values).map(([name, value]) => `${name}=${value}`)].join("\n")}\n`;
}

/**
 * Fill in what is missing and leave everything that is there alone. Returns the full map and the
 * names that were newly generated; writes nothing (the caller does, so this stays testable).
 */
export function completeSecrets(existing, recipes = SECRET_RECIPES) {
  const values = { ...existing };
  const generated = [];
  for (const [name, make] of Object.entries(recipes)) {
    if (values[name] === undefined || values[name] === "") {
      values[name] = make();
      generated.push(name);
    }
  }
  return { values, generated };
}

export function readSecrets(file = SECRETS_FILE) {
  return existsSync(file) ? parseEnvFile(readFileSync(file, "utf8")) : {};
}

export function writeSecrets(values, file = SECRETS_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, formatEnvFile(values), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows has no mode bits; the file is gitignored and under the owner's profile.
  }
}

// ---------------------------------------------------------------------------
// the throwaway CA
// ---------------------------------------------------------------------------

const GIT_FOR_WINDOWS_OPENSSL = [
  "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
  "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
];

export function findOpenssl() {
  const onPath = run("openssl", ["version"]);
  if (onPath.status === 0) return "openssl";
  const found = GIT_FOR_WINDOWS_OPENSSL.find((candidate) => existsSync(candidate));
  if (found) return found;
  throw new Error("openssl was not found on PATH or in Git for Windows. Install Git for Windows or put openssl on PATH.");
}

/** SANs for each leaf. The edge leaf serves both browser-facing names; the mail leaf serves STARTTLS. */
export const LEAVES = {
  edge: {
    commonName: APP_HOST,
    sans: [APP_HOST, PORTAL_HOST],
  },
  mailpit: {
    commonName: "mailpit",
    sans: ["mailpit", `mailpit.${NAMESPACE}`, `mailpit.${NAMESPACE}.svc`, `mailpit.${NAMESPACE}.svc.cluster.local`],
  },
};

export function leafExtensions(sans) {
  return [
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature",
    "extendedKeyUsage=serverAuth",
    `subjectAltName=${sans.map((name) => `DNS:${name}`).join(",")}`,
    "",
  ].join("\n");
}

/** Creates pki/ (CA + two leaves) unless every file is already there. Returns true when it wrote. */
export function ensurePki(dir = PKI_DIR) {
  const needed = ["ca.crt", "ca.key", "edge.crt", "edge.key", "mailpit.crt", "mailpit.key"];
  if (needed.every((name) => existsSync(join(dir, name)))) return false;
  const openssl = findOpenssl();
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const at = (name) => join(dir, name);
  const ssl = (args, what) => mustSucceed(run(openssl, args, { cwd: dir }), `openssl ${what}`);

  ssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", at("ca.key")], "ca key");
  ssl(
    [
      "req", "-x509", "-new", "-key", at("ca.key"), "-sha256", "-days", "825",
      "-subj", "/CN=Nultron local rehearsal CA",
      "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign",
      "-out", at("ca.crt"),
    ],
    "ca certificate",
  );
  for (const [name, leaf] of Object.entries(LEAVES)) {
    writeFileSync(at(`${name}.ext`), leafExtensions(leaf.sans));
    ssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", at(`${name}.key`)], `${name} key`);
    ssl(["req", "-new", "-key", at(`${name}.key`), "-subj", `/CN=${leaf.commonName}`, "-out", at(`${name}.csr`)], `${name} csr`);
    ssl(
      [
        "x509", "-req", "-in", at(`${name}.csr`), "-CA", at("ca.crt"), "-CAkey", at("ca.key"),
        "-CAcreateserial", "-days", "365", "-sha256", "-extfile", at(`${name}.ext`), "-out", at(`${name}.crt`),
      ],
      `${name} certificate`,
    );
    rmSync(at(`${name}.csr`), { force: true });
    rmSync(at(`${name}.ext`), { force: true });
  }
  rmSync(at("ca.srl"), { force: true });
  return true;
}

// ---------------------------------------------------------------------------
// the generated overlay (gitignored): the local overlay plus the image tags of THIS build
// ---------------------------------------------------------------------------

export function generatedKustomization({ appImage, portalImage }) {
  const split = (ref) => {
    const at = ref.lastIndexOf(":");
    return { name: ref.slice(0, at), tag: ref.slice(at + 1) };
  };
  const app = split(appImage);
  const portal = split(portalImage);
  return [
    "# Generated by rehearse-local.mjs. Gitignored. Pins the two local image tags of this build.",
    "apiVersion: kustomize.config.k8s.io/v1beta1",
    "kind: Kustomization",
    "namespace: nultron",
    "resources:",
    "  - ../../overlays/local",
    "images:",
    `  - name: nultron-ent`,
    `    newName: ${app.name}`,
    `    newTag: ${app.tag}`,
    `  - name: nultron-portal`,
    `    newName: ${portal.name}`,
    `    newTag: ${portal.tag}`,
    "",
  ].join("\n");
}

export function writeGeneratedOverlay(refs) {
  const dir = join(STATE_DIR, "overlay");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "kustomization.yaml"), generatedKustomization(refs));
  return dir;
}

export const nameOf = (path) => basename(path);
