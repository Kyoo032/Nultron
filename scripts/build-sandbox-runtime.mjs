#!/usr/bin/env node
/**
 * Build the code-sandbox runtime directory: the Pyodide (Python) and QuickJS (JavaScript) engines,
 * the five Python wheels, and the two child entry scripts, as real files in one folder.
 *
 *   node scripts/build-sandbox-runtime.mjs [--out <dir>] [--cache <dir>] [--no-pyc] [--offline]
 *                                          [--child-dir <dir>]
 *   node scripts/build-sandbox-runtime.mjs --verify [--out <dir>] [--if-present] [--child-dir <dir>]
 *   node scripts/build-sandbox-runtime.mjs --update-lock [--offline]
 *
 * `--verify` re-hashes the folder against its MANIFEST.json and, when the child sources exist (the repo's
 * packages/host/src/code-runner/child/, or --child-dir), also requires the built child scripts to equal them
 * byte for byte. Without that source dir (a packed app, the image's runtime stage) only the manifest is checked.
 * A folder whose manifest does not list THIRD_PARTY_NOTICES.txt (built before the notices existed) fails too.
 *
 * Output (default `vendor/sandbox-runtime/`, gitignored). This layout is the contract with the host's
 * code-runner (`packages/host/src/code-runner/`): the child process is started with
 * `--permission --allow-fs-read=<this dir>` and reads everything from here, never from node_modules.
 *
 *   MANIFEST.json                 sha256 + size of every other file here (schema 1)
 *   THIRD_PARTY_NOTICES.txt       every shipped component, its version, license name and full license text
 *   py-child.mjs, qjs-child.mjs   the sandboxed child entry points
 *   node_modules/ws/              a stub: pyodide.mjs imports `ws` unconditionally in Node
 *   node_modules/quickjs-emscripten-core, @jitl/quickjs-ffi-types, @jitl/quickjs-wasmfile-release-sync
 *   vendor/pyodide/               pyodide core, the wheels, a lockfile trimmed to them,
 *                                 pyc-cache.json.gz, and MANIFEST.json ({files:[{name,bytes,sha256}]})
 *
 * Everything that is not source in this repo is pinned in `scripts/sandbox-runtime.lock.json`
 * (version, URL, size, sha256). A file whose sha256 differs is refused, whether it came from
 * node_modules, from the download cache or from the network. Wheels are downloaded once into the
 * cache (`vendor/.sandbox-cache`, gitignored), so a rebuild with a warm cache never touches the
 * network (`--offline` enforces that). The build is deterministic: a second run writes the same
 * MANIFEST.json.
 *
 * The lock is a reviewed file. `--update-lock` rewrites it from the installed npm packages and the
 * pyodide lockfile after a version bump; the result is a diff to read, not something to trust.
 *
 * THIRD_PARTY_NOTICES.txt is built from the license files inside the pinned wheels and QuickJS packages and from
 * the two texts committed in `scripts/sandbox-licenses/` (Pyodide, CPython: neither npm package carries one);
 * the lock's `licenses` section names the license of each and pins those two texts. A component without a
 * license text fails the build (see `sandbox-licenses/notices.mjs`).
 *
 * The trimmed pyodide-lock.json is load-bearing. With the full lock, a package the guest asks for
 * that is not shipped is looked up on the CDN. With the trimmed one it is simply not there.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import {
  NOTICES_NAME,
  buildNoticesText,
  collectNoticeComponents,
  wheelMetadataLicense,
} from "./sandbox-licenses/notices.mjs";
import {
  PYODIDE_CORE_FILES,
  PYODIDE_DIR,
  PYODIDE_LOCK_SOURCE,
  PYODIDE_PRELOAD,
  QUICKJS_PACKAGES,
  byCodeUnit,
  checkLockAgainstPyodide,
  dependencyClosure,
  trimPyodideLock,
  validateLock,
} from "./sandbox-runtime-lock.mjs";

export * from "./sandbox-licenses/notices.mjs";
export * from "./sandbox-runtime-lock.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");
export const LOCK_PATH = path.join(HERE, "sandbox-runtime.lock.json");
export const DEFAULT_OUT = path.join(REPO_ROOT, "vendor", "sandbox-runtime");
export const DEFAULT_CACHE = path.join(REPO_ROOT, "vendor", ".sandbox-cache");
export const CHILD_SOURCE_DIR = path.join(REPO_ROOT, "packages", "host", "src", "code-runner", "child");
export const CHILD_SCRIPTS = ["py-child.mjs", "qjs-child.mjs"];
export const MANIFEST_NAME = "MANIFEST.json";
const PYC_NAME = "pyc-cache.json.gz";
/** Bump when the way the pyc cache is produced changes, so cached blobs from the old way are not reused. */
const PYC_GENERATOR = "pyc-v1";

const WS_STUB = [
  {
    file: "node_modules/ws/index.js",
    text:
      "// Stub for the `ws` package that pyodide.mjs imports unconditionally in Node. " +
      "Network sockets are not available to guest code.\n" +
      'class WebSocket { constructor() { throw new Error("network disabled in sandbox"); } }\n' +
      "module.exports = WebSocket;\n" +
      "module.exports.WebSocket = WebSocket;\n",
  },
  {
    file: "node_modules/ws/package.json",
    text: '{ "name": "ws", "version": "0.0.0-stub", "main": "index.js", "type": "commonjs" }\n',
  },
];

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------------------------

export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** Throws unless `data` hashes to `expected`; returns the hash. The message names what was refused. */
export function assertSha256(label, data, expected) {
  const actual = sha256Hex(data);
  if (actual !== expected) {
    throw new Error(`sha256 mismatch for ${label}: expected ${expected}, got ${actual}`);
  }
  return actual;
}

/**
 * Both manifests list files as `{name, bytes, sha256}` with posix names relative to the folder the manifest sits
 * in: that is what the host's `code-runner/ship.ts` and the Pyodide child read. Sorted, one entry per name.
 */
function sortedEntries(entries) {
  const files = entries
    .map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }))
    .sort((a, b) => byCodeUnit(a.name, b.name));
  for (let i = 1; i < files.length; i += 1) {
    if (files[i].name === files[i - 1].name) throw new Error(`duplicate manifest name: ${files[i].name}`);
  }
  return files;
}

/** The root manifest: schema 1, a few facts about what was built, and every other file in the folder. */
export function buildManifest(entries, meta) {
  return { schema: 1, ...meta, files: sortedEntries(entries) };
}

/** The `vendor/pyodide/MANIFEST.json` the Pyodide child verifies before it boots (no schema field). */
export function buildPyodideManifest(entries, meta) {
  return { ...meta, files: sortedEntries(entries) };
}

export function manifestText(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** The lock file's text: two-space JSON, with the short `preload` list on one line as the repo's formatter keeps it. */
export function lockText(lock) {
  const json = JSON.stringify(lock, null, 2);
  const inline = (_match, inner) =>
    `"preload": [${inner
      .split(",")
      .map((item) => item.trim())
      .join(", ")}]`;
  return `${json.replace(/"preload": \[([^\]]*)\]/, inline)}\n`;
}

/** What differs between a manifest and the files actually on disk. Empty means they agree. */
export function diffManifest(manifest, actualEntries) {
  const want = new Map(manifest.files.map((entry) => [entry.name, entry]));
  const have = new Map(actualEntries.map((entry) => [entry.name, entry]));
  const problems = [];
  for (const [rel, entry] of want) {
    const found = have.get(rel);
    if (!found) problems.push(`missing: ${rel}`);
    else if (found.bytes !== entry.bytes) problems.push(`size: ${rel} expected ${entry.bytes} got ${found.bytes}`);
    else if (found.sha256 !== entry.sha256) problems.push(`sha256: ${rel}`);
  }
  for (const rel of have.keys()) {
    if (!want.has(rel)) problems.push(`unlisted: ${rel}`);
  }
  return problems.sort(byCodeUnit);
}

export function parseArgs(argv) {
  const options = {
    out: process.env.SANDBOX_RUNTIME_OUT ?? DEFAULT_OUT,
    cache: process.env.SANDBOX_RUNTIME_CACHE ?? DEFAULT_CACHE,
    childDir: undefined,
    pyc: true,
    offline: false,
    verify: false,
    ifPresent: false,
    updateLock: false,
    help: false,
  };
  const value = (i, flag) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") options.out = path.resolve(value(i++, arg));
    else if (arg === "--cache") options.cache = path.resolve(value(i++, arg));
    else if (arg === "--child-dir") options.childDir = path.resolve(value(i++, arg));
    else if (arg === "--no-pyc") options.pyc = false;
    else if (arg === "--offline") options.offline = true;
    else if (arg === "--verify") options.verify = true;
    else if (arg === "--if-present") options.ifPresent = true;
    else if (arg === "--update-lock") options.updateLock = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return { ...options, out: path.resolve(options.out), cache: path.resolve(options.cache) };
}

// ---------------------------------------------------------------------------------------------
// File system helpers
// ---------------------------------------------------------------------------------------------

/** Every file under `dir` as a sorted posix relative path. A symlink or other non-file entry is refused. */
export function listFiles(dir) {
  const out = [];
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
      else throw new Error(`unexpected non-file entry in ${dir}: ${rel}`);
    }
  };
  walk(dir, "");
  return out.sort(byCodeUnit);
}

/** `{path, bytes, sha256}` for every file under `dir`, except the root manifest. */
export function hashTree(dir) {
  return listFiles(dir)
    .filter((rel) => rel !== MANIFEST_NAME)
    .map((rel) => {
      const data = readFileSync(path.join(dir, ...rel.split("/")));
      return { name: rel, bytes: data.length, sha256: sha256Hex(data) };
    });
}

/** Re-hash `dir` against its MANIFEST.json. `{ok, problems, files, bytes}`. */
export function verifyManifest(dir) {
  const manifestPath = path.join(dir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) return { ok: false, problems: [`missing: ${MANIFEST_NAME}`], files: 0, bytes: 0 };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return { ok: false, problems: [`unreadable: ${MANIFEST_NAME} (${error.message})`], files: 0, bytes: 0 };
  }
  if (manifest.schema !== 1 || !Array.isArray(manifest.files)) {
    return { ok: false, problems: [`unsupported: ${MANIFEST_NAME} is not a schema 1 manifest`], files: 0, bytes: 0 };
  }
  const actual = hashTree(dir);
  const problems = diffManifest(manifest, actual);
  return {
    ok: problems.length === 0,
    problems,
    files: actual.length,
    bytes: actual.reduce((sum, f) => sum + f.bytes, 0),
  };
}

/**
 * Child scripts in `builtDir` that no longer match their source in `sourceDir`. The build copies those bytes
 * unchanged, so the comparison is on exact bytes. The built MANIFEST hashes the built copies, so it cannot see
 * this drift: a source edited after the build leaves a folder that verifies but runs old code.
 * Empty when they agree, and also when `sourceDir` does not exist (a packed app and the image's runtime stage
 * ship the built folder without the repo, and `--verify` has to keep working there).
 */
export function diffChildScripts(builtDir, sourceDir = CHILD_SOURCE_DIR) {
  if (!existsSync(sourceDir)) return [];
  const problems = [];
  for (const name of CHILD_SCRIPTS) {
    const built = path.join(builtDir, name);
    const source = path.join(sourceDir, name);
    if (!existsSync(source)) problems.push(`source missing: ${name} (not in ${sourceDir})`);
    else if (existsSync(built) && !readFileSync(built).equals(readFileSync(source))) problems.push(`stale: ${name}`);
  }
  return problems;
}

function writeFileIn(root, rel, data) {
  const target = path.join(root, ...rel.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, data);
}

/** Reads `source`, refuses it unless it hashes to `expectedSha`, and writes it under `root` at `rel`. */
export function copyVerified(source, root, rel, expectedSha, label) {
  const data = readFileSync(source);
  assertSha256(label, data, expectedSha);
  writeFileIn(root, rel, data);
  return data.length;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadBytes(url, fetchImpl, attempts, retryDelayMs) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      last = error;
      if (attempt < attempts) await sleep(retryDelayMs * attempt);
    }
  }
  throw new Error(`download failed after ${attempts} attempts: ${url}: ${last?.message ?? last}`);
}

/**
 * The bytes of one pinned download, from the cache when the cache entry still hashes right, else from
 * the network. The hash is checked BEFORE anything is written to the cache, so a bad download never
 * becomes a cache entry. With `offline` a missing or corrupt entry is an error, never a fetch.
 */
export async function fetchPinned({
  cacheFile,
  url,
  sha256,
  bytes,
  label,
  offline,
  fetchImpl = fetch,
  attempts = 3,
  retryDelayMs = 500,
}) {
  let corrupt = false;
  if (existsSync(cacheFile)) {
    const cached = readFileSync(cacheFile);
    if ((bytes === undefined || cached.length === bytes) && sha256Hex(cached) === sha256) {
      return { data: cached, fromCache: true };
    }
    corrupt = true;
    rmSync(cacheFile, { force: true });
  }
  if (offline) {
    throw new Error(`--offline: ${label} is ${corrupt ? "corrupt" : "not"} in the cache (${cacheFile})`);
  }
  const data = await downloadBytes(url, fetchImpl, attempts, retryDelayMs);
  assertSha256(`${label} (${url})`, data, sha256);
  if (bytes !== undefined && data.length !== bytes) {
    throw new Error(`size mismatch for ${label}: expected ${bytes} bytes, got ${data.length}`);
  }
  mkdirSync(path.dirname(cacheFile), { recursive: true });
  const part = `${cacheFile}.part`;
  writeFileSync(part, data);
  renameSync(part, cacheFile);
  return { data, fromCache: false };
}

// ---------------------------------------------------------------------------------------------
// Locating the installed npm packages
// ---------------------------------------------------------------------------------------------

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function findPackageDir(name, nodeModulesDirs) {
  for (const nm of nodeModulesDirs) {
    const dir = path.join(nm, ...name.split("/"));
    if (existsSync(path.join(dir, "package.json"))) return realpathSync(dir);
  }
  return undefined;
}

/** The node_modules directory that holds the real directory of package `name` (pnpm keeps siblings there). */
function nodeModulesOf(realDir, name) {
  return path.resolve(realDir, ...name.split("/").map(() => ".."));
}

/** Real directories of pyodide and the three QuickJS packages, found from the repo root. */
export function locateInstalled(repoRoot = REPO_ROOT) {
  const rootModules = path.join(repoRoot, "node_modules");
  const pyodide = findPackageDir("pyodide", [rootModules]);
  if (!pyodide) throw new Error("pyodide is not installed: run `npx pnpm@9.15.9 install` at the repo root");
  const core = findPackageDir("quickjs-emscripten-core", [rootModules]);
  if (!core)
    throw new Error("quickjs-emscripten-core is not installed: run `npx pnpm@9.15.9 install` at the repo root");
  const search = [rootModules, nodeModulesOf(core, "quickjs-emscripten-core")];
  const quickjs = QUICKJS_PACKAGES.map(({ name }) => {
    const dir = findPackageDir(name, search);
    if (!dir) throw new Error(`${name} is not installed: run \`npx pnpm@9.15.9 install\` at the repo root`);
    return { name, dir, version: readJson(path.join(dir, "package.json")).version };
  });
  return { pyodide: { dir: pyodide, version: readJson(path.join(pyodide, "package.json")).version }, quickjs };
}

function pinnedFileList(pkgDir, include) {
  return listFiles(pkgDir).filter((rel) => include.some((pattern) => pattern.test(rel)));
}

function describeFile(root, rel) {
  const data = readFileSync(path.join(root, ...rel.split("/")));
  return { file: rel, bytes: data.length, sha256: sha256Hex(data) };
}

// ---------------------------------------------------------------------------------------------
// The .pyc cache
// ---------------------------------------------------------------------------------------------

function pycCacheKey(lock) {
  const parts = [PYC_GENERATOR, lock.pyodide.version, lock.pyodide.python, ...lock.pyodide.preload];
  for (const core of lock.pyodide.core) parts.push(`${core.file}:${core.sha256}`);
  for (const wheel of lock.pyodide.wheels) parts.push(`${wheel.file}:${wheel.sha256}`);
  return sha256Hex(parts.join("\n")).slice(0, 24);
}

/**
 * Compile numpy/pandas/... to unchecked-hash .pyc inside the shipped Pyodide, offline, and return the
 * gzipped `{path: base64}` map. The child writes these back next to the sources, which cuts the cold
 * `import pandas` from about 12 s to about 4 s. `fetch` is poisoned while Pyodide runs so a
 * broken lock trim fails here instead of reaching for the CDN.
 */
async function generatePycCache(pyodideDir, lock) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("network use while generating the .pyc cache");
  };
  try {
    const { loadPyodide } = await import(pathToFileURL(path.join(pyodideDir, "pyodide.mjs")).href);
    const pyodideLock = readJson(path.join(pyodideDir, PYODIDE_LOCK_SOURCE));
    const py = await loadPyodide({
      indexURL: pyodideDir + path.sep,
      packageCacheDir: pyodideDir,
      lockFileContents: pyodideLock,
      jsglobals: {},
      fullStdLib: false,
      stdout: () => {},
      stderr: () => {},
    });
    await py.loadPackage(lock.pyodide.preload, { messageCallback: () => {}, errorCallback: () => {} });
    const [major, minor] = lock.pyodide.python.split(".");
    const site = `/lib/python${major}.${minor}/site-packages`;
    await py.runPythonAsync(
      `import compileall, py_compile\ncompileall.compile_dir('${site}', quiet=2, force=True, invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)\n`,
    );
    const found = {};
    const walk = (dir) => {
      for (const name of py.FS.readdir(dir)) {
        if (name === "." || name === "..") continue;
        const full = `${dir}/${name}`;
        if (py.FS.isDir(py.FS.stat(full).mode)) walk(full);
        else if (full.endsWith(".pyc")) found[full] = Buffer.from(py.FS.readFile(full)).toString("base64");
      }
    };
    walk(site);
    const sorted = Object.fromEntries(Object.entries(found).sort(([a], [b]) => byCodeUnit(a, b)));
    if (Object.keys(sorted).length === 0) throw new Error("compileall produced no .pyc files");
    return gzipSync(Buffer.from(JSON.stringify(sorted)), { level: 9 });
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------

function loadLock() {
  return validateLock(readJson(LOCK_PATH));
}

function resolveChildDir(childDir) {
  const dir = childDir ?? CHILD_SOURCE_DIR;
  const missing = CHILD_SCRIPTS.filter((name) => !existsSync(path.join(dir, name)));
  if (missing.length > 0) {
    throw new Error(
      `child script(s) ${missing.join(", ")} not found in ${dir}. They are written with the code runner ` +
        "(packages/host/src/code-runner/child/); pass --child-dir <dir> to build against another copy.",
    );
  }
  return dir;
}

/** An existing output dir is only replaced when it is empty or an earlier build of this script. */
function assertReplaceable(out) {
  if (!existsSync(out)) return;
  if (!statSync(out).isDirectory()) throw new Error(`${out} exists and is not a directory`);
  if (readdirSync(out).length === 0) return;
  const manifest = path.join(out, MANIFEST_NAME);
  let ours = false;
  try {
    ours = readJson(manifest).schema === 1;
  } catch {
    ours = false;
  }
  if (!ours) throw new Error(`refusing to replace ${out}: it is not empty and has no sandbox-runtime ${MANIFEST_NAME}`);
}

function swapIntoPlace(tmp, out) {
  rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  renameSync(tmp, out);
}

function copyPinnedNpmFiles(lock, installed, root) {
  for (const pkg of lock.quickjs.packages) {
    const found = installed.quickjs.find((entry) => entry.name === pkg.name);
    if (found.version !== pkg.version) {
      throw new Error(`${pkg.name} ${found.version} is installed, the lock pins ${pkg.version}`);
    }
    for (const entry of pkg.files) {
      copyVerified(
        path.join(found.dir, ...entry.file.split("/")),
        root,
        `node_modules/${pkg.name}/${entry.file}`,
        entry.sha256,
        `${pkg.name}/${entry.file}`,
      );
    }
  }
  const py = lock.pyodide;
  if (installed.pyodide.version !== py.version) {
    throw new Error(`pyodide ${installed.pyodide.version} is installed, the lock pins ${py.version}`);
  }
  for (const entry of py.core) {
    copyVerified(
      path.join(installed.pyodide.dir, entry.file),
      root,
      `${PYODIDE_DIR}/${entry.file}`,
      entry.sha256,
      `pyodide/${entry.file}`,
    );
  }
}

async function copyWheels(lock, root, options, log) {
  let downloaded = 0;
  for (const wheel of lock.pyodide.wheels) {
    const { data, fromCache } = await fetchPinned({
      cacheFile: path.join(options.cache, "wheels", wheel.file),
      url: wheel.url,
      sha256: wheel.sha256,
      bytes: wheel.bytes,
      label: wheel.file,
      offline: options.offline,
      fetchImpl: options.fetchImpl,
    });
    if (!fromCache) downloaded += 1;
    writeFileIn(root, `${PYODIDE_DIR}/${wheel.file}`, data);
  }
  log(
    `wheels: ${lock.pyodide.wheels.length} (${downloaded} downloaded, ${lock.pyodide.wheels.length - downloaded} from cache)`,
  );
}

async function ensurePycCache(lock, pyodideDir, options, log) {
  const cacheFile = path.join(options.cache, "pyc", `${pycCacheKey(lock)}.json.gz`);
  if (existsSync(cacheFile)) {
    log(`pyc cache: reused ${path.relative(REPO_ROOT, cacheFile)}`);
    return readFileSync(cacheFile);
  }
  log("pyc cache: generating (boots Pyodide once, offline) ...");
  const started = Date.now();
  const gz = await generatePycCache(pyodideDir, lock);
  mkdirSync(path.dirname(cacheFile), { recursive: true });
  writeFileSync(`${cacheFile}.part`, gz);
  renameSync(`${cacheFile}.part`, cacheFile);
  log(`pyc cache: ${gz.length} bytes in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return gz;
}

/**
 * Writes THIRD_PARTY_NOTICES.txt at the root of the folder being built: Pyodide and CPython from the texts committed
 * in `licensesDir`, the wheels from the license files inside them, QuickJS from the LICENSE files already copied.
 * Throws, and so fails the build, when any component has no license text. Returns the components it listed.
 */
export function writeNotices(lock, root, licensesDir) {
  const components = collectNoticeComponents(lock, licensesDir ? { root, licensesDir } : { root });
  writeFileIn(root, NOTICES_NAME, buildNoticesText(components));
  return components;
}

/**
 * A problem string when the folder's root manifest does not list THIRD_PARTY_NOTICES.txt, else undefined. A folder
 * built before the notices were written verifies against its own manifest and would still ship without them.
 */
export function noticesProblem(dir) {
  let manifest;
  try {
    manifest = readJson(path.join(dir, MANIFEST_NAME));
  } catch {
    return undefined; // verifyManifest reports an unreadable manifest
  }
  const listed = manifest.files?.some((entry) => entry.name === NOTICES_NAME && entry.bytes > 0);
  return listed
    ? undefined
    : `missing: ${NOTICES_NAME} is not listed in ${MANIFEST_NAME} (the folder was built without third-party notices)`;
}

function sizeGroups(entries) {
  const groups = { pyodideCore: 0, wheels: 0, pycCache: 0, quickjs: 0, glue: 0 };
  for (const { name: rel, bytes } of entries) {
    if (rel.endsWith(".whl")) groups.wheels += bytes;
    else if (rel.includes(PYC_NAME)) groups.pycCache += bytes;
    else if (rel.startsWith(`${PYODIDE_DIR}/`)) groups.pyodideCore += bytes;
    else if (rel.startsWith("node_modules/@jitl/") || rel.startsWith("node_modules/quickjs-")) groups.quickjs += bytes;
    else groups.glue += bytes;
  }
  return groups;
}

const mib = (bytes) => `${(bytes / 1048576).toFixed(2)} MiB`;

export async function buildSandboxRuntime(options, log = console.log) {
  const lock = loadLock();
  const installed = locateInstalled();
  const childDir = resolveChildDir(options.childDir);
  const full = path.join(installed.pyodide.dir, PYODIDE_LOCK_SOURCE);
  assertSha256(`pyodide/${PYODIDE_LOCK_SOURCE}`, readFileSync(full), lock.pyodide.lockSource.sha256);
  checkLockAgainstPyodide(lock, readJson(full));
  assertReplaceable(options.out);

  const tmp = `${options.out}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    copyPinnedNpmFiles(lock, installed, tmp);
    await copyWheels(lock, tmp, options, log);
    const trimmed = trimPyodideLock(
      readJson(full),
      lock.pyodide.wheels.map((wheel) => wheel.file),
    );
    writeFileIn(tmp, `${PYODIDE_DIR}/${PYODIDE_LOCK_SOURCE}`, `${JSON.stringify(trimmed, null, 2)}\n`);
    for (const { file, text } of WS_STUB) writeFileIn(tmp, file, text);
    for (const name of CHILD_SCRIPTS) writeFileIn(tmp, name, readFileSync(path.join(childDir, name)));
    log(`child scripts: ${CHILD_SCRIPTS.join(", ")} from ${path.relative(REPO_ROOT, childDir) || "."}`);
    const components = writeNotices(lock, tmp, options.licensesDir);
    log(`notices: ${NOTICES_NAME}, ${components.length} components (${components.map((c) => c.name).join(", ")})`);

    const pyodideDir = path.join(tmp, ...PYODIDE_DIR.split("/"));
    if (options.pyc)
      writeFileIn(tmp, `${PYODIDE_DIR}/${PYC_NAME}`, await ensurePycCache(lock, pyodideDir, options, log));

    const pyodideManifest = buildPyodideManifest(hashTree(pyodideDir), {
      pyodideVersion: lock.pyodide.version,
      python: lock.pyodide.python,
      source: lock.pyodide.cdn,
    });
    writeFileIn(tmp, `${PYODIDE_DIR}/${MANIFEST_NAME}`, manifestText(pyodideManifest));

    const manifest = buildManifest(hashTree(tmp), {
      pyodide: lock.pyodide.version,
      python: lock.pyodide.python,
      quickjs: lock.quickjs.packages[0].version,
      pycCache: options.pyc,
    });
    writeFileIn(tmp, MANIFEST_NAME, manifestText(manifest));

    const check = verifyManifest(tmp);
    if (!check.ok)
      throw new Error(`built directory does not match its manifest: ${check.problems.slice(0, 5).join("; ")}`);
    swapIntoPlace(tmp, options.out);
    const groups = sizeGroups(manifest.files);
    log(`built ${path.relative(REPO_ROOT, options.out) || options.out}: ${check.files} files + ${MANIFEST_NAME}`);
    log(
      `size: ${mib(check.bytes)} total = pyodide core ${mib(groups.pyodideCore)}, wheels ${mib(groups.wheels)}, ` +
        `pyc cache ${mib(groups.pycCache)}, quickjs ${mib(groups.quickjs)}, scripts and stubs ${mib(groups.glue)}`,
    );
    return { manifest, bytes: check.bytes, files: check.files, groups };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// --update-lock
// ---------------------------------------------------------------------------------------------

/** Rebuild the lock from the installed packages and the pyodide lockfile; wheels are fetched to read their size. */
export async function updateLock(options, log = console.log) {
  const previous = existsSync(LOCK_PATH) ? readJson(LOCK_PATH) : undefined;
  const preload = previous?.pyodide.preload ?? PYODIDE_PRELOAD;
  const installed = locateInstalled();
  const full = path.join(installed.pyodide.dir, PYODIDE_LOCK_SOURCE);
  const pyodideLock = readJson(full);
  const version = installed.pyodide.version;
  const cdn = `https://cdn.jsdelivr.net/pyodide/v${version}/full/`;
  const wheels = [];
  const licenseByWheel = {};
  for (const name of dependencyClosure(pyodideLock, preload)) {
    const entry = pyodideLock.packages[name];
    const url = `${cdn}${entry.file_name}`;
    // The size is not pinned yet (that is what this reads); the hash from the pyodide lockfile still gates the bytes.
    const { data } = await fetchPinned({
      cacheFile: path.join(options.cache, "wheels", entry.file_name),
      url,
      sha256: entry.sha256,
      bytes: undefined,
      label: entry.file_name,
      offline: options.offline,
      fetchImpl: options.fetchImpl,
    });
    wheels.push({ name, version: entry.version, file: entry.file_name, url, bytes: data.length, sha256: entry.sha256 });
    // A wheel at the version the lock already pins keeps its reviewed license; a new or bumped one is seeded from
    // the wheel's own METADATA, which is a line to read in the diff (and may be no SPDX name at all).
    const pinnedBefore = previous?.pyodide.wheels.find((wheel) => wheel.name === name);
    const reviewed = pinnedBefore?.version === entry.version ? previous.licenses?.wheels?.[name] : undefined;
    const seeded = reviewed ? undefined : wheelMetadataLicense(data, entry.file_name);
    if (reviewed ?? seeded) licenseByWheel[name] = reviewed ?? seeded;
    if (seeded)
      log(`licenses.wheels.${name}: ${seeded} (read from the wheel's METADATA: check it against its license text)`);
  }
  const next = {
    schema: 1,
    pyodide: {
      version,
      python: pyodideLock.info.python,
      cdn,
      preload,
      lockSource: describeFile(installed.pyodide.dir, PYODIDE_LOCK_SOURCE),
      core: PYODIDE_CORE_FILES.map((file) => describeFile(installed.pyodide.dir, file)),
      wheels,
    },
    quickjs: {
      packages: QUICKJS_PACKAGES.map(({ name, include }) => {
        const found = installed.quickjs.find((entry) => entry.name === name);
        return {
          name,
          version: found.version,
          files: pinnedFileList(found.dir, include).map((rel) => describeFile(found.dir, rel)),
        };
      }),
    },
    // Pyodide's and CPython's entries point at committed texts and pin their hashes; they are carried over, and the
    // build refuses them if the committed text is for another version than the one pinned above.
    licenses: { ...(previous?.licenses ?? {}), wheels: licenseByWheel },
  };
  validateLock(next);
  checkLockAgainstPyodide(next, pyodideLock);
  writeFileSync(LOCK_PATH, lockText(next));
  log(
    `wrote ${path.relative(REPO_ROOT, LOCK_PATH)}: pyodide ${version}, ${wheels.length} wheels, ${next.quickjs.packages.reduce((n, p) => n + p.files.length, 0)} quickjs files`,
  );
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const USAGE = `usage:
  node scripts/build-sandbox-runtime.mjs [--out <dir>] [--cache <dir>] [--child-dir <dir>] [--no-pyc] [--offline]
  node scripts/build-sandbox-runtime.mjs --verify [--out <dir>] [--if-present] [--child-dir <dir>]
  node scripts/build-sandbox-runtime.mjs --update-lock [--cache <dir>] [--offline]
env: SANDBOX_RUNTIME_OUT, SANDBOX_RUNTIME_CACHE`;

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.verify) {
    if (options.ifPresent && !existsSync(path.join(options.out, MANIFEST_NAME))) {
      console.log(`sandbox-runtime: ${path.relative(REPO_ROOT, options.out)} is not built, nothing to verify`);
      return 0;
    }
    const result = verifyManifest(options.out);
    const noNotices = result.ok ? noticesProblem(options.out) : undefined;
    if (!result.ok || noNotices) {
      const problems = result.ok ? [noNotices] : result.problems;
      console.error(
        `sandbox-runtime: ${options.out} does not match its manifest:\n  ${problems.slice(0, 20).join("\n  ")}` +
          (noNotices ? "\nrun `npx pnpm@9.15.9 sandbox:build --offline` to rebuild it." : ""),
      );
      return 1;
    }
    const childDir = options.childDir ?? CHILD_SOURCE_DIR;
    if (options.childDir && !existsSync(childDir)) {
      console.error(`sandbox-runtime: --child-dir ${childDir} does not exist`);
      return 1;
    }
    const stale = diffChildScripts(options.out, childDir);
    if (stale.length > 0) {
      console.error(
        `sandbox-runtime: ${options.out} was built from older child scripts than ${childDir}:\n  ${stale.join("\n  ")}\n` +
          "run `npx pnpm@9.15.9 sandbox:build --offline` to rebuild it.",
      );
      return 1;
    }
    console.log(`sandbox-runtime: ${result.files} files, ${mib(result.bytes)}, manifest verified (${options.out})`);
    return 0;
  }
  if (options.updateLock) {
    await updateLock(options);
    return 0;
  }
  await buildSandboxRuntime(options);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`sandbox-runtime: ${error.message}`);
      process.exitCode = 1;
    },
  );
}
