/**
 * The offline gate that runs before any image is swapped on the hosted stack. webapp-deploy/scripts/deploy.sh
 * calls it; an operator can call it by hand before a deploy.
 *
 *   node scripts/deploy-preflight.mjs --env <app .env> [--portal-env <portal.env>] [--compose <compose.yml>]
 *
 * Exit 0 when nothing is wrong. Exit 1 with one plain sentence per problem when something is. Exit 2 for bad
 * arguments. It prints the NAMES of variables, never their values, so its output is safe to paste into a
 * deploy log (the rule in packages/host/src/hosted-env.ts, "Names, never values").
 *
 * WHAT IT CHECKS, AND WHERE EACH RULE COMES FROM
 *  - Presence. Every REQUIRED_ENV name (the app's .env) and REQUIRED_PORTAL_ENV name (portal.env) is non-empty.
 *    Both lists are imported from scripts/release-web.mjs, the file that writes .env.example and
 *    portal.env.example, so they cannot drift from the templates. AGENTFORGE_SECRETS_KEY is the one name that
 *    may come from the process environment instead: under USE_SSM=1 deploy.sh exports it and keeps it out of
 *    .env, and compose.yml interpolates it from the shell (`AGENTFORGE_SECRETS_KEY: ${AGENTFORGE_SECRETS_KEY:-}`).
 *    Every other name reaches the container through env_file only, so a shell value would not reach it.
 *  - Portal sign-in. PORTAL_SIGNIN_MODE is code or password, and unset or empty means code, as in
 *    apps/portal/src/config.ts readSignInMode. The PORTAL_SMTP_* names are required only in code mode
 *    (apps/portal/src/config.ts readSmtp; the note on REQUIRED_PORTAL_ENV).
 *  - https. AGENTFORGE_PORTAL_URL is an https origin with no path. Every AGENTFORGE_TRUSTED_ORIGINS entry is one
 *    too. Server mode drops cleartext entries without a word (packages/core/src/server-mode.ts parseOriginList),
 *    so an http entry is reported here rather than silently ignored.
 *  - Names that agree. NULTRON_DOMAIN and PORTAL_DOMAIN are bare host names. PORTAL_DOMAIN is the host of
 *    AGENTFORGE_PORTAL_URL, because the app reaches the portal through a loopback alias of that name
 *    (webapp-deploy/compose.yml, `extra_hosts`). NULTRON_DOMAIN is one of the trusted origins' hosts (the
 *    .env.example text, and the Host check described in webapp-deploy/Caddyfile).
 *  - Pinned images. Every `image:` line in the compose file names a tag other than `latest`, or a digest. An
 *    image of this release's registry must carry a release tag (tagProblem in release-web.mjs). `:local` is
 *    accepted: it is the tag deploy.sh builds from a checkout at a recorded sha.
 *  - `docker compose config -q` on the compose file, when docker is on PATH. Otherwise a note says it was not run.
 *
 * WHAT IT DOES NOT CHECK. The value of AGENTFORGE_SECRETS_KEY and the other secrets. The app's own boot guard
 * (packages/host/src/hosted-env.ts, assertHostedEnvComplete) judges those, and a second copy of its rules here
 * would give two answers to one question. A value the guard refuses makes the new container fail its health
 * check, and deploy.sh rolls back.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { IMAGE_REPO, PORTAL_IMAGE_REPO, REQUIRED_ENV, REQUIRED_PORTAL_ENV, tagProblem } from "./release-web.mjs";

/** The only name the deploy may take from the process environment (see the header). */
export const SHELL_SUPPLIED = Object.freeze(["AGENTFORGE_SECRETS_KEY"]);
/** The sign-in mode variable. It is optional in release-web.mjs (OPTIONAL_PORTAL_ENV), so it is named here once. */
const SIGN_IN_VAR = "PORTAL_SIGNIN_MODE";
const SIGN_IN_MODES = Object.freeze(["code", "password"]);
/** Required only when sign-in is by e-mailed code. Derived from the imported list, not copied from it. */
const SMTP_NAMES = REQUIRED_PORTAL_ENV.filter((name) => name.startsWith("PORTAL_SMTP_"));
const BARE_HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const USAGE = "usage: node scripts/deploy-preflight.mjs --env <file> [--portal-env <file>] [--compose <file>]";

export class UsageError extends Error {}

/**
 * Reads NAME=value lines the way compose reads an env file, without running anything: `export ` is allowed,
 * `#` lines are comments, one pair of quotes is stripped, an unquoted value loses a trailing ` # comment`,
 * CRLF is accepted, and a repeated name keeps its last value.
 */
export function parseEnvText(text) {
  const values = new Map();
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values.set(match[1], unquote(match[2]));
  }
  return values;
}

function unquote(value) {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value.replace(/\s+#.*$/, "").trim();
}

/** What a name is set to, the way the container will see it: the shell value first for SHELL_SUPPLIED names. */
function effectiveValue(fileValues, shellEnv, name) {
  if (SHELL_SUPPLIED.includes(name)) {
    const fromShell = (shellEnv[name] ?? "").trim();
    if (fromShell !== "") return fromShell;
  }
  return (fileValues.get(name) ?? "").trim();
}

function parseUrl(text) {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/** An https origin: scheme and host, with an optional lone trailing slash, and nothing else. */
function isHttpsOrigin(url) {
  return (
    url !== null &&
    url.protocol === "https:" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === ""
  );
}

function missingName(file, name) {
  if (SHELL_SUPPLIED.includes(name)) {
    return `${file}: ${name} is empty in .env and was not exported. Set it in .env, or let deploy.sh fetch it with USE_SSM=1. The stack needs it to start.`;
  }
  return `${file}: ${name} is missing or empty. The stack needs it to start.`;
}

/** The app's .env: presence, https, and the names that have to agree. Returns problem sentences. */
export function checkAppEnv(fileValues, shellEnv = {}) {
  const value = (name) => effectiveValue(fileValues, shellEnv, name);
  const problems = [];
  for (const name of REQUIRED_ENV) {
    if (value(name) === "") problems.push(missingName(".env", name));
  }

  const portalValue = value("AGENTFORGE_PORTAL_URL");
  const portalUrl = parseUrl(portalValue);
  if (portalValue !== "" && !isHttpsOrigin(portalUrl)) {
    problems.push(".env: AGENTFORGE_PORTAL_URL must be an https origin with no path (scheme and host only).");
  }

  const origins = value("AGENTFORGE_TRUSTED_ORIGINS")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const badOrigins = origins.filter((entry) => !isHttpsOrigin(parseUrl(entry)));
  if (badOrigins.length > 0) {
    problems.push(
      `.env: AGENTFORGE_TRUSTED_ORIGINS has ${badOrigins.length} ${badOrigins.length === 1 ? "entry" : "entries"} ` +
        "that is not an https origin with no path. Server mode drops those without a message, so fix them here.",
    );
  }

  const nultronDomain = value("NULTRON_DOMAIN").toLowerCase();
  const portalDomain = value("PORTAL_DOMAIN").toLowerCase();
  const originHosts = origins.map((entry) => parseUrl(entry)?.hostname.toLowerCase()).filter(Boolean);
  if (nultronDomain !== "" && !originHosts.includes(nultronDomain)) {
    problems.push(
      ".env: NULTRON_DOMAIN is not the host of any https origin in AGENTFORGE_TRUSTED_ORIGINS. Every write from the app's own name would be refused.",
    );
  }
  if (portalDomain !== "" && portalUrl && portalDomain !== portalUrl.hostname.toLowerCase()) {
    problems.push(
      ".env: PORTAL_DOMAIN must be the host of AGENTFORGE_PORTAL_URL. The app reaches the portal through a loopback alias of that name, so the two must match.",
    );
  }
  for (const name of ["NULTRON_DOMAIN", "PORTAL_DOMAIN"]) {
    const domain = value(name);
    if (domain !== "" && !BARE_HOST.test(domain)) {
      problems.push(`.env: ${name} must be a bare host name, with no scheme, path or port.`);
    }
  }
  return problems;
}

/** portal.env: presence, and the SMTP names only when sign-in is by e-mailed code. */
export function checkPortalEnv(fileValues, shellEnv = {}) {
  const value = (name) => effectiveValue(fileValues, shellEnv, name);
  const problems = [];
  const mode = value(SIGN_IN_VAR);
  if (mode !== "" && !SIGN_IN_MODES.includes(mode)) {
    problems.push(
      `portal.env: ${SIGN_IN_VAR} must be code or password. The portal refuses to start on any other value.`,
    );
  }
  const codeMode = mode === "" || mode === "code";
  for (const name of REQUIRED_PORTAL_ENV) {
    if (!codeMode && SMTP_NAMES.includes(name)) continue;
    if (value(name) !== "") continue;
    if (SMTP_NAMES.includes(name)) {
      problems.push(
        `portal.env: ${name} is missing or empty. It is needed because sign-in is by e-mailed code (${SIGN_IN_VAR} is unset or code).`,
      );
    } else {
      problems.push(missingName("portal.env", name));
    }
  }
  return problems;
}

/** Every `image:` line: a tag other than latest, or a digest. Release images carry a release tag. */
export function checkComposeImages(composeText) {
  const problems = [];
  for (const match of composeText.matchAll(/^[ \t]*image:[ \t]*["']?([^\s"'#]+)["']?/gm)) {
    const image = match[1];
    if (image.includes("${")) {
      problems.push(
        `compose file: image ${image} names a variable, so its tag cannot be checked before the swap. Write the tag out.`,
      );
      continue;
    }
    if (image.includes("@")) continue;
    const lastSlash = image.lastIndexOf("/");
    const colon = image.lastIndexOf(":");
    if (colon <= lastSlash) {
      problems.push(`compose file: image ${image} has no tag, so Docker would use latest. Give it a tag.`);
      continue;
    }
    const tag = image.slice(colon + 1);
    if (tag === "latest") {
      problems.push(`compose file: image ${image} uses the latest tag. Pin it to a release tag or a build tag.`);
      continue;
    }
    const release = image.slice(0, colon);
    if ((release === IMAGE_REPO || release === PORTAL_IMAGE_REPO) && tagProblem(tag)) {
      problems.push(
        `compose file: image ${image} is one of this release's images, and its tag is not an ent-YYYY.MM.DD release tag.`,
      );
    }
  }
  return problems;
}

function firstLine(text) {
  const line =
    (text ?? "")
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find((part) => part !== "") ?? "";
  return line.slice(0, 200);
}

/** The real docker, through spawnSync. Returns what checkComposeConfig needs and nothing else. */
export function runDocker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 120_000 });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stderr: result.stderr ?? "",
  };
}

/**
 * `docker compose config -q` on the file, with the same env file deploy.sh interpolates from. `run` is the
 * injected docker runner, so the tests can stand in for it.
 */
export function checkComposeConfig({ composePath, envPath, run = runDocker }) {
  if (!run(["compose", "version"]).ok) {
    return {
      problems: [],
      notes: [
        "docker compose is not available on this machine, so the compose file was not parsed here. deploy.sh runs `docker compose config` on the server before it switches anything.",
      ],
    };
  }
  const result = run(["compose", "-f", composePath, "--env-file", envPath, "config", "-q"]);
  if (result.ok) return { problems: [], notes: [] };
  const reason = firstLine(result.stderr) || `docker compose exited with status ${result.status}`;
  return { problems: [`compose file ${composePath}: docker compose could not read it (${reason}).`], notes: [] };
}

/**
 * Every check, in the order an operator would fix them. Pure apart from the injected docker runner. A null text
 * means that file was not given, and the checks for it are skipped.
 */
export function runPreflight({
  appEnvText,
  portalEnvText = null,
  composeText = null,
  envPath = ".env",
  composePath = null,
  shellEnv = {},
  run,
}) {
  const problems = checkAppEnv(parseEnvText(appEnvText), shellEnv);
  const notes = [];
  if (portalEnvText !== null) {
    problems.push(...checkPortalEnv(parseEnvText(portalEnvText), shellEnv));
  }
  if (composeText !== null) {
    problems.push(...checkComposeImages(composeText));
    if (composePath !== null) {
      const config = checkComposeConfig({ composePath, envPath, run });
      problems.push(...config.problems);
      notes.push(...config.notes);
    }
  }
  return { problems, notes };
}

/** `--env`, `--portal-env` and `--compose`, each with one value. Throws UsageError on anything else. */
export function parseArgs(argv) {
  const flagNames = new Map([
    ["--env", "env"],
    ["--portal-env", "portalEnv"],
    ["--compose", "compose"],
  ]);
  const flags = { env: null, portalEnv: null, compose: null };
  for (let index = 0; index < argv.length; index += 2) {
    const name = flagNames.get(argv[index]);
    if (!name || argv[index + 1] === undefined || argv[index + 1] === "") throw new UsageError(USAGE);
    flags[name] = argv[index + 1];
  }
  if (!flags.env) throw new UsageError(USAGE);
  return flags;
}

/**
 * Returns the file's text, or null after recording one problem sentence when it cannot be read. A file that
 * cannot be read is a failure, and the checks that need it are skipped rather than run on nothing.
 */
function readFileOrProblem(path, role, problems) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    problems.push(`${role}: ${path} cannot be read. Copy the template and fill it in first.`);
    return null;
  }
}

/** Returns the exit status. Prints every note and every problem; `deps` lets the tests read the output. */
export function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log ?? ((line) => console.log(line));
  const fail = deps.error ?? ((line) => console.error(line));
  let flags;
  try {
    flags = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    fail(error.message);
    return 2;
  }

  const problems = [];
  const appEnvText = readFileOrProblem(flags.env, ".env", problems);
  const portalEnvText = flags.portalEnv ? readFileOrProblem(flags.portalEnv, "portal.env", problems) : null;
  const composeText = flags.compose ? readFileOrProblem(flags.compose, "compose file", problems) : null;
  const checked =
    appEnvText === null
      ? { problems: [], notes: [] }
      : runPreflight({
          appEnvText,
          portalEnvText,
          composeText,
          envPath: flags.env,
          composePath: composeText === null ? null : flags.compose,
          shellEnv: { AGENTFORGE_SECRETS_KEY: process.env.AGENTFORGE_SECRETS_KEY },
          run: deps.run ?? runDocker,
        });

  for (const note of checked.notes) log(`note: ${note}`);
  problems.push(...checked.problems);
  if (problems.length === 0) {
    log("deploy preflight: ok. Nothing has been switched.");
    return 0;
  }
  fail(
    `deploy preflight failed with ${problems.length} ${problems.length === 1 ? "problem" : "problems"}. ` +
      "Nothing has been switched. Fix these and run again:",
  );
  for (const problem of problems) fail(`  - ${problem}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main();
}
