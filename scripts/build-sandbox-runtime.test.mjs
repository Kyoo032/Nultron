import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  assertSha256,
  buildManifest,
  buildPyodideManifest,
  CHILD_SCRIPTS,
  checkLockAgainstPyodide,
  copyVerified,
  dependencyClosure,
  diffChildScripts,
  diffManifest,
  fetchPinned,
  hashTree,
  listFiles,
  lockText,
  manifestText,
  NOTICES_NAME,
  noticesProblem,
  parseArgs,
  REPO_ROOT,
  sha256Hex,
  trimPyodideLock,
  validateLock,
  verifyManifest,
} from "./build-sandbox-runtime.mjs";

const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

/** Four wheels that depend on each other the way pandas does, plus one that is not shipped. */
const FAKE_PYODIDE_LOCK = {
  info: { python: "3.14.2", abi_version: "2026_0" },
  packages: {
    numpy: { file_name: "numpy-1.whl", depends: [], sha256: "11" },
    pandas: { file_name: "pandas-1.whl", depends: ["numpy", "dateutil"], sha256: "22" },
    dateutil: { file_name: "dateutil-1.whl", depends: ["six"], sha256: "33" },
    six: { file_name: "six-1.whl", depends: [], sha256: "44" },
    scipy: { file_name: "scipy-1.whl", depends: ["numpy"], sha256: "55" },
  },
};

const readRepoJson = (...parts) => JSON.parse(readFileSync(path.join(REPO_ROOT, ...parts), "utf8"));
const readRepoText = (...parts) => readFileSync(path.join(REPO_ROOT, ...parts), "utf8");

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sandbox-runtime-test-"));
  return Promise.resolve(fn(dir)).finally(() =>
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
}

test("sha256Hex hashes a known string", () => {
  assert.equal(sha256Hex("abc"), ABC);
});

test("assertSha256 returns the hash on a match and names the file on a mismatch", () => {
  assert.equal(assertSha256("abc.bin", Buffer.from("abc"), ABC), ABC);
  assert.throws(
    () => assertSha256("numpy.whl", Buffer.from("abd"), ABC),
    (error) =>
      error.message.startsWith("sha256 mismatch for numpy.whl: expected ba7816bf") && error.message.includes("got "),
  );
});

test("dependencyClosure walks depends and returns sorted names", () => {
  assert.deepEqual(dependencyClosure(FAKE_PYODIDE_LOCK, ["pandas"]), ["dateutil", "numpy", "pandas", "six"]);
  assert.deepEqual(dependencyClosure(FAKE_PYODIDE_LOCK, ["six", "numpy"]), ["numpy", "six"]);
  assert.throws(
    () => dependencyClosure(FAKE_PYODIDE_LOCK, ["pillow"]),
    /package pillow is not in the pyodide lockfile/,
  );
});

test("trimPyodideLock keeps exactly the shipped wheels and the lock info", () => {
  const trimmed = trimPyodideLock(FAKE_PYODIDE_LOCK, ["numpy-1.whl", "pandas-1.whl", "dateutil-1.whl", "six-1.whl"]);
  assert.deepEqual(Object.keys(trimmed.packages), ["numpy", "pandas", "dateutil", "six"]);
  assert.deepEqual(trimmed.info, { python: "3.14.2", abi_version: "2026_0" });
  assert.equal("scipy" in trimmed.packages, false);
});

test("trimPyodideLock refuses a shipped file the lockfile does not know", () => {
  assert.throws(
    () => trimPyodideLock(FAKE_PYODIDE_LOCK, ["numpy-1.whl", "ghost-2.whl", "alien-3.whl"]),
    /shipped file\(s\) not in the pyodide lockfile: alien-3\.whl, ghost-2\.whl/,
  );
});

test("trimPyodideLock refuses a package whose dependency was cut", () => {
  assert.throws(
    () => trimPyodideLock(FAKE_PYODIDE_LOCK, ["pandas-1.whl", "numpy-1.whl", "six-1.whl"]),
    /pandas depends on dateutil, which is not shipped/,
  );
});

test("buildManifest sorts by path, drops extra fields and adds the schema", () => {
  const manifest = buildManifest(
    [
      { name: "vendor/b.bin", bytes: 2, sha256: "bb", extra: "dropped" },
      { name: "py-child.mjs", bytes: 1, sha256: "aa" },
      { name: "node_modules/ws/index.js", bytes: 3, sha256: "cc" },
    ],
    { pyodide: "314.0.7", pycCache: true },
  );
  assert.deepEqual(manifest, {
    schema: 1,
    pyodide: "314.0.7",
    pycCache: true,
    files: [
      { name: "node_modules/ws/index.js", bytes: 3, sha256: "cc" },
      { name: "py-child.mjs", bytes: 1, sha256: "aa" },
      { name: "vendor/b.bin", bytes: 2, sha256: "bb" },
    ],
  });
});

test("buildManifest refuses a duplicate path and the text ends with a newline", () => {
  assert.throws(
    () =>
      buildManifest(
        [
          { name: "a", bytes: 1, sha256: "x" },
          { name: "a", bytes: 1, sha256: "x" },
        ],
        {},
      ),
    /duplicate manifest name: a/,
  );
  assert.equal(manifestText({ schema: 1, files: [] }), '{\n  "schema": 1,\n  "files": []\n}\n');
});

test("buildPyodideManifest sorts by name and keeps the child's {name, bytes, sha256} shape", () => {
  assert.deepEqual(
    buildPyodideManifest(
      [
        { name: "six-1.whl", bytes: 4, sha256: "dd" },
        { name: "numpy-1.whl", bytes: 1, sha256: "aa" },
      ],
      { pyodideVersion: "314.0.7", python: "3.14.2", source: "https://example.test/" },
    ),
    {
      pyodideVersion: "314.0.7",
      python: "3.14.2",
      source: "https://example.test/",
      files: [
        { name: "numpy-1.whl", bytes: 1, sha256: "aa" },
        { name: "six-1.whl", bytes: 4, sha256: "dd" },
      ],
    },
  );
});

test("diffManifest reports missing, resized, changed and unlisted files in a stable order", () => {
  const manifest = {
    files: [
      { name: "a.txt", bytes: 1, sha256: "aa" },
      { name: "b.txt", bytes: 2, sha256: "bb" },
      { name: "c.txt", bytes: 3, sha256: "cc" },
      { name: "d.txt", bytes: 4, sha256: "dd" },
    ],
  };
  const actual = [
    { name: "a.txt", bytes: 1, sha256: "aa" },
    { name: "b.txt", bytes: 9, sha256: "bb" },
    { name: "c.txt", bytes: 3, sha256: "XX" },
    { name: "z-extra.txt", bytes: 1, sha256: "zz" },
  ];
  assert.deepEqual(diffManifest(manifest, actual), [
    "missing: d.txt",
    "sha256: c.txt",
    "size: b.txt expected 2 got 9",
    "unlisted: z-extra.txt",
  ]);
  assert.deepEqual(diffManifest(manifest, manifest.files), []);
});

test("parseArgs reads flags, resolves paths and refuses unknown or valueless flags", () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.pyc, true);
  assert.equal(defaults.offline, false);
  assert.equal(defaults.verify, false);
  assert.equal(path.basename(defaults.out), "sandbox-runtime");
  const parsed = parseArgs(["--out", "x/out", "--cache", "x/cache", "--no-pyc", "--offline", "--child-dir", "x/child"]);
  assert.equal(parsed.out, path.resolve("x/out"));
  assert.equal(parsed.cache, path.resolve("x/cache"));
  assert.equal(parsed.childDir, path.resolve("x/child"));
  assert.equal(parsed.pyc, false);
  assert.equal(parsed.offline, true);
  const verify = parseArgs(["--verify", "--if-present"]);
  assert.equal(verify.verify && verify.ifPresent, true);
  assert.throws(() => parseArgs(["--nope"]), /unknown argument --nope/);
  assert.throws(() => parseArgs(["--out"]), /--out needs a value/);
  assert.throws(() => parseArgs(["--out", "--offline"]), /--out needs a value/);
});

// ---- fetchPinned: refuse a bad download, never cache it, never touch the network on a warm cache ----

const GOOD = Buffer.from("wheel bytes");
const GOOD_SHA = sha256Hex(GOOD);
const respond =
  (body, status = 200) =>
  () =>
    Promise.resolve(new Response(body, { status }));

test("fetchPinned refuses a download whose sha256 differs and leaves the cache empty", () =>
  withTempDir(async (dir) => {
    const cacheFile = path.join(dir, "wheels", "x.whl");
    await assert.rejects(
      fetchPinned({
        cacheFile,
        url: "https://example.test/x.whl",
        sha256: GOOD_SHA,
        bytes: GOOD.length,
        label: "x.whl",
        offline: false,
        fetchImpl: respond("tampered bytes"),
        retryDelayMs: 0,
      }),
      /sha256 mismatch for x\.whl \(https:\/\/example\.test\/x\.whl\)/,
    );
    assert.deepEqual(listFilesOrEmpty(path.join(dir, "wheels")), []);
  }));

test("fetchPinned refuses a size mismatch even when the hash matches the pin", () =>
  withTempDir(async (dir) => {
    await assert.rejects(
      fetchPinned({
        cacheFile: path.join(dir, "x.whl"),
        url: "https://example.test/x.whl",
        sha256: GOOD_SHA,
        bytes: GOOD.length + 1,
        label: "x.whl",
        offline: false,
        fetchImpl: respond(GOOD),
        retryDelayMs: 0,
      }),
      /size mismatch for x\.whl: expected 12 bytes, got 11/,
    );
  }));

test("fetchPinned caches a good download once, then serves it with no fetch at all", () =>
  withTempDir(async (dir) => {
    const cacheFile = path.join(dir, "wheels", "x.whl");
    let calls = 0;
    const counting = () => {
      calls += 1;
      return Promise.resolve(new Response(GOOD));
    };
    const args = {
      cacheFile,
      url: "https://example.test/x.whl",
      sha256: GOOD_SHA,
      bytes: GOOD.length,
      label: "x.whl",
      fetchImpl: counting,
      retryDelayMs: 0,
    };
    const first = await fetchPinned({ ...args, offline: false });
    assert.equal(first.fromCache, false);
    assert.equal(calls, 1);
    const second = await fetchPinned({ ...args, offline: true });
    assert.equal(second.fromCache, true);
    assert.equal(calls, 1);
    assert.deepEqual(second.data, GOOD);
    assert.deepEqual(listFilesOrEmpty(path.join(dir, "wheels")), ["x.whl"]);
  }));

test("fetchPinned in offline mode refuses a missing or corrupt cache entry instead of fetching", () =>
  withTempDir(async (dir) => {
    const cacheFile = path.join(dir, "x.whl");
    const args = {
      cacheFile,
      url: "https://example.test/x.whl",
      sha256: GOOD_SHA,
      bytes: GOOD.length,
      label: "x.whl",
      offline: true,
      fetchImpl: () => assert.fail("fetched while offline"),
    };
    await assert.rejects(fetchPinned(args), /--offline: x\.whl is not in the cache/);
    writeFileSync(cacheFile, "corrupted");
    await assert.rejects(fetchPinned(args), /--offline: x\.whl is corrupt in the cache/);
  }));

test("fetchPinned replaces a corrupt cache entry with a good download", () =>
  withTempDir(async (dir) => {
    const cacheFile = path.join(dir, "x.whl");
    writeFileSync(cacheFile, "corrupted");
    const result = await fetchPinned({
      cacheFile,
      url: "https://example.test/x.whl",
      sha256: GOOD_SHA,
      bytes: GOOD.length,
      label: "x.whl",
      offline: false,
      fetchImpl: respond(GOOD),
      retryDelayMs: 0,
    });
    assert.equal(result.fromCache, false);
    assert.deepEqual(readFileSync(cacheFile), GOOD);
  }));

test("fetchPinned retries a failing request and gives up with the URL in the message", () =>
  withTempDir(async (dir) => {
    let calls = 0;
    const failing = () => {
      calls += 1;
      return Promise.resolve(new Response("nope", { status: 503 }));
    };
    await assert.rejects(
      fetchPinned({
        cacheFile: path.join(dir, "x.whl"),
        url: "https://example.test/x.whl",
        sha256: GOOD_SHA,
        bytes: GOOD.length,
        label: "x.whl",
        offline: false,
        fetchImpl: failing,
        retryDelayMs: 0,
      }),
      /download failed after 3 attempts: https:\/\/example\.test\/x\.whl: HTTP 503/,
    );
    assert.equal(calls, 3);
  }));

// ---- copyVerified, hashTree, verifyManifest on real files ----

test("copyVerified writes a file whose hash matches and refuses one that does not", () =>
  withTempDir((dir) => {
    const source = path.join(dir, "src.bin");
    writeFileSync(source, "abc");
    const root = path.join(dir, "out");
    assert.equal(copyVerified(source, root, "nested/dir/a.bin", ABC, "a.bin"), 3);
    assert.equal(readFileSync(path.join(root, "nested", "dir", "a.bin"), "utf8"), "abc");
    assert.throws(() => copyVerified(source, root, "b.bin", "0".repeat(64), "b.bin"), /sha256 mismatch for b\.bin/);
    assert.deepEqual(listFiles(root), ["nested/dir/a.bin"]);
  }));

test("hashTree skips only the root manifest and verifyManifest agrees with a fresh build", () =>
  withTempDir((dir) => {
    mkdirSync(path.join(dir, "vendor", "pyodide"), { recursive: true });
    writeFileSync(path.join(dir, "py-child.mjs"), "abc");
    writeFileSync(path.join(dir, "vendor", "pyodide", "MANIFEST.json"), "{}");
    const entries = hashTree(dir);
    assert.deepEqual(entries, [
      { name: "py-child.mjs", bytes: 3, sha256: ABC },
      { name: "vendor/pyodide/MANIFEST.json", bytes: 2, sha256: sha256Hex("{}") },
    ]);
    writeFileSync(path.join(dir, "MANIFEST.json"), manifestText(buildManifest(entries, {})));
    assert.deepEqual(verifyManifest(dir), { ok: true, problems: [], files: 2, bytes: 5 });
  }));

test("verifyManifest catches a changed file, a deleted file, an added file and a missing manifest", () =>
  withTempDir((dir) => {
    assert.deepEqual(verifyManifest(dir).problems, ["missing: MANIFEST.json"]);
    writeFileSync(path.join(dir, "a.txt"), "abc");
    writeFileSync(path.join(dir, "b.txt"), "xyz");
    writeFileSync(path.join(dir, "MANIFEST.json"), manifestText(buildManifest(hashTree(dir), {})));
    writeFileSync(path.join(dir, "a.txt"), "abd");
    rmSync(path.join(dir, "b.txt"));
    writeFileSync(path.join(dir, "c.txt"), "new");
    const result = verifyManifest(dir);
    assert.equal(result.ok, false);
    assert.deepEqual(result.problems, ["missing: b.txt", "sha256: a.txt", "unlisted: c.txt"]);
  }));

test("verifyManifest rejects a manifest that is not schema 1", () =>
  withTempDir((dir) => {
    writeFileSync(path.join(dir, "MANIFEST.json"), '{"schema":2,"files":[]}');
    assert.equal(verifyManifest(dir).ok, false);
    writeFileSync(path.join(dir, "MANIFEST.json"), "not json");
    assert.match(verifyManifest(dir).problems[0], /^unreadable: MANIFEST\.json/);
  }));

// ---- --verify also compares the built child scripts with their source ----

const CHILD_FILES = { "py-child.mjs": "// py child\r\nrun();\r\n", "qjs-child.mjs": "// qjs child\nrun();\n" };

/**
 * A built folder (child scripts, a notices file + a MANIFEST that hashes them) and the source dir the scripts were
 * copied from. `withNotices: false` is a folder built before the notices existed.
 */
function makeBuiltAndSource(dir, { withNotices = true } = {}) {
  const built = path.join(dir, "built");
  const source = path.join(dir, "source");
  mkdirSync(built, { recursive: true });
  mkdirSync(source, { recursive: true });
  for (const [name, text] of Object.entries(CHILD_FILES)) {
    writeFileSync(path.join(source, name), text);
    writeFileSync(path.join(built, name), text);
  }
  if (withNotices) writeFileSync(path.join(built, NOTICES_NAME), "THIRD-PARTY NOTICES\n");
  writeFileSync(path.join(built, "MANIFEST.json"), manifestText(buildManifest(hashTree(built), {})));
  return { built, source };
}

const runVerify = (args) =>
  spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "build-sandbox-runtime.mjs"), "--verify", ...args], {
    encoding: "utf8",
  });

test("CHILD_SCRIPTS is the pair of entry scripts the build copies", () => {
  assert.deepEqual(CHILD_SCRIPTS, ["py-child.mjs", "qjs-child.mjs"]);
});

test("diffChildScripts passes when the built copies match the source byte for byte", () =>
  withTempDir((dir) => {
    const { built, source } = makeBuiltAndSource(dir);
    assert.deepEqual(diffChildScripts(built, source), []);
  }));

test("diffChildScripts names every child script whose source changed after the build", () =>
  withTempDir((dir) => {
    const { built, source } = makeBuiltAndSource(dir);
    writeFileSync(path.join(source, "qjs-child.mjs"), "// qjs child\nrun2();\n");
    assert.deepEqual(diffChildScripts(built, source), ["stale: qjs-child.mjs"]);
    // a line-ending change alone is a difference: the build copies bytes, so --verify compares bytes
    writeFileSync(path.join(source, "qjs-child.mjs"), CHILD_FILES["qjs-child.mjs"]);
    writeFileSync(path.join(source, "py-child.mjs"), CHILD_FILES["py-child.mjs"].replaceAll("\r\n", "\n"));
    assert.deepEqual(diffChildScripts(built, source), ["stale: py-child.mjs"]);
  }));

test("diffChildScripts has nothing to compare when the source dir is absent (packed app, image runtime stage)", () =>
  withTempDir((dir) => {
    const { built } = makeBuiltAndSource(dir);
    assert.deepEqual(diffChildScripts(built, path.join(dir, "no-such-source")), []);
  }));

test("--verify exits 0 when the source matches and 1 with the rebuild hint when a child script changed", () =>
  withTempDir((dir) => {
    const { built, source } = makeBuiltAndSource(dir);
    const args = ["--out", built, "--child-dir", source];
    const ok = runVerify(args);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /manifest verified/);

    writeFileSync(path.join(source, "py-child.mjs"), "// py child, edited after the build\n");
    const stale = runVerify(args);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /py-child\.mjs/);
    assert.ok(
      stale.stderr.includes("run `npx pnpm@9.15.9 sandbox:build --offline`"),
      `missing rebuild hint in: ${stale.stderr}`,
    );
    assert.doesNotMatch(stale.stderr, /qjs-child\.mjs/);
  }));

test("--verify refuses an explicit --child-dir that does not exist instead of silently skipping the check", () =>
  withTempDir((dir) => {
    const { built } = makeBuiltAndSource(dir);
    // the implicit source dir may be absent (packed app, image runtime stage; covered through diffChildScripts above);
    // a --child-dir the caller typed must exist, or a typo would turn the check into a false green.
    const missing = runVerify(["--out", built, "--child-dir", path.join(dir, "typo")]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /--child-dir .*typo.* does not exist/);
  }));

test("--verify refuses a folder built without third-party notices and says how to rebuild it", () =>
  withTempDir((dir) => {
    const { built, source } = makeBuiltAndSource(dir, { withNotices: false });
    assert.match(noticesProblem(built), /THIRD_PARTY_NOTICES\.txt is not listed in MANIFEST\.json/);
    const old = runVerify(["--out", built, "--child-dir", source]);
    assert.equal(old.status, 1);
    assert.match(old.stderr, /THIRD_PARTY_NOTICES\.txt is not listed in MANIFEST\.json/);
    assert.ok(old.stderr.includes("run `npx pnpm@9.15.9 sandbox:build --offline`"), old.stderr);
  }));

test("--verify checks the notices file like every other file: a changed or deleted one fails the manifest", () =>
  withTempDir((dir) => {
    const { built, source } = makeBuiltAndSource(dir);
    assert.equal(noticesProblem(built), undefined);
    assert.equal(runVerify(["--out", built, "--child-dir", source]).status, 0);
    writeFileSync(path.join(built, NOTICES_NAME), "THIRD-PARTY NOTICEZ\n"); // same length: only the hash differs
    const edited = runVerify(["--out", built, "--child-dir", source]);
    assert.equal(edited.status, 1);
    assert.match(edited.stderr, /sha256: THIRD_PARTY_NOTICES\.txt/);
    rmSync(path.join(built, NOTICES_NAME));
    const gone = runVerify(["--out", built, "--child-dir", source]);
    assert.equal(gone.status, 1);
    assert.match(gone.stderr, /missing: THIRD_PARTY_NOTICES\.txt/);
  }));

test("noticesProblem is silent about an unreadable manifest (verifyManifest reports that) and refuses an empty entry", () =>
  withTempDir((dir) => {
    assert.equal(noticesProblem(dir), undefined);
    writeFileSync(
      path.join(dir, "MANIFEST.json"),
      JSON.stringify({ schema: 1, files: [{ name: NOTICES_NAME, bytes: 0 }] }),
    );
    assert.match(noticesProblem(dir), /is not listed/);
  }));

// ---- the committed lock and the files that must agree with it ----

const lock = readRepoJson("scripts", "sandbox-runtime.lock.json");

test("the committed lock is well formed", () => {
  assert.equal(validateLock(lock), lock);
  assert.deepEqual(
    lock.pyodide.wheels.map((wheel) => wheel.name),
    ["numpy", "pandas", "python-dateutil", "pytz", "six"],
  );
  assert.deepEqual(lock.pyodide.preload, ["numpy", "pandas"]);
});

test("lockText writes two-space JSON, keeps preload on one line and ends with a newline", () => {
  assert.equal(
    lockText({ schema: 1, pyodide: { preload: ["numpy", "pandas"], wheels: [] } }),
    '{\n  "schema": 1,\n  "pyodide": {\n    "preload": ["numpy", "pandas"],\n    "wheels": []\n  }\n}\n',
  );
});

test("the committed lock is exactly what --update-lock writes (canonical text)", () => {
  assert.equal(readRepoText("scripts", "sandbox-runtime.lock.json").replaceAll("\r\n", "\n"), lockText(lock));
});

test("validateLock refuses a file name that could leave the output folder", () => {
  for (const bad of ["../escape.js", "/etc/passwd", "dist/../../x", "dist\\x.js", "dist/a b.js"]) {
    const tampered = structuredClone(lock);
    tampered.quickjs.packages[0].files[0].file = bad;
    assert.throws(() => validateLock(tampered), /file must be a plain relative path/, bad);
  }
  const nested = structuredClone(lock);
  nested.pyodide.wheels[0].file = "sub/dir.whl";
  nested.pyodide.wheels[0].url = `${nested.pyodide.cdn}sub/dir.whl`;
  assert.throws(() => validateLock(nested), /pyodide\.wheels numpy: file must be a bare file name/);
});

test("validateLock refuses a hostile path for its path, whichever file it replaced, and still requires LICENSE", () => {
  // the path rule runs before the "LICENSE must ship" rule: replacing the LICENSE entry with a hostile path is a
  // path problem, not a missing-license problem
  const license = lock.quickjs.packages[0].files.findIndex((entry) => entry.file === "LICENSE");
  assert.ok(license >= 0, "the committed lock pins a LICENSE for quickjs-emscripten-core");
  const hostile = structuredClone(lock);
  hostile.quickjs.packages[0].files[license].file = "../LICENSE";
  assert.throws(
    () => validateLock(hostile),
    /quickjs quickjs-emscripten-core \.\.\/LICENSE: file must be a plain relative path/,
  );
  // a clean lock that lacks the LICENSE entry is still refused, for the missing license
  const missing = structuredClone(lock);
  missing.quickjs.packages[0].files = missing.quickjs.packages[0].files.filter((entry) => entry.file !== "LICENSE");
  assert.throws(() => validateLock(missing), /quickjs quickjs-emscripten-core: LICENSE must ship/);
  const noList = structuredClone(lock);
  noList.quickjs.packages[1].files = undefined;
  assert.throws(() => validateLock(noList), /quickjs @jitl\/quickjs-ffi-types: files must be a non-empty list/);
});

test("validateLock requires a license for Pyodide, CPython and every wheel, and nothing else", () => {
  const clone = () => structuredClone(lock);
  const none = clone();
  delete none.licenses;
  assert.throws(() => validateLock(none), /licenses is required/);
  const noPyodide = clone();
  delete noPyodide.licenses.pyodide;
  assert.throws(() => validateLock(noPyodide), /licenses\.pyodide\.license is required/);
  const noHome = clone();
  noHome.licenses.cpython.homepage = "http://example.test/";
  assert.throws(() => validateLock(noHome), /licenses\.cpython\.homepage must be an https URL/);
  const badHash = clone();
  badHash.licenses.pyodide.sha256 = "abc";
  assert.throws(() => validateLock(badHash), /licenses\.pyodide\.sha256 must be 64 lowercase hex characters/);
  for (const file of ["../pyodide.txt", "sub/pyodide.txt", ".hidden", "..", ""]) {
    const bad = clone();
    bad.licenses.pyodide.file = file;
    assert.throws(() => validateLock(bad), /licenses\.pyodide\.file must be a bare file name/, file);
  }
  const unlicensed = clone();
  delete unlicensed.licenses.wheels.pandas;
  assert.throws(() => validateLock(unlicensed), /licenses\.wheels has no entry for pandas/);
  const blank = clone();
  blank.licenses.wheels.six = "  ";
  assert.throws(() => validateLock(blank), /licenses\.wheels six: license is required/);
  const stray = clone();
  stray.licenses.wheels.scipy = "BSD-3-Clause";
  assert.throws(() => validateLock(stray), /licenses\.wheels lists scipy, which no shipped wheel is/);
});

test("validateLock refuses a short hash, a foreign URL and a wrong wheel set", () => {
  const clone = () => structuredClone(lock);
  const shortHash = clone();
  shortHash.pyodide.wheels[0].sha256 = "abc";
  assert.throws(() => validateLock(shortHash), /pyodide\.wheels numpy: sha256 must be 64 lowercase hex characters/);
  const foreign = clone();
  foreign.pyodide.wheels[1].url = `https://evil.test/${foreign.pyodide.wheels[1].file}`;
  assert.throws(
    () => validateLock(foreign),
    /pyodide\.wheels pandas: url must be https:\/\/cdn\.jsdelivr\.net\/pyodide\/v314\.0\.7\/full\//,
  );
  const reordered = clone();
  reordered.quickjs.packages.reverse();
  assert.throws(() => validateLock(reordered), /quickjs\.packages must list exactly/);
  const noPackageJson = clone();
  noPackageJson.quickjs.packages[0].files = noPackageJson.quickjs.packages[0].files.filter(
    (f) => f.file !== "package.json",
  );
  assert.throws(() => validateLock(noPackageJson), /package\.json must ship/);
});

test("checkLockAgainstPyodide requires the wheels to be the closure of the preload list, with the lockfile's hashes", () => {
  const fake = {
    pyodide: {
      python: "3.14.2",
      preload: ["pandas"],
      wheels: [
        { name: "dateutil", file: "dateutil-1.whl", sha256: "33" },
        { name: "numpy", file: "numpy-1.whl", sha256: "11" },
        { name: "pandas", file: "pandas-1.whl", sha256: "22" },
        { name: "six", file: "six-1.whl", sha256: "44" },
      ],
    },
  };
  assert.doesNotThrow(() => checkLockAgainstPyodide(fake, FAKE_PYODIDE_LOCK));
  const missingDep = structuredClone(fake);
  missingDep.pyodide.wheels = missingDep.pyodide.wheels.filter((wheel) => wheel.name !== "six");
  assert.throws(() => checkLockAgainstPyodide(missingDep, FAKE_PYODIDE_LOCK), /are not the closure of pandas/);
  const wrongHash = structuredClone(fake);
  wrongHash.pyodide.wheels[1].sha256 = "99";
  assert.throws(
    () => checkLockAgainstPyodide(wrongHash, FAKE_PYODIDE_LOCK),
    /wheel numpy: sha256 differs from the pyodide lockfile \(11\)/,
  );
  const wrongPython = structuredClone(fake);
  wrongPython.pyodide.python = "3.15.0";
  assert.throws(
    () => checkLockAgainstPyodide(wrongPython, FAKE_PYODIDE_LOCK),
    /pyodide lockfile is for python 3\.14\.2, the lock pins 3\.15\.0/,
  );
});

test("the lock pins the exact versions the root package.json installs", () => {
  const dev = readRepoJson("package.json").devDependencies;
  assert.equal(dev.pyodide, lock.pyodide.version);
  const byName = Object.fromEntries(lock.quickjs.packages.map((pkg) => [pkg.name, pkg.version]));
  assert.equal(dev["quickjs-emscripten-core"], byName["quickjs-emscripten-core"]);
  assert.equal(dev["@jitl/quickjs-wasmfile-release-sync"], byName["@jitl/quickjs-wasmfile-release-sync"]);
  assert.match(dev.pyodide, /^\d+\.\d+\.\d+$/);
});

test("the image builds the folder in the build stage and runs with it read-only at /app/sandbox", () => {
  const dockerfile = readRepoText("webapp-deploy", "Dockerfile");
  assert.match(
    dockerfile,
    /node scripts\/build-sandbox-runtime\.mjs --out \/opt\/sandbox-runtime --cache \/opt\/sandbox-cache/,
  );
  // neither the folder nor the download cache may sit under /app, which the runtime stage copies wholesale
  assert.doesNotMatch(dockerfile, /build-sandbox-runtime\.mjs[^\n]*--(?:out|cache) \/app/);
  assert.match(dockerfile, /COPY --from=build --chown=root:root \/opt\/sandbox-runtime \/app\/sandbox/);
  assert.match(dockerfile, /AGENTFORGE_SANDBOX_DIR=\/app\/sandbox/);
  assert.match(dockerfile, /chmod -R a-w \/app\/sandbox/);
});

function listFilesOrEmpty(dir) {
  try {
    return listFiles(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
