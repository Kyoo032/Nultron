/**
 * The company sites in the Enterprise release bundle (scripts/release-web.mjs): the folder
 * webapp-deploy/sites/ at the released sha, read through git and mapped to `sites/...` in the bundle.
 *
 * What is in it: the proxy's switch script (enable-sites.sh), one Caddy file per site, and each site's
 * placeholder web root. They are what compose.yml mounts into the proxy, so a bundle without them would not
 * start (the proxy's entrypoint is the switch script).
 *
 * The bundle is text. It is read with `git show` as UTF-8 and written back as UTF-8, which would silently corrupt
 * an image or a font, so a file whose extension is not in the allowlist below stops the release with a message
 * instead. A real site's files do not belong in the bundle anyway: they are served from DPS_WEB_ROOT /
 * TOKOTOKEN_WEB_ROOT, a folder outside the bundle that a release never overwrites.
 */

/** Where the sites live in the source repo, and under what name the bundle carries them. */
export const SITES_SOURCE_DIR = "webapp-deploy/sites";
export const SITES_BUNDLE_DIR = "sites";

/** The files compose.yml and the Caddyfile cannot work without; a sha that lacks one cannot be released. */
export const REQUIRED_SITE_FILES = Object.freeze([
  "webapp-deploy/sites/enable-sites.sh",
  "webapp-deploy/sites/dpscloud.caddy",
  "webapp-deploy/sites/tokotoken.caddy",
  "webapp-deploy/sites/dpscloud/index.html",
  "webapp-deploy/sites/tokotoken/index.html",
]);

/** Text types a placeholder site (or a small real one) is made of. */
export const SITE_TEXT_EXTENSIONS = Object.freeze([".caddy", ".sh", ".html", ".css", ".txt", ".svg", ".json", ".webmanifest", ".xml"]);

/** A page bigger than this belongs in DPS_WEB_ROOT, not in a bundle that spawnSync reads through a 1 MB pipe. */
export const SITE_FILE_MAX_BYTES = 512 * 1024;

export class SitesError extends Error {}

/** The bundle path of a source path, or a reason it cannot be one. */
export function bundlePathFor(sourcePath) {
  const prefix = `${SITES_SOURCE_DIR}/`;
  if (!sourcePath.startsWith(prefix)) throw new SitesError(`${sourcePath} is not under ${SITES_SOURCE_DIR}/`);
  const rest = sourcePath.slice(prefix.length);
  if (!rest || rest.split("/").some((part) => part === "" || part === "." || part === ".." || part.includes("\\"))) {
    throw new SitesError(`${sourcePath} is not a plain path inside ${SITES_SOURCE_DIR}/`);
  }
  const dot = rest.lastIndexOf(".");
  const extension = dot > rest.lastIndexOf("/") ? rest.slice(dot).toLowerCase() : "";
  if (!SITE_TEXT_EXTENSIONS.includes(extension)) {
    throw new SitesError(
      `${sourcePath}: the bundle carries text files only (${SITE_TEXT_EXTENSIONS.join(" ")}); serve images and fonts from DPS_WEB_ROOT / TOKOTOKEN_WEB_ROOT instead`,
    );
  }
  return `${SITES_BUNDLE_DIR}/${rest}`;
}

/**
 * A Caddy site file as the bundle carries it: its comment lines dropped, as for the Caddyfile (they cite source
 * paths), under the same one-line header. Anything else is written as it is.
 */
export function siteFileForBundle(bundlePath, text, tag) {
  if (!bundlePath.endsWith(".caddy")) return text;
  const directives = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return `# Nultron Enterprise ${tag}. Generated per release; do not edit here.\n${directives}\n`;
}

/**
 * Every file of webapp-deploy/sites at <fullSha>, as { "sites/<path>": text }, sorted by path. `git` is
 * (args) => { status, stdout }, run in the source repo; `fail` throws the caller's error type.
 */
export function readSiteFiles(fullSha, tag, git, fail) {
  const listed = git(["ls-tree", "-r", "-z", "--name-only", fullSha, "--", SITES_SOURCE_DIR]);
  if (listed.status !== 0) fail(`git ls-tree ${SITES_SOURCE_DIR} failed at ${fullSha}`);
  const paths = (listed.stdout ?? "").split("\0").filter(Boolean).sort();
  const missing = REQUIRED_SITE_FILES.filter((path) => !paths.includes(path));
  if (missing.length > 0) fail(`commit ${fullSha} does not contain ${missing.join(", ")}: the bundle cannot start its proxy without them`);
  const files = {};
  for (const sourcePath of paths) {
    let bundlePath;
    try {
      bundlePath = bundlePathFor(sourcePath);
    } catch (error) {
      if (error instanceof SitesError) fail(error.message);
      throw error;
    }
    const shown = git(["show", `${fullSha}:${sourcePath}`]);
    if (shown.status !== 0 || typeof shown.stdout !== "string") fail(`could not read ${sourcePath} at ${fullSha}`);
    if (Buffer.byteLength(shown.stdout) > SITE_FILE_MAX_BYTES) {
      fail(`${sourcePath} is over ${SITE_FILE_MAX_BYTES} bytes; serve a large site from DPS_WEB_ROOT / TOKOTOKEN_WEB_ROOT, not from the bundle`);
    }
    files[bundlePath] = siteFileForBundle(bundlePath, shown.stdout.replace(/\r\n/g, "\n"), tag);
  }
  return files;
}
