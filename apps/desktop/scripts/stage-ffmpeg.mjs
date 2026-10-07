#!/usr/bin/env node
/**
 * Stage the pinned ffmpeg and ffprobe into apps/desktop/resources/ffmpeg/, the folder electron-builder ships as
 * `resources/ffmpeg` (package.json `build.extraResources`) and the packaged host reads first
 * (`packages/host/src/edit/ffmpeg-binary.ts`, `packagedBinary`).
 *
 *   node scripts/stage-ffmpeg.mjs --target win32-x64|darwin-arm64|darwin-x64 [--out <dir>] [--cache <dir>] [--offline]
 *   node scripts/stage-ffmpeg.mjs --verify [--target <t>] [--out <dir>]
 *
 * Everything that decides what is downloaded lives in `ffmpeg.lock.json` (URL, byte size, sha256 of each archive and
 * of each file taken out of it). No URL or hash is read from an argument or the environment. A download is
 * https only, from a host this file lists, and is checked against the pin BEFORE anything is unpacked or written
 * to the cache. An archive that has any member whose path would leave the folder is refused whole. Only the
 * members the lock names are read, and each lands under a fixed name.
 *
 * The folder ends up holding the two programs, LICENSE.txt (the licence text ships beside GPL binaries), and a
 * generated MANIFEST.json (target, version, source URLs, sha256 of each file). Staging a target removes the files of
 * the others first, so the Windows programs never travel in a mac bundle. The folder's tracked README.md is never
 * touched. `--verify` re-hashes what is staged against the LOCK, not only against the manifest, and fails on a file
 * that is missing, changed, or not listed; it needs no network, so the mac route runs it on the finished .app.
 *
 * Downloads are cached in `vendor/.ffmpeg-cache/` (gitignored); a warm cache never touches the network, and
 * `--offline` enforces that. Licence and source pointers: docs/internal/ffmpeg-attribution.md.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
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
import { readZipEntries, readZipEntry } from "../../../scripts/sandbox-licenses/notices.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DESKTOP_ROOT = path.join(HERE, "..");
export const REPO_ROOT = path.join(DESKTOP_ROOT, "..", "..");
export const LOCK_PATH = path.join(HERE, "ffmpeg.lock.json");
export const DEFAULT_OUT = path.join(DESKTOP_ROOT, "resources", "ffmpeg");
export const DEFAULT_CACHE = path.join(REPO_ROOT, "vendor", ".ffmpeg-cache");
export const MANIFEST_NAME = "MANIFEST.json";
export const LICENCE_NAME = "LICENSE.txt";

export const TARGETS = ["win32-x64", "darwin-arm64", "darwin-x64"];
/** The platform each target's programs must be built for; the lock states it and the staged bytes are sniffed. */
const TARGET_BINARY = { "win32-x64": "pe-x64", "darwin-arm64": "macho-arm64", "darwin-x64": "macho-x64" };
/** The hosts a download may come from. A new publisher is a change to this list, reviewed with the lock. */
export const ALLOWED_HOSTS = ["github.com", "raw.githubusercontent.com", "ffmpeg.martin-riedl.de"];
const FORMATS = ["zip", "file"];
const PROGRAMS = ["ffmpeg", "ffprobe"];
const SHA256 = /^[0-9a-f]{64}$/;
/** Tracked file in the folder that staging must never remove or replace. */
const KEEP = new Set(["README.md"]);
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

const mib = (bytes) => `${(bytes / 1048576).toFixed(1)} MiB`;

export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** Throws unless `data` hashes to `expected`. The message names what was refused. */
function assertSha256(label, data, expected) {
  const actual = sha256Hex(data);
  if (actual !== expected) throw new Error(`sha256 mismatch for ${label}: expected ${expected}, got ${actual}`);
}

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

/** The file names a target stages, in the order the manifest lists them. */
export function expectedNames(target) {
  const suffix = target.startsWith("win32") ? ".exe" : "";
  return [`ffmpeg${suffix}`, `ffprobe${suffix}`, LICENCE_NAME];
}

/** Every name staging may write, for any target. These and the manifest are removed before a restage. */
function everyStagedName() {
  return [...new Set([...TARGETS.flatMap(expectedNames), MANIFEST_NAME])];
}

/** The output names one lock entry produces (`as` of each member of each source). */
export function outputNames(entry) {
  return entry.sources.flatMap((source) => (source.format === "zip" ? source.members.map((m) => m.as) : [source.as]));
}

/** What the lock pins for each output: `{name, bytes, sha256}`. */
function pinnedFiles(entry) {
  return entry.sources.flatMap((source) =>
    source.format === "zip"
      ? source.members.map((m) => ({ name: m.as, bytes: m.bytes, sha256: m.sha256 }))
      : [{ name: source.as, bytes: source.bytes, sha256: source.sha256 }],
  );
}

/**
 * Throws for an archive member name that could leave the folder it is unpacked into, or that no archive tool
 * would write: empty, a NUL, a leading slash or backslash, a drive letter, or a `..` segment (either separator).
 */
export function assertSafeMemberPath(name) {
  const bad = (why) => {
    throw new Error(`unsafe archive path ${JSON.stringify(name)}: ${why}`);
  };
  if (typeof name !== "string" || name === "") bad("empty");
  if (name.includes("\u0000")) bad("contains a NUL");
  if (name.startsWith("/") || name.startsWith("\\")) bad("absolute");
  if (/^[A-Za-z]:/.test(name)) bad("drive letter");
  if (name.split(/[\\/]/).includes("..")) bad("climbs out of the folder");
}

// ---------------------------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------------------------

function checkSource(problems, where, source, target) {
  const bad = (why) => problems.push(`${where}: ${why}`);
  let url;
  try {
    url = new URL(source.url);
  } catch {
    bad(`url ${JSON.stringify(source.url)} is not a url`);
  }
  if (url) {
    if (url.protocol !== "https:") bad("url is not https");
    else if (!ALLOWED_HOSTS.includes(url.hostname)) bad(`host ${url.hostname} is not an allowed host`);
    if (url.username || url.password) bad("url carries credentials");
    if (url.search || url.hash) bad("url has a query or fragment");
  }
  if (typeof source.sha256 !== "string" || !SHA256.test(source.sha256)) bad("sha256 is not 64 lower case hex digits");
  if (!Number.isSafeInteger(source.bytes) || source.bytes <= 0) bad("bytes is not a positive integer");
  if (typeof source.hashFrom !== "string" || source.hashFrom.length < 10)
    bad("hashFrom must say where the hash came from");
  if (!FORMATS.includes(source.format)) {
    bad(`format ${JSON.stringify(source.format)} is not one of ${FORMATS.join(", ")}`);
    return [];
  }
  const names = [];
  if (source.format === "file") {
    names.push(source.as);
  } else if (!Array.isArray(source.members) || source.members.length === 0) {
    bad("a zip source needs members");
  } else {
    for (const member of source.members) {
      names.push(member.as);
      try {
        assertSafeMemberPath(member.path);
      } catch (error) {
        bad(`member path: ${error.message}`);
      }
      if (typeof member.sha256 !== "string" || !SHA256.test(member.sha256))
        bad(`member ${member.as}: sha256 is not 64 lower case hex digits`);
      if (!Number.isSafeInteger(member.bytes) || member.bytes <= 0)
        bad(`member ${member.as}: bytes is not a positive integer`);
    }
  }
  const allowed = expectedNames(target);
  for (const name of names) {
    if (!allowed.includes(name)) bad(`output name ${JSON.stringify(name)} is not one of ${allowed.join(", ")}`);
  }
  return names;
}

/** Throws one error listing every problem, else returns the lock. */
export function validateLock(lock) {
  const problems = [];
  if (lock?.schema !== 1) throw new Error("ffmpeg.lock.json: schema must be 1");
  if (!lock.targets || typeof lock.targets !== "object") throw new Error("ffmpeg.lock.json: targets is missing");
  for (const [target, entry] of Object.entries(lock.targets)) {
    const where = `target ${target}`;
    if (!TARGETS.includes(target)) {
      problems.push(`unknown target ${target} (known: ${TARGETS.join(", ")})`);
      continue;
    }
    if (typeof entry.version !== "string" || entry.version === "") problems.push(`${where}: version is missing`);
    if (entry.binary !== TARGET_BINARY[target]) problems.push(`${where}: binary must be ${TARGET_BINARY[target]}`);
    if (!Array.isArray(entry.sources) || entry.sources.length === 0) {
      problems.push(`${where}: sources is empty`);
      continue;
    }
    const names = entry.sources.flatMap((source, index) =>
      checkSource(problems, `${where} source ${index + 1}`, source, target),
    );
    const dup = names.find((name, index) => names.indexOf(name) !== index);
    if (dup) problems.push(`${where}: output ${dup} is produced twice`);
    for (const required of expectedNames(target)) {
      if (!names.includes(required)) problems.push(`${where}: no source produces ${required}`);
    }
  }
  if (problems.length > 0) throw new Error(`ffmpeg.lock.json is not valid:\n  ${problems.join("\n  ")}`);
  return lock;
}

export function readLock(file = LOCK_PATH) {
  return validateLock(JSON.parse(readFileSync(file, "utf8")));
}

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

const USAGE = `usage:
  node scripts/stage-ffmpeg.mjs --target ${TARGETS.join("|")} [--out <dir>] [--cache <dir>] [--offline]
  node scripts/stage-ffmpeg.mjs --verify [--target <t>] [--out <dir>]
The URLs and hashes are in scripts/ffmpeg.lock.json and nowhere else.`;

export function parseArgs(argv) {
  const options = {
    target: undefined,
    out: DEFAULT_OUT,
    cache: DEFAULT_CACHE,
    offline: false,
    verify: false,
    help: false,
  };
  const value = (i, flag) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--target") {
      options.target = value(i++, arg);
      if (!TARGETS.includes(options.target)) {
        throw new Error(`--target must be one of ${TARGETS.join(", ")}, not ${JSON.stringify(options.target)}`);
      }
    } else if (arg === "--out") options.out = path.resolve(value(i++, arg));
    else if (arg === "--cache") options.cache = path.resolve(value(i++, arg));
    else if (arg === "--offline") options.offline = true;
    else if (arg === "--verify") options.verify = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return { ...options, out: path.resolve(options.out), cache: path.resolve(options.cache) };
}

// ---------------------------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------------------------

function permanent(message) {
  return Object.assign(new Error(message), { permanent: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The response body, refusing to read past `limit` bytes. Falls back to `arrayBuffer()` for a body-less stub. */
async function readBody(response, limit, label, log) {
  if (!response.body?.getReader) {
    const whole = Buffer.from(await response.arrayBuffer());
    if (whole.length > limit) throw permanent(`${label} is larger than the pinned ${limit} bytes`);
    return whole;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let nextReport = 25 * 1048576;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw permanent(`${label} is larger than the pinned ${limit} bytes`);
    }
    chunks.push(value);
    if (total >= nextReport) {
      log(`  ${label}: ${mib(total)} of ${mib(limit)}`);
      nextReport += 25 * 1048576;
    }
  }
  return Buffer.concat(chunks);
}

/**
 * The bytes of one pinned download: from the cache when the entry still hashes right, else from the network. The
 * url must be https; the hash and size are checked BEFORE anything is written to the cache, so a bad download
 * never becomes a cache entry. With `offline` a missing or corrupt entry is an error, never a fetch.
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
  log = () => {},
}) {
  if (new URL(url).protocol !== "https:") throw new Error(`${label}: refusing a url that is not https (${url})`);
  let corrupt = false;
  if (existsSync(cacheFile)) {
    const cached = readFileSync(cacheFile);
    if (cached.length === bytes && sha256Hex(cached) === sha256) return { data: cached, fromCache: true };
    corrupt = true;
    rmSync(cacheFile, { force: true });
  }
  if (offline) throw new Error(`--offline: ${label} is ${corrupt ? "corrupt" : "not"} in the cache (${cacheFile})`);
  log(`downloading ${label} (${mib(bytes)}) from ${url}`);
  let data;
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (response.url && new URL(response.url).protocol !== "https:") {
        throw permanent(`${label}: the download was redirected to a url that is not https (${response.url})`);
      }
      data = await readBody(response, bytes, label, log);
      break;
    } catch (error) {
      last = error;
      if (error.permanent) throw error;
      if (attempt < attempts) await sleep(retryDelayMs * attempt);
    }
  }
  if (!data) throw new Error(`download failed after ${attempts} attempts: ${url}: ${last?.message ?? last}`);
  assertSha256(`${label} (${url})`, data, sha256);
  if (data.length !== bytes) throw new Error(`size mismatch for ${label}: expected ${bytes} bytes, got ${data.length}`);
  mkdirSync(path.dirname(cacheFile), { recursive: true });
  const part = `${cacheFile}.part`;
  writeFileSync(part, data);
  renameSync(part, cacheFile);
  return { data, fromCache: false };
}

// ---------------------------------------------------------------------------------------------
// Unpack
// ---------------------------------------------------------------------------------------------

/**
 * What a program's first bytes say it was built for: `pe-x64`, `macho-arm64`, `macho-x64`, `elf`, or `unknown`
 * (with `pe-other` / `macho-other` for a build for another CPU). Used to refuse the wrong platform's program even
 * when it is the one the lock pins.
 */
export function sniffBinary(buf) {
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x7f454c46) return "elf";
  if (buf.length >= 0x40 && buf[0] === 0x4d && buf[1] === 0x5a) {
    const at = buf.readUInt32LE(0x3c);
    if (at + 6 <= buf.length && buf.toString("latin1", at, at + 4) === "PE\u0000\u0000") {
      return buf.readUInt16LE(at + 4) === 0x8664 ? "pe-x64" : "pe-other";
    }
    return "unknown";
  }
  if (buf.length >= 8 && buf.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = buf.readUInt32LE(4);
    if (cpu === 0x0100000c) return "macho-arm64";
    if (cpu === 0x01000007) return "macho-x64";
    return "macho-other";
  }
  return "unknown";
}

/**
 * The members one zip source names, as `Map<output name, bytes>`. Every entry name in the archive is checked
 * first: one that could leave the folder refuses the whole archive. Each wanted member must exist exactly once and
 * match the lock's size and sha256.
 */
export function extractMembers(zip, source, label) {
  const entries = readZipEntries(zip, label);
  for (const entry of entries) {
    try {
      assertSafeMemberPath(entry.name);
    } catch (error) {
      throw new Error(`${label}: ${error.message}`);
    }
  }
  const out = new Map();
  for (const member of source.members) {
    const found = entries.filter((entry) => entry.name === member.path);
    if (found.length === 0) throw new Error(`${label}: ${member.path} is not in the archive`);
    if (found.length > 1) throw new Error(`${label}: ${member.path} is in the archive more than once`);
    if (found[0].size !== member.bytes) {
      throw new Error(`${label}: ${member.path} is ${found[0].size} bytes, the lock pins ${member.bytes}`);
    }
    const data = readZipEntry(zip, found[0], label, member.bytes);
    assertSha256(`${label}:${member.path}`, data, member.sha256);
    out.set(member.as, data);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Stage and verify
// ---------------------------------------------------------------------------------------------

function cacheFileFor(cache, source) {
  return path.join(cache, `${source.sha256.slice(0, 16)}-${path.posix.basename(new URL(source.url).pathname)}`);
}

function buildManifest(target, entry, files) {
  return {
    schema: 1,
    target,
    ffmpegVersion: entry.version,
    binary: entry.binary,
    sources: entry.sources.map((source) => ({ url: source.url, sha256: source.sha256 })),
    files: files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })).sort((a, b) => (a.name < b.name ? -1 : 1)),
  };
}

function writeFileAtomic(file, data, mode) {
  const part = `${file}.part`;
  writeFileSync(part, data);
  if (mode !== undefined && process.platform !== "win32") chmodSync(part, mode);
  renameSync(part, file);
}

/**
 * Download (or read from the cache) everything the target needs, check all of it, and only then replace what is in
 * `out`. A refusal leaves the folder exactly as it was. Returns the manifest it wrote. After writing, the folder
 * is verified against the lock; a failure there throws, so a pack never starts on a half-staged folder.
 */
export async function stageTarget({
  lock,
  target,
  out,
  cache,
  offline = false,
  fetchImpl = fetch,
  log = console.log,
  attempts = 3,
  retryDelayMs = 500,
}) {
  const entry = lock.targets[target];
  if (!entry) throw new Error(`no ffmpeg is pinned for ${target} in ffmpeg.lock.json`);
  const outputs = new Map();
  for (const source of entry.sources) {
    const label = path.posix.basename(new URL(source.url).pathname);
    const { data, fromCache } = await fetchPinned({
      cacheFile: cacheFileFor(cache, source),
      url: source.url,
      sha256: source.sha256,
      bytes: source.bytes,
      label,
      offline,
      fetchImpl,
      attempts,
      retryDelayMs,
      log,
    });
    if (fromCache) log(`${label}: from the cache, hash checked`);
    if (source.format === "zip") {
      for (const [name, bytes] of extractMembers(data, source, label)) outputs.set(name, bytes);
    } else {
      outputs.set(source.as, data);
    }
  }
  const [ffmpegName, ffprobeName] = expectedNames(target);
  for (const name of [ffmpegName, ffprobeName]) {
    const kind = sniffBinary(outputs.get(name));
    if (kind !== entry.binary)
      throw new Error(`${name} is a ${kind} program, the lock says ${entry.binary} for ${target}`);
  }

  mkdirSync(out, { recursive: true });
  for (const name of everyStagedName()) {
    rmSync(path.join(out, name), { force: true, maxRetries: 10, retryDelay: 100 });
  }
  const files = [];
  for (const [name, data] of outputs) {
    writeFileAtomic(path.join(out, name), data, PROGRAMS.includes(name.replace(/\.exe$/, "")) ? 0o755 : 0o644);
    files.push({ name, bytes: data.length, sha256: sha256Hex(data) });
  }
  const manifest = buildManifest(target, entry, files);
  writeFileAtomic(path.join(out, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 0o644);

  const check = verifyStaged({ lock, out, target });
  if (!check.ok) throw new Error(`the staged folder does not match the lock:\n  ${check.problems.join("\n  ")}`);
  return manifest;
}

/**
 * Re-hash a staged folder against the lock. `{ok, problems, target}`. The manifest says which target was staged;
 * `target`, when given, must agree. The files are compared with what the LOCK pins, so a manifest edited together
 * with a file still fails. A name in the folder that is not a staged file, the manifest or README.md is reported,
 * because anything in the folder ships in the installer.
 */
export function verifyStaged({ lock, out, target }) {
  const problems = [];
  const fail = (message) => ({ ok: false, problems: [...problems, message], target: undefined });
  if (!existsSync(out)) return fail(`not staged: ${out} does not exist`);
  const manifestPath = path.join(out, MANIFEST_NAME);
  if (!existsSync(manifestPath)) return fail(`not staged: ${MANIFEST_NAME} is missing from ${out}`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return fail(`unreadable: ${MANIFEST_NAME} (${error.message})`);
  }
  const entry = lock.targets[manifest.target];
  if (manifest.schema !== 1 || !entry)
    return fail(`${MANIFEST_NAME} names a target the lock does not pin: ${JSON.stringify(manifest.target)}`);
  if (target && manifest.target !== target) return fail(`staged target is ${manifest.target}, expected ${target}`);
  if (manifest.ffmpegVersion !== entry.version) {
    problems.push(`staged from ffmpeg ${manifest.ffmpegVersion}, the lock pins ${entry.version}`);
  }
  const pins = pinnedFiles(entry);
  const listed = new Map((manifest.files ?? []).map((file) => [file.name, file]));
  for (const pin of pins) {
    const inManifest = listed.get(pin.name);
    if (!inManifest || inManifest.sha256 !== pin.sha256 || inManifest.bytes !== pin.bytes) {
      problems.push(`${MANIFEST_NAME} disagrees with the lock: ${pin.name}`);
    }
    const file = path.join(out, pin.name);
    if (!existsSync(file)) {
      problems.push(`missing: ${pin.name}`);
      continue;
    }
    const data = readFileSync(file);
    if (data.length !== pin.bytes)
      problems.push(`size: ${pin.name} is ${data.length} bytes, the lock pins ${pin.bytes}`);
    else if (sha256Hex(data) !== pin.sha256) problems.push(`sha256: ${pin.name} differs from the lock`);
    else if (
      process.platform !== "win32" &&
      PROGRAMS.includes(pin.name.replace(/\.exe$/, "")) &&
      (statSync(file).mode & 0o111) === 0
    ) {
      problems.push(`not executable: ${pin.name}`);
    }
  }
  const known = new Set([...pins.map((pin) => pin.name), MANIFEST_NAME, ...KEEP]);
  for (const name of readdirSync(out)) {
    if (!known.has(name)) problems.push(`unlisted: ${name}`);
  }
  return { ok: problems.length === 0, problems, target: manifest.target };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function describeOut(out) {
  return path.relative(REPO_ROOT, out) || out;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const lock = readLock();
  if (options.verify) {
    const result = verifyStaged({ lock, out: options.out, target: options.target });
    if (!result.ok) {
      console.error(
        `stage-ffmpeg: ${describeOut(options.out)} does not match the lock:\n  ${result.problems.slice(0, 20).join("\n  ")}\n` +
          `run \`node apps/desktop/scripts/stage-ffmpeg.mjs --target ${options.target ?? "<target>"}\` to stage it.`,
      );
      return 1;
    }
    const entry = lock.targets[result.target];
    console.log(
      `stage-ffmpeg: ${result.target} verified in ${describeOut(options.out)} (ffmpeg ${entry.version}, ${pinnedFiles(entry).length} files)`,
    );
    return 0;
  }
  if (!options.target) throw new Error("--target is required (or --verify)");
  const already = existsSync(path.join(options.out, MANIFEST_NAME))
    ? verifyStaged({ lock, out: options.out, target: options.target })
    : { ok: false };
  if (already.ok) {
    console.log(
      `stage-ffmpeg: ${options.target} is already staged in ${describeOut(options.out)} and matches the lock`,
    );
    return 0;
  }
  const manifest = await stageTarget({
    lock,
    target: options.target,
    out: options.out,
    cache: options.cache,
    offline: options.offline,
  });
  const bytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
  console.log(
    `stage-ffmpeg: ${options.target}: ffmpeg ${manifest.ffmpegVersion}, ${manifest.files.length} files, ${mib(bytes)} staged in ${describeOut(options.out)}`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`stage-ffmpeg: ${error.message}`);
      process.exitCode = 1;
    },
  );
}
