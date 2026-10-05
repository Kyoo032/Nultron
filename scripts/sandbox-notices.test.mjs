// node --test scripts/sandbox-notices.test.mjs
// The third-party notices of the code-sandbox runtime folder (scripts/sandbox-licenses/notices.mjs and the way
// scripts/build-sandbox-runtime.mjs writes them): the zip reader, license text handling, the committed Pyodide and
// CPython texts against the lock, the notices file for a synthetic folder, and the manifest entry that makes
// `--verify` check it. No network and no built folder: wheels here are small zips made by the test.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import {
  buildManifest,
  buildNoticesText,
  collectNoticeComponents,
  hashTree,
  LICENSE_TEXT_MARKER,
  LICENSES_DIR,
  licenseTextFrom,
  loadLicenseText,
  manifestText,
  NOTICES_NAME,
  noticesProblem,
  PYODIDE_DIR,
  parseLicenseFile,
  readZipEntries,
  readZipEntry,
  REPO_ROOT,
  sha256Hex,
  validateLock,
  verifyManifest,
  wheelLicenseEntries,
  wheelLicenses,
  wheelMetadataLicense,
  writeNotices,
} from "./build-sandbox-runtime.mjs";

const lock = validateLock(
  JSON.parse(readFileSync(path.join(REPO_ROOT, "scripts", "sandbox-runtime.lock.json"), "utf8")),
);

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sandbox-notices-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** A zip file: `entries` is [{name, data, deflate?, flags?}]. CRCs are left at 0, which the reader does not check. */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data = "", deflate = false, flags = 0 } of entries) {
    const raw = Buffer.from(data);
    const body = deflate ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A wheel with a METADATA file and the given extra files (all under `<pkg>.dist-info/` unless the name has a slash prefix `!`). */
function makeWheel(pkg, { metadata = "Metadata-Version: 2.4\nName: x\n", files = {} } = {}) {
  const entries = [{ name: `${pkg}.dist-info/METADATA`, data: metadata, deflate: true }];
  for (const [name, data] of Object.entries(files)) {
    entries.push({ name: name.startsWith("!") ? name.slice(1) : `${pkg}.dist-info/${name}`, data, deflate: true });
  }
  return makeZip(entries);
}

// ---- the zip reader ----

test("readZipEntries and readZipEntry read stored and deflated entries, and directory entries are listed", () => {
  const zip = makeZip([
    { name: "a/", data: "" },
    { name: "a/stored.txt", data: "stored text" },
    { name: "a/deflated.txt", data: "deflated text ".repeat(50), deflate: true },
  ]);
  const entries = readZipEntries(zip, "t.zip");
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["a/", "a/stored.txt", "a/deflated.txt"],
  );
  assert.equal(readZipEntry(zip, entries[1], "t.zip").toString(), "stored text");
  assert.equal(readZipEntry(zip, entries[2], "t.zip").toString(), "deflated text ".repeat(50));
});

test("the zip reader refuses what is not a zip, an encrypted entry, an oversized entry and an unknown method", () => {
  assert.throws(
    () => readZipEntries(Buffer.from("not a zip file at all, just text"), "x.whl"),
    /x\.whl: not a readable zip file/,
  );
  assert.throws(() => readZipEntries("string", "x.whl"), /not a readable zip file \(too short\)/);
  const zip = makeZip([
    { name: "secret.txt", data: "s", flags: 1 },
    { name: "big.txt", data: "x".repeat(100) },
  ]);
  const [secret, big] = readZipEntries(zip, "x.whl");
  assert.throws(() => readZipEntry(zip, secret, "x.whl"), /cannot read secret\.txt \(encrypted\)/);
  assert.throws(
    () => readZipEntry(zip, big, "x.whl", 10),
    /cannot read big\.txt \(100 bytes, more than the 10 byte limit\)/,
  );
  assert.equal(readZipEntry(zip, big, "x.whl", 100).length, 100);
  assert.throws(() => readZipEntry(zip, { ...big, method: 12 }, "x.whl"), /compression method 12 is not supported/);
  assert.throws(() => readZipEntry(zip, { ...big, size: 99 }, "x.whl"), /expected 99 bytes, got 100/);
});

// ---- license text ----

test("licenseTextFrom gives LF text without BOM or trailing blank space, and refuses binary, empty and non-UTF-8", () => {
  assert.equal(
    licenseTextFrom(Buffer.from("﻿MIT License\r\n\r\nPermission.\r\n\r\n  \n"), "l"),
    "MIT License\n\nPermission.",
  );
  assert.equal(licenseTextFrom(Buffer.from("old\rmac\n"), "l"), "old\nmac");
  assert.throws(
    () => licenseTextFrom(Buffer.from("  \n\n"), "a.whl: LICENSE"),
    /a\.whl: LICENSE: the license text is empty/,
  );
  assert.throws(() => licenseTextFrom(Buffer.from("ab\u0000cd"), "l"), /l: the license text is binary/);
  assert.throws(() => licenseTextFrom(Buffer.from([0xc3, 0x28]), "l"), /l: the license text is not valid UTF-8/);
});

test("wheelLicenseEntries picks the license files under .dist-info and nothing else", () => {
  const entries = readZipEntries(
    makeWheel("pkg-1.0", {
      files: {
        LICENSE: "a",
        "licenses/": "",
        "licenses/sub/NOTICE.md": "b",
        "COPYING.txt": "c",
        RECORD: "r",
        "!pkg/LICENSE": "elsewhere",
        "!pkg/licenses.py": "code",
        "LICENSEE-list.txt": "no",
      },
    }),
    "w.whl",
  );
  assert.deepEqual(
    wheelLicenseEntries(entries).map((entry) => entry.name),
    ["pkg-1.0.dist-info/COPYING.txt", "pkg-1.0.dist-info/LICENSE", "pkg-1.0.dist-info/licenses/sub/NOTICE.md"],
  );
});

test("wheelLicenses returns each license file's label and text, and a wheel with none fails naming the wheel", () => {
  const wheel = makeWheel("pkg-1.0", { files: { LICENSE: "MIT text\r\n", "licenses/AUTHORS.md": "Authors" } });
  assert.deepEqual(wheelLicenses(wheel, "pkg.whl"), [
    { label: "LICENSE", text: "MIT text" },
    { label: "licenses/AUTHORS.md", text: "Authors" },
  ]);
  assert.throws(
    () => wheelLicenses(makeWheel("pkg-1.0", { files: { RECORD: "r" } }), "pkg-1.0-py3-none-any.whl"),
    /no license text found in pkg-1\.0-py3-none-any\.whl: it has no LICENSE, COPYING or NOTICE file under its \.dist-info\/ directory/,
  );
  assert.throws(
    () => wheelLicenses(makeWheel("pkg-1.0", { files: { LICENSE: "  \n" } }), "pkg.whl"),
    /pkg\.whl: pkg-1\.0\.dist-info\/LICENSE: the license text is empty/,
  );
});

test("wheelMetadataLicense prefers License-Expression, takes a short License field and ignores the description body", () => {
  const meta = (head, body = "") =>
    makeWheel("p-1", { metadata: `Metadata-Version: 2.4\nName: p\n${head}\n\n${body}` });
  assert.equal(wheelMetadataLicense(meta("License: Old\nLicense-Expression: MIT AND Zlib"), "p.whl"), "MIT AND Zlib");
  assert.equal(wheelMetadataLicense(meta("License: BSD 3-Clause License"), "p.whl"), "BSD 3-Clause License");
  assert.equal(wheelMetadataLicense(meta("Summary: x", "License: in the body"), "p.whl"), undefined);
  assert.equal(wheelMetadataLicense(meta(`License: ${"long ".repeat(30)}`), "p.whl"), undefined);
  assert.equal(wheelMetadataLicense(makeZip([{ name: "p-1.dist-info/RECORD", data: "" }]), "p.whl"), undefined);
});

// ---- the committed texts against the lock ----

const HEADER = (text, extra = {}) =>
  [
    ...Object.entries({
      Component: "Thing",
      Version: "1.2.3",
      License: "MIT",
      Source: "https://example.test/LICENSE",
      "Source-SHA256": sha256Hex(text),
      ...extra,
    }).map(([key, value]) => `${key}: ${value}`),
    LICENSE_TEXT_MARKER,
  ].join("\n");

test("parseLicenseFile returns the header and the text, and the hash covers LF text so CRLF checkouts verify", () => {
  const body = "License line one\nline two\n";
  const file = `${HEADER(body)}\n${body}`;
  const parsed = parseLicenseFile(file, "t.txt");
  assert.equal(parsed.meta.Component, "Thing");
  assert.equal(parsed.text, "License line one\nline two");
  assert.deepEqual(parseLicenseFile(file.replaceAll("\n", "\r\n"), "t.txt"), parsed);
});

test("parseLicenseFile refuses a missing marker, a missing header field, a non-https source and an altered text", () => {
  const body = "License text\n";
  assert.throws(
    () => parseLicenseFile(`Component: x\n${body}`, "t.txt"),
    /t\.txt: no "----- LICENSE TEXT FOLLOWS -----" line/,
  );
  const noVersion = `${HEADER(body).replace("Version: 1.2.3\n", "")}\n${body}`;
  assert.throws(() => parseLicenseFile(noVersion, "t.txt"), /t\.txt: the header is missing "Version:"/);
  const http = `${HEADER(body, { Source: "http://example.test/L" })}\n${body}`;
  assert.throws(() => parseLicenseFile(http, "t.txt"), /Source must be an https URL/);
  const altered = `${HEADER(body)}\nLicense text, altered\n`;
  assert.throws(
    () => parseLicenseFile(altered, "t.txt"),
    /t\.txt: the text hashes to [0-9a-f]{64}, but the header says Source-SHA256/,
  );
});

test("loadLicenseText refuses a missing file, a text for another version and a text the lock does not pin", () =>
  withTempDir((dir) => {
    const body = "License text\n";
    writeFileSync(path.join(dir, "thing.txt"), `${HEADER(body)}\n${body}`);
    const spec = { license: "MIT", file: "thing.txt", sha256: sha256Hex(body) };
    assert.equal(loadLicenseText(dir, spec, { name: "Thing", version: "1.2.3" }).text, "License text");
    assert.throws(
      () => loadLicenseText(dir, { ...spec, file: "gone.txt" }, { name: "Thing", version: "1.2.3" }),
      /license text for Thing is missing: scripts\/sandbox-licenses\/gone\.txt/,
    );
    assert.throws(
      () => loadLicenseText(dir, spec, { name: "Thing", version: "2.0.0" }),
      /is the license of Thing 1\.2\.3, but the lock pins 2\.0\.0/,
    );
    assert.throws(
      () => loadLicenseText(dir, { ...spec, sha256: "0".repeat(64) }, { name: "Thing", version: "1.2.3" }),
      /sha256 mismatch for scripts\/sandbox-licenses\/thing\.txt/,
    );
  }));

test("the committed Pyodide and CPython texts are the ones the lock pins, at the versions it pins", () => {
  const pyodide = loadLicenseText(LICENSES_DIR, lock.licenses.pyodide, {
    name: "Pyodide",
    version: lock.pyodide.version,
  });
  const cpython = loadLicenseText(LICENSES_DIR, lock.licenses.cpython, {
    name: "CPython",
    version: lock.pyodide.python,
  });
  assert.match(pyodide.text, /^Mozilla Public License Version 2\.0/);
  assert.match(cpython.text, /PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2/);
  assert.match(pyodide.label, /^https:\/\/raw\.githubusercontent\.com\/pyodide\/pyodide\/314\.0\.7\/LICENSE$/);
  assert.match(cpython.label, /^https:\/\/raw\.githubusercontent\.com\/python\/cpython\/v3\.14\.2\/LICENSE$/);
});

// ---- the notices for a synthetic folder ----

/**
 * A folder laid out like the build's temp dir, with the lock's wheel file names (small zips with a license each) and
 * a LICENSE for each QuickJS package. `without` leaves one wheel file or one QuickJS LICENSE out.
 */
function makeRuntimeRoot(dir, { licenseless = [], emptyLicense = [], skipQuickjs = false } = {}) {
  mkdirSync(path.join(dir, ...PYODIDE_DIR.split("/")), { recursive: true });
  for (const wheel of lock.pyodide.wheels) {
    const dist = `${wheel.name}-${wheel.version}`;
    const files = licenseless.includes(wheel.name) ? { RECORD: "" } : { LICENSE: `${wheel.name} license text\n` };
    if (emptyLicense.includes(wheel.name)) files.LICENSE = "\n";
    writeFileSync(path.join(dir, ...PYODIDE_DIR.split("/"), wheel.file), makeWheel(dist, { files }));
  }
  for (const pkg of lock.quickjs.packages) {
    mkdirSync(path.join(dir, "node_modules", ...pkg.name.split("/")), { recursive: true });
    if (skipQuickjs && pkg.name === "@jitl/quickjs-ffi-types") continue;
    writeFileSync(
      path.join(dir, "node_modules", ...pkg.name.split("/"), "LICENSE"),
      "MIT License\n\nCopyright quickjs\n",
    );
  }
}

test("the notices name every component with its version and license, and carry every license text", () =>
  withTempDir((dir) => {
    makeRuntimeRoot(dir);
    const components = collectNoticeComponents(lock, { root: dir });
    assert.deepEqual(
      components.map((component) => component.name),
      ["Pyodide", "CPython", "numpy", "pandas", "python-dateutil", "pytz", "six", "quickjs-emscripten"],
    );
    const text = buildNoticesText(components);
    for (const component of components) {
      assert.ok(
        text.includes(`${component.name} ${component.version} - ${component.license}`),
        `${component.name} listed`,
      );
      assert.ok(
        text.includes(`${component.name} ${component.version}\nLicense: ${component.license}\n`),
        `${component.name} section`,
      );
    }
    assert.match(text, /Pyodide 314\.0\.7 - MPL-2\.0/);
    assert.match(text, /CPython 3\.14\.2 - PSF-2\.0/);
    assert.match(text, /numpy 2\.4\.6 - BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1\.0/);
    assert.match(text, /pandas 3\.0\.2 - BSD-3-Clause/);
    assert.match(text, /quickjs-emscripten 0\.\d+\.\d+ - MIT/);
    assert.ok(text.includes("Mozilla Public License Version 2.0"), "the Pyodide license text");
    assert.ok(text.includes("PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2"), "the CPython license text");
    for (const wheel of lock.pyodide.wheels)
      assert.ok(text.includes(`${wheel.name} license text`), `${wheel.name} text`);
    assert.ok(text.includes("Copyright quickjs"), "the QuickJS license text");
    // identical texts of one component's packages are printed once, under all their labels
    assert.equal(text.split("Copyright quickjs").length, 2);
    assert.match(
      text,
      /License text: quickjs-emscripten-core@[\d.]+ LICENSE, @jitl\/quickjs-ffi-types@[\d.]+ LICENSE, /,
    );
    assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"));
    assert.ok(!text.includes("\r"), "LF line endings");
  }));

test("the notices are the same bytes on every build: no paths, dates or machine-specific text", () => {
  const build = () =>
    withTempDir((dir) => {
      makeRuntimeRoot(dir);
      const text = buildNoticesText(collectNoticeComponents(lock, { root: dir }));
      assert.ok(!text.includes(dir), "the build directory does not leak into the file");
      return text;
    });
  assert.equal(build(), build());
});

test("a wheel without a license file fails the notices naming the wheel; so does an empty one", () => {
  withTempDir((dir) => {
    makeRuntimeRoot(dir, { licenseless: ["pandas"] });
    assert.throws(
      () => collectNoticeComponents(lock, { root: dir }),
      /no license text found in pandas-3\.0\.2-cp314-cp314-pyemscripten_2026_0_wasm32\.whl/,
    );
  });
  withTempDir((dir) => {
    makeRuntimeRoot(dir, { emptyLicense: ["six"] });
    assert.throws(
      () => collectNoticeComponents(lock, { root: dir }),
      /six-1\.17\.0-py2\.py3-none-any\.whl: .*LICENSE: the license text is empty/,
    );
  });
});

test("a QuickJS package without its LICENSE file fails the notices", () =>
  withTempDir((dir) => {
    makeRuntimeRoot(dir, { skipQuickjs: true });
    assert.throws(() => collectNoticeComponents(lock, { root: dir }), /quickjs-ffi-types[\\/]LICENSE/);
  }));

test("collectNoticeComponents refuses a committed text for another version or one the lock does not pin", () =>
  withTempDir((dir) => {
    makeRuntimeRoot(dir);
    const bumped = structuredClone(lock);
    bumped.pyodide.version = "999.0.0";
    assert.throws(
      () => collectNoticeComponents(bumped, { root: dir }),
      /is the license of Pyodide 314\.0\.7, but the lock pins 999\.0\.0/,
    );
    const unpinned = structuredClone(lock);
    unpinned.licenses.cpython.sha256 = "1".repeat(64);
    assert.throws(
      () => collectNoticeComponents(unpinned, { root: dir }),
      /sha256 mismatch for scripts\/sandbox-licenses\/cpython-PSF-2\.0\.txt/,
    );
  }));

test("buildNoticesText refuses a component with no license name or no license text, and an empty list", () => {
  const ok = { name: "A", version: "1", license: "MIT", covers: ["a"], texts: [{ label: "LICENSE", text: "MIT" }] };
  assert.match(buildNoticesText([ok]), /1\. A 1 - MIT/);
  assert.throws(() => buildNoticesText([]), /no components/);
  assert.throws(() => buildNoticesText([{ ...ok, texts: [] }]), /A 1: no license text/);
  assert.throws(() => buildNoticesText([{ ...ok, license: "" }]), /A 1: no license name/);
  assert.throws(
    () => buildNoticesText([{ ...ok, texts: [{ label: "L", text: " " }] }]),
    /A 1: the license text L is empty/,
  );
});

// ---- the file in the folder and in its manifest ----

test("writeNotices puts THIRD_PARTY_NOTICES.txt at the folder root, and the root manifest lists it with its hash", () =>
  withTempDir((dir) => {
    makeRuntimeRoot(dir);
    const components = writeNotices(lock, dir);
    assert.equal(components.length, 8);
    const written = readFileSync(path.join(dir, NOTICES_NAME));
    assert.match(written.toString("utf8"), /^THIRD-PARTY NOTICES\n/);
    assert.equal(noticesProblem(dir), undefined); // no manifest yet: nothing to complain about
    const entries = hashTree(dir);
    const listed = entries.find((entry) => entry.name === NOTICES_NAME);
    assert.deepEqual(listed, { name: NOTICES_NAME, bytes: written.length, sha256: sha256Hex(written) });
    writeFileSync(path.join(dir, "MANIFEST.json"), manifestText(buildManifest(entries, {})));
    assert.deepEqual(verifyManifest(dir).problems, []);
    assert.equal(noticesProblem(dir), undefined);
    // changing one byte of the notices fails the manifest check like any other shipped file
    writeFileSync(path.join(dir, NOTICES_NAME), `${written.toString("utf8")} `);
    assert.deepEqual(verifyManifest(dir).problems, [
      `size: ${NOTICES_NAME} expected ${written.length} got ${written.length + 1}`,
    ]);
  }));

test("writeNotices writes nothing when a component has no license text", () =>
  withTempDir((dir) => {
    makeRuntimeRoot(dir, { licenseless: ["numpy"] });
    assert.throws(() => writeNotices(lock, dir), /no license text found in numpy-/);
    assert.throws(() => readFileSync(path.join(dir, NOTICES_NAME)), /ENOENT/);
  }));
