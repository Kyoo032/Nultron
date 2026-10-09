// node --test apps/desktop/scripts/stage-ffmpeg.test.mjs
// scripts/stage-ffmpeg.mjs: the lock's shape, the refusals (non-https, wrong host, wrong hash, wrong size, an archive
// member that would leave the folder, a binary for the wrong platform) and the contracts between the lock, the
// package.json build scripts, the installer config, .gitignore and the macOS Docker route. Nothing here uses the
// network: downloads go through an injected fetch, and the archives are built in memory.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import {
  ALLOWED_HOSTS,
  assertSafeMemberPath,
  fetchPinned,
  LOCK_PATH,
  MANIFEST_NAME,
  outputNames,
  parseArgs,
  sha256Hex,
  sniffBinary,
  stageTarget,
  TARGETS,
  validateLock,
  verifyStaged,
} from "./stage-ffmpeg.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(HERE, "..");
const REPO = path.join(DESKTOP, "..", "..");
const read = (file) => readFileSync(file, "utf8");

// ---------------------------------------------------------------------------------------------
// Fixtures: a zip writer (stored and deflated entries), tiny PE and Mach-O headers, and a fake lock.
// ---------------------------------------------------------------------------------------------

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip with the given entries. `deflate: true` stores that entry compressed (method 8). */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data = Buffer.alloc(0), deflate = false } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const body = deflate ? deflateRawSync(data) : data;
    const method = deflate ? 8 : 0;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
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

/** The smallest buffer `sniffBinary` calls a 64-bit Windows program. `tail` makes two of them differ. */
function fakePe(tail = "") {
  const head = Buffer.alloc(0x100);
  head.write("MZ", 0, "latin1");
  head.writeUInt32LE(0x40, 0x3c);
  head.write("PE\u0000\u0000", 0x40, "latin1");
  head.writeUInt16LE(0x8664, 0x44);
  return Buffer.concat([head, Buffer.from(tail)]);
}

/** A 64-bit little-endian Mach-O header for `cpu` ("arm64" or "x86_64") with no load commands. */
function fakeMachO(cpu, tail = "") {
  const head = Buffer.alloc(32);
  head.writeUInt32LE(0xfeedfacf, 0);
  head.writeUInt32LE(cpu === "arm64" ? 0x0100000c : 0x01000007, 4);
  return Buffer.concat([head, Buffer.from(tail)]);
}

const LICENCE = Buffer.from("GNU GENERAL PUBLIC LICENSE\nVersion 3, fake text for tests\n");
const TOP = "ffmpeg-fake-win64-gpl";

/** A one-zip Windows lock and the archive bytes for it. */
function windowsFixture({
  ffmpeg = fakePe("ffmpeg"),
  ffprobe = fakePe("ffprobe"),
  extraEntries = [],
  deflate = false,
} = {}) {
  const zip = makeZip([
    { name: `${TOP}/`, data: Buffer.alloc(0) },
    { name: `${TOP}/bin/ffmpeg.exe`, data: ffmpeg, deflate },
    { name: `${TOP}/bin/ffprobe.exe`, data: ffprobe, deflate },
    { name: `${TOP}/bin/ffplay.exe`, data: fakePe("ffplay") },
    { name: `${TOP}/LICENSE.txt`, data: LICENCE, deflate },
    ...extraEntries,
  ]);
  const lock = {
    schema: 1,
    targets: {
      "win32-x64": {
        version: "fake-1.0",
        binary: "pe-x64",
        sources: [
          {
            url: "https://github.com/test/fake/releases/download/v1/fake-win64.zip",
            bytes: zip.length,
            sha256: sha256Hex(zip),
            format: "zip",
            hashFrom: "test fixture",
            members: [
              { path: `${TOP}/bin/ffmpeg.exe`, as: "ffmpeg.exe", bytes: ffmpeg.length, sha256: sha256Hex(ffmpeg) },
              { path: `${TOP}/bin/ffprobe.exe`, as: "ffprobe.exe", bytes: ffprobe.length, sha256: sha256Hex(ffprobe) },
              { path: `${TOP}/LICENSE.txt`, as: "LICENSE.txt", bytes: LICENCE.length, sha256: sha256Hex(LICENCE) },
            ],
          },
        ],
      },
    },
  };
  return { lock, zip };
}

/** A fetch that serves `files` by exact URL and records every URL it was asked for. */
function fakeFetch(files) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const body = files[String(url)];
    if (!body) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200 });
  };
  return { impl, calls };
}

function tempDirs() {
  const root = mkdtempSync(path.join(os.tmpdir(), "stage-ffmpeg-test-"));
  const out = path.join(root, "out");
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "README.md"), "tracked readme\n");
  return { root, out, cache: path.join(root, "cache"), done: () => rmSync(root, { recursive: true, force: true }) };
}

const quiet = () => {};

// ---------------------------------------------------------------------------------------------
// The real lock
// ---------------------------------------------------------------------------------------------

test("the committed lock is well formed and covers every target", () => {
  const lock = validateLock(JSON.parse(read(LOCK_PATH)));
  assert.deepEqual(Object.keys(lock.targets).sort(), [...TARGETS].sort());
  for (const [target, entry] of Object.entries(lock.targets)) {
    const names = outputNames(entry);
    const suffix = target.startsWith("win32") ? ".exe" : "";
    assert.deepEqual([...names].sort(), [`ffmpeg${suffix}`, `ffprobe${suffix}`, "LICENSE.txt"].sort(), target);
    for (const source of entry.sources) {
      const url = new URL(source.url);
      assert.equal(url.protocol, "https:", `${target}: https only`);
      assert.ok(ALLOWED_HOSTS.includes(url.hostname), `${target}: ${url.hostname} is an allowed host`);
      assert.match(source.sha256, /^[0-9a-f]{64}$/);
      assert.ok(Number.isSafeInteger(source.bytes) && source.bytes > 0);
      assert.ok(source.hashFrom.length > 10, `${target}: says where the hash came from`);
    }
  }
});

test("the Windows pin is the BtbN build named in the Dockerfile's sibling stage", () => {
  const lock = JSON.parse(read(LOCK_PATH));
  const [source] = lock.targets["win32-x64"].sources;
  assert.equal(
    source.url,
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/ffmpeg-n8.1.3-9-g29e619e767-win64-gpl-8.1.zip",
  );
  assert.equal(source.sha256, "7b801cdd3a1a0bb54ae6f572187e68b4ed54f52086cfee133fab2180bfb429fa");
  assert.equal(source.bytes, 193109593);
});

// ---------------------------------------------------------------------------------------------
// validateLock refusals
// ---------------------------------------------------------------------------------------------

function mutated(change) {
  const { lock } = windowsFixture();
  const copy = structuredClone(lock);
  change(copy.targets["win32-x64"], copy);
  return copy;
}

test("validateLock accepts the fixture and refuses each broken variation", () => {
  assert.doesNotThrow(() => validateLock(windowsFixture().lock));
  const bad = {
    "an http url": (t) => {
      t.sources[0].url = "http://github.com/test/fake.zip";
    },
    "a host that is not allowed": (t) => {
      t.sources[0].url = "https://evil.example/fake.zip";
    },
    "credentials in the url": (t) => {
      t.sources[0].url = "https://user:pw@github.com/test/fake.zip";
    },
    "a url with a query": (t) => {
      t.sources[0].url = "https://github.com/test/fake.zip?token=1";
    },
    "a short hash": (t) => {
      t.sources[0].sha256 = "abc123";
    },
    "an upper case hash": (t) => {
      t.sources[0].sha256 = "A".repeat(64);
    },
    "a zero byte count": (t) => {
      t.sources[0].bytes = 0;
    },
    "a fractional byte count": (t) => {
      t.sources[0].bytes = 10.5;
    },
    "a member path that climbs out": (t) => {
      t.sources[0].members[0].path = "../ffmpeg.exe";
    },
    "an absolute member path": (t) => {
      t.sources[0].members[0].path = "/etc/ffmpeg.exe";
    },
    "an output name that is not on the list": (t) => {
      t.sources[0].members[0].as = "evil.dll";
    },
    "an output name with a folder": (t) => {
      t.sources[0].members[0].as = "sub/ffmpeg.exe";
    },
    "a duplicate output name": (t) => {
      t.sources[0].members[1].as = "ffmpeg.exe";
    },
    "no ffprobe": (t) => {
      t.sources[0].members.splice(1, 1);
    },
    "no licence text": (t) => {
      t.sources[0].members.splice(2, 1);
    },
    "a darwin name on a windows target": (t) => {
      t.sources[0].members[0].as = "ffmpeg";
    },
    "an unknown format": (t) => {
      t.sources[0].format = "tar.xz";
    },
    "an unknown binary kind": (t) => {
      t.binary = "elf-x64";
    },
    "no sources": (t) => {
      t.sources = [];
    },
  };
  for (const [label, change] of Object.entries(bad)) {
    assert.throws(() => validateLock(mutated(change)), Error, label);
  }
  assert.throws(() => validateLock({ schema: 2, targets: {} }), /schema/);
  assert.throws(
    () => validateLock(mutated((_t, lock) => (lock.targets["linux-x64"] = lock.targets["win32-x64"]))),
    /unknown target/,
  );
});

// ---------------------------------------------------------------------------------------------
// assertSafeMemberPath
// ---------------------------------------------------------------------------------------------

test("assertSafeMemberPath keeps ordinary archive names and refuses anything that could leave the folder", () => {
  for (const ok of ["ffmpeg", "top/bin/ffmpeg.exe", "top/", "top/doc/a b.html", "./ffmpeg"]) {
    assert.doesNotThrow(() => assertSafeMemberPath(ok), ok);
  }
  for (const bad of [
    "",
    "../x",
    "a/../../x",
    "a/..",
    "/abs",
    "\\abs",
    "C:\\x",
    "C:/x",
    "a\\..\\..\\x",
    "a\u0000b",
    "//server/share",
  ]) {
    assert.throws(() => assertSafeMemberPath(bad), /unsafe|empty/, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------------------------
// sniffBinary
// ---------------------------------------------------------------------------------------------

test("sniffBinary names the platform a program was built for", () => {
  assert.equal(sniffBinary(fakePe()), "pe-x64");
  assert.equal(sniffBinary(fakeMachO("arm64")), "macho-arm64");
  assert.equal(sniffBinary(fakeMachO("x86_64")), "macho-x64");
  assert.equal(sniffBinary(Buffer.from("\u007fELF....")), "elf");
  assert.equal(sniffBinary(Buffer.from("hello")), "unknown");
  assert.equal(sniffBinary(Buffer.alloc(0)), "unknown");
});

// ---------------------------------------------------------------------------------------------
// parseArgs: nothing that decides what is downloaded comes from outside the lock
// ---------------------------------------------------------------------------------------------

test("parseArgs takes a target, a folder and flags, and refuses a url or a hash", () => {
  const parsed = parseArgs(["--target", "win32-x64", "--offline"]);
  assert.equal(parsed.target, "win32-x64");
  assert.equal(parsed.offline, true);
  assert.equal(parseArgs(["--verify"]).verify, true);
  assert.equal(parseArgs(["--verify", "--target", "darwin-arm64"]).target, "darwin-arm64");
  assert.throws(() => parseArgs(["--target"]), /needs a value/);
  assert.throws(() => parseArgs(["--target", "linux-x64"]), /target/);
  assert.throws(() => parseArgs(["--url", "https://github.com/x/y.zip"]), /unknown argument/);
  assert.throws(() => parseArgs(["--sha256", "a".repeat(64)]), /unknown argument/);
  assert.throws(() => parseArgs(["--bogus"]), /unknown argument/);
});

// ---------------------------------------------------------------------------------------------
// fetchPinned
// ---------------------------------------------------------------------------------------------

const PAYLOAD = Buffer.from("pinned payload bytes");
const PIN = {
  url: "https://github.com/test/fake.bin",
  sha256: sha256Hex(PAYLOAD),
  bytes: PAYLOAD.length,
  label: "fake.bin",
};

test("fetchPinned refuses a wrong hash, and no cache entry is written for it", async () => {
  const dirs = tempDirs();
  try {
    const cacheFile = path.join(dirs.cache, "fake.bin");
    const fetched = fakeFetch({ [PIN.url]: Buffer.from("tampered payload!!!!") });
    await assert.rejects(
      fetchPinned({ ...PIN, cacheFile, offline: false, fetchImpl: fetched.impl, attempts: 1 }),
      /sha256 mismatch/,
    );
    assert.equal(existsSync(cacheFile), false);
    assert.equal(existsSync(`${cacheFile}.part`), false);
  } finally {
    dirs.done();
  }
});

test("fetchPinned refuses a wrong size, a non-https url, and a body longer than the pin", async () => {
  const dirs = tempDirs();
  try {
    const cacheFile = path.join(dirs.cache, "fake.bin");
    const wrongHashAndSize = fakeFetch({ [PIN.url]: Buffer.concat([PAYLOAD, Buffer.from("!")]) });
    await assert.rejects(
      fetchPinned({ ...PIN, cacheFile, offline: false, fetchImpl: wrongHashAndSize.impl, attempts: 1 }),
      /larger than the pinned|sha256 mismatch|size mismatch/,
    );
    const calls = [];
    await assert.rejects(
      fetchPinned({
        ...PIN,
        url: "http://github.com/test/fake.bin",
        cacheFile,
        offline: false,
        fetchImpl: async (url) => {
          calls.push(url);
          return new Response(PAYLOAD);
        },
        attempts: 1,
      }),
      /https/,
    );
    assert.deepEqual(calls, [], "an http url is refused before any request");
    // A redirect that ends on http is refused too.
    await assert.rejects(
      fetchPinned({
        ...PIN,
        cacheFile,
        offline: false,
        fetchImpl: async () => {
          const response = new Response(PAYLOAD);
          Object.defineProperty(response, "url", { value: "http://downgraded.example/fake.bin" });
          return response;
        },
        attempts: 1,
      }),
      /https/,
    );
    assert.equal(existsSync(cacheFile), false);
  } finally {
    dirs.done();
  }
});

test("fetchPinned writes the cache after the check, reuses it, and never goes online with --offline", async () => {
  const dirs = tempDirs();
  try {
    const cacheFile = path.join(dirs.cache, "fake.bin");
    const fetched = fakeFetch({ [PIN.url]: PAYLOAD });
    const first = await fetchPinned({ ...PIN, cacheFile, offline: false, fetchImpl: fetched.impl, attempts: 1 });
    assert.equal(first.fromCache, false);
    assert.ok(first.data.equals(PAYLOAD));
    assert.equal(readFileSync(cacheFile).toString(), PAYLOAD.toString());
    const second = await fetchPinned({ ...PIN, cacheFile, offline: false, fetchImpl: fetched.impl, attempts: 1 });
    assert.equal(second.fromCache, true);
    assert.deepEqual(fetched.calls, [PIN.url], "one request in all");

    writeFileSync(cacheFile, "corrupted");
    await assert.rejects(
      fetchPinned({ ...PIN, cacheFile, offline: true, fetchImpl: fetched.impl, attempts: 1 }),
      /--offline.*corrupt/,
    );
    assert.equal(existsSync(cacheFile), false, "a corrupt entry is removed");
    await assert.rejects(
      fetchPinned({ ...PIN, cacheFile, offline: true, fetchImpl: fetched.impl, attempts: 1 }),
      /--offline.*not in the cache/,
    );
    assert.deepEqual(fetched.calls, [PIN.url], "offline made no request");
  } finally {
    dirs.done();
  }
});

// ---------------------------------------------------------------------------------------------
// stageTarget
// ---------------------------------------------------------------------------------------------

test("stageTarget writes the pinned files, a manifest, and leaves the README alone", async () => {
  const dirs = tempDirs();
  try {
    for (const deflate of [false, true]) {
      const { lock, zip } = windowsFixture({ deflate });
      const url = lock.targets["win32-x64"].sources[0].url;
      const fetched = fakeFetch({ [url]: zip });
      const manifest = await stageTarget({
        lock,
        target: "win32-x64",
        out: dirs.out,
        cache: dirs.cache,
        offline: false,
        fetchImpl: fetched.impl,
        log: quiet,
      });
      assert.deepEqual(
        readdirSync(dirs.out).sort(),
        ["LICENSE.txt", MANIFEST_NAME, "README.md", "ffmpeg.exe", "ffprobe.exe"].sort(),
      );
      assert.equal(read(path.join(dirs.out, "README.md")), "tracked readme\n");
      assert.ok(readFileSync(path.join(dirs.out, "ffmpeg.exe")).equals(fakePe("ffmpeg")));
      assert.equal(manifest.target, "win32-x64");
      assert.equal(manifest.ffmpegVersion, "fake-1.0");
      const listed = Object.fromEntries(manifest.files.map((file) => [file.name, file.sha256]));
      assert.equal(listed["ffmpeg.exe"], sha256Hex(fakePe("ffmpeg")));
      assert.equal(listed["LICENSE.txt"], sha256Hex(LICENCE));
      assert.deepEqual(JSON.parse(read(path.join(dirs.out, MANIFEST_NAME))), manifest);
      assert.deepEqual(fetched.calls, [url]);
      assert.equal(verifyStaged({ lock, out: dirs.out }).ok, true);
    }
  } finally {
    dirs.done();
  }
});

test("stageTarget ignores FFMPEG_URL and similar environment variables", async () => {
  const dirs = tempDirs();
  const names = ["FFMPEG_URL", "FFMPEG_SHA256", "AGENTFORGE_FFMPEG_URL"];
  try {
    process.env.FFMPEG_URL = "https://evil.example/ffmpeg.zip";
    process.env.FFMPEG_SHA256 = "0".repeat(64);
    process.env.AGENTFORGE_FFMPEG_URL = "https://evil.example/ffmpeg.zip";
    const { lock, zip } = windowsFixture();
    const url = lock.targets["win32-x64"].sources[0].url;
    const fetched = fakeFetch({ [url]: zip });
    await stageTarget({
      lock,
      target: "win32-x64",
      out: dirs.out,
      cache: dirs.cache,
      offline: false,
      fetchImpl: fetched.impl,
      log: quiet,
    });
    assert.deepEqual(fetched.calls, [url]);
  } finally {
    for (const name of names) delete process.env[name];
    dirs.done();
  }
});

test("stageTarget refuses an archive with the wrong hash and leaves the folder untouched", async () => {
  const dirs = tempDirs();
  try {
    const { lock, zip } = windowsFixture();
    const url = lock.targets["win32-x64"].sources[0].url;
    const tampered = Buffer.from(zip);
    tampered[40] ^= 0xff;
    const fetched = fakeFetch({ [url]: tampered });
    await assert.rejects(
      stageTarget({
        lock,
        target: "win32-x64",
        out: dirs.out,
        cache: dirs.cache,
        offline: false,
        fetchImpl: fetched.impl,
        log: quiet,
        attempts: 1,
      }),
      /sha256 mismatch/,
    );
    assert.deepEqual(readdirSync(dirs.out), ["README.md"]);
  } finally {
    dirs.done();
  }
});

test("stageTarget refuses an archive that has a member whose path would leave the folder", async () => {
  const dirs = tempDirs();
  try {
    const evil = { name: "../../outside/evil.dll", data: Buffer.from("x") };
    const { lock, zip } = windowsFixture({ extraEntries: [evil] });
    const url = lock.targets["win32-x64"].sources[0].url;
    const fetched = fakeFetch({ [url]: zip });
    await assert.rejects(
      stageTarget({
        lock,
        target: "win32-x64",
        out: dirs.out,
        cache: dirs.cache,
        offline: false,
        fetchImpl: fetched.impl,
        log: quiet,
      }),
      /unsafe/,
    );
    assert.deepEqual(readdirSync(dirs.out), ["README.md"]);
    assert.equal(existsSync(path.join(dirs.root, "outside")), false);
  } finally {
    dirs.done();
  }
});

test("stageTarget refuses a member whose hash, size or presence differs from the lock", async () => {
  const cases = {
    "a member hash that differs": (lock) => {
      lock.targets["win32-x64"].sources[0].members[0].sha256 = "1".repeat(64);
    },
    "a member size that differs": (lock) => {
      lock.targets["win32-x64"].sources[0].members[0].bytes += 1;
    },
    "a member that is not in the archive": (lock) => {
      lock.targets["win32-x64"].sources[0].members[0].path = `${TOP}/bin/missing.exe`;
    },
  };
  for (const [label, change] of Object.entries(cases)) {
    const dirs = tempDirs();
    try {
      const { lock, zip } = windowsFixture();
      change(lock);
      const url = lock.targets["win32-x64"].sources[0].url;
      const fetched = fakeFetch({ [url]: zip });
      await assert.rejects(
        stageTarget({
          lock,
          target: "win32-x64",
          out: dirs.out,
          cache: dirs.cache,
          offline: false,
          fetchImpl: fetched.impl,
          log: quiet,
        }),
        Error,
        label,
      );
      assert.deepEqual(readdirSync(dirs.out), ["README.md"], label);
    } finally {
      dirs.done();
    }
  }
});

test("stageTarget refuses a program built for another platform even when its hash is the pinned one", async () => {
  const dirs = tempDirs();
  try {
    const { lock, zip } = windowsFixture({ ffmpeg: fakeMachO("arm64", "oops, a mac build in the windows lock") });
    const url = lock.targets["win32-x64"].sources[0].url;
    const fetched = fakeFetch({ [url]: zip });
    await assert.rejects(
      stageTarget({
        lock,
        target: "win32-x64",
        out: dirs.out,
        cache: dirs.cache,
        offline: false,
        fetchImpl: fetched.impl,
        log: quiet,
      }),
      /pe-x64/,
    );
    assert.deepEqual(readdirSync(dirs.out), ["README.md"]);
  } finally {
    dirs.done();
  }
});

test("staging another target replaces the previous target's programs", async () => {
  const dirs = tempDirs();
  try {
    const win = windowsFixture();
    const winUrl = win.lock.targets["win32-x64"].sources[0].url;
    const macProgram = fakeMachO("arm64", "ffmpeg");
    const macProbe = fakeMachO("arm64", "ffprobe");
    const macZip = (name, data) => makeZip([{ name, data, deflate: true }]);
    const lock = structuredClone(win.lock);
    lock.targets["darwin-arm64"] = {
      version: "fake-9.0",
      binary: "macho-arm64",
      sources: [
        {
          url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1_9/ffmpeg.zip",
          format: "zip",
          hashFrom: "test fixture",
          members: [{ path: "ffmpeg", as: "ffmpeg", bytes: macProgram.length, sha256: sha256Hex(macProgram) }],
        },
        {
          url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1_9/ffprobe.zip",
          format: "zip",
          hashFrom: "test fixture",
          members: [{ path: "ffprobe", as: "ffprobe", bytes: macProbe.length, sha256: sha256Hex(macProbe) }],
        },
        {
          url: "https://raw.githubusercontent.com/FFmpeg/FFmpeg/n9.0.2/COPYING.GPLv3",
          format: "file",
          as: "LICENSE.txt",
          hashFrom: "test fixture",
          bytes: LICENCE.length,
          sha256: sha256Hex(LICENCE),
        },
      ],
    };
    const ffmpegZip = macZip("ffmpeg", macProgram);
    const ffprobeZip = macZip("ffprobe", macProbe);
    const sources = lock.targets["darwin-arm64"].sources;
    sources[0].bytes = ffmpegZip.length;
    sources[0].sha256 = sha256Hex(ffmpegZip);
    sources[1].bytes = ffprobeZip.length;
    sources[1].sha256 = sha256Hex(ffprobeZip);
    validateLock(lock);
    const fetched = fakeFetch({
      [winUrl]: win.zip,
      [sources[0].url]: ffmpegZip,
      [sources[1].url]: ffprobeZip,
      [sources[2].url]: LICENCE,
    });

    const common = { lock, out: dirs.out, cache: dirs.cache, offline: false, fetchImpl: fetched.impl, log: quiet };
    await stageTarget({ ...common, target: "win32-x64" });
    assert.ok(existsSync(path.join(dirs.out, "ffmpeg.exe")));
    await stageTarget({ ...common, target: "darwin-arm64" });
    assert.deepEqual(
      readdirSync(dirs.out).sort(),
      ["LICENSE.txt", MANIFEST_NAME, "README.md", "ffmpeg", "ffprobe"].sort(),
    );
    assert.equal(JSON.parse(read(path.join(dirs.out, MANIFEST_NAME))).target, "darwin-arm64");
    assert.equal(verifyStaged({ lock, out: dirs.out, target: "darwin-arm64" }).ok, true);
    const wrongTarget = verifyStaged({ lock, out: dirs.out, target: "win32-x64" });
    assert.equal(wrongTarget.ok, false);
    assert.match(wrongTarget.problems.join("\n"), /darwin-arm64/);
  } finally {
    dirs.done();
  }
});

// ---------------------------------------------------------------------------------------------
// verifyStaged
// ---------------------------------------------------------------------------------------------

async function staged() {
  const dirs = tempDirs();
  const { lock, zip } = windowsFixture();
  const url = lock.targets["win32-x64"].sources[0].url;
  await stageTarget({
    lock,
    target: "win32-x64",
    out: dirs.out,
    cache: dirs.cache,
    offline: false,
    fetchImpl: fakeFetch({ [url]: zip }).impl,
    log: quiet,
  });
  return { dirs, lock };
}

test("verifyStaged reports a folder that was never staged", () => {
  const dirs = tempDirs();
  try {
    const result = verifyStaged({ lock: windowsFixture().lock, out: dirs.out });
    assert.equal(result.ok, false);
    assert.match(result.problems.join("\n"), /not staged|MANIFEST/);
    const missingDir = verifyStaged({ lock: windowsFixture().lock, out: path.join(dirs.root, "nope") });
    assert.equal(missingDir.ok, false);
  } finally {
    dirs.done();
  }
});

test("verifyStaged catches a changed, missing, extra or substituted file", async () => {
  const { dirs, lock } = await staged();
  try {
    assert.equal(verifyStaged({ lock, out: dirs.out }).ok, true);

    writeFileSync(path.join(dirs.out, "ffmpeg.exe"), fakePe("not what was pinned"));
    assert.match(verifyStaged({ lock, out: dirs.out }).problems.join("\n"), /ffmpeg\.exe/);

    rmSync(path.join(dirs.out, "ffprobe.exe"));
    assert.match(verifyStaged({ lock, out: dirs.out }).problems.join("\n"), /missing: ffprobe\.exe/);

    writeFileSync(path.join(dirs.out, "ffplay.exe"), fakePe("ffplay"));
    assert.match(verifyStaged({ lock, out: dirs.out }).problems.join("\n"), /unlisted: ffplay\.exe/);
  } finally {
    dirs.done();
  }
});

test("verifyStaged does not trust a manifest that disagrees with the lock", async () => {
  const { dirs, lock } = await staged();
  try {
    // Edit the program and the manifest together: the lock still pins the old hash.
    const evil = fakePe("substituted");
    writeFileSync(path.join(dirs.out, "ffmpeg.exe"), evil);
    const manifestPath = path.join(dirs.out, MANIFEST_NAME);
    const manifest = JSON.parse(read(manifestPath));
    for (const file of manifest.files) {
      if (file.name === "ffmpeg.exe") Object.assign(file, { bytes: evil.length, sha256: sha256Hex(evil) });
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.match(verifyStaged({ lock, out: dirs.out }).problems.join("\n"), /lock/);
  } finally {
    dirs.done();
  }
});

// ---------------------------------------------------------------------------------------------
// Contracts with the build config
// ---------------------------------------------------------------------------------------------

const pkg = JSON.parse(read(path.join(DESKTOP, "package.json")));

test("extraResources still maps resources/ffmpeg to ffmpeg", () => {
  const entry = pkg.build.extraResources.find((item) => item.from === "resources/ffmpeg");
  assert.ok(entry, "resources/ffmpeg is in extraResources");
  assert.equal(entry.to, "ffmpeg");
});

test("every Windows pack script stages ffmpeg before it packs", () => {
  const stage = "node scripts/stage-ffmpeg.mjs --target win32-x64";
  for (const name of ["desktop-build", "desktop-build-all", "desktop-pack", "desktop-build-dir"]) {
    const script = pkg.scripts[name];
    assert.ok(script.includes(stage), `${name} stages win32-x64`);
    const pack = Math.min(
      ...["pack-brand.mjs", "electron-builder", "pack-all-brands.mjs"].map((s) =>
        script.indexOf(s) < 0 ? Infinity : script.indexOf(s),
      ),
    );
    assert.ok(script.indexOf(stage) < pack, `${name} stages before it packs`);
  }
  assert.ok(pkg.scripts.test.includes("stage-ffmpeg.test.mjs"), "the desktop test script runs this file");
});

test("every other script that runs electron-builder is either wired or named as exempt", () => {
  const exempt = new Set([
    "desktop-build-mac",
    "desktop-build-mac-dir",
    "desktop-build-linux",
    "desktop-build-linux-dir",
  ]);
  for (const [name, script] of Object.entries(pkg.scripts)) {
    if (!/electron-builder|pack-brand\.mjs|pack-all-brands\.mjs/.test(script)) continue;
    if (script.includes("stage-ffmpeg.mjs")) continue;
    assert.ok(exempt.has(name), `${name} packs without staging ffmpeg and is not on the exempt list`);
  }
});

test("the macOS Docker route stages and verifies the right program for each arch", () => {
  const script = read(path.join(DESKTOP, "platform", "macos", "docker", "build-mac.sh"));
  assert.match(script, /stage-ffmpeg\.mjs --target "darwin-\$arch"/);
  assert.match(
    script,
    /stage-ffmpeg\.mjs"? --verify --target "darwin-\$arch" --out "\$APP\/Contents\/Resources\/ffmpeg"/,
  );
});

test(".gitignore keeps staged programs and the download cache out of git but keeps the README", () => {
  const ignore = read(path.join(REPO, ".gitignore")).split(/\r?\n/);
  assert.ok(ignore.includes("apps/desktop/resources/ffmpeg/*"));
  assert.ok(ignore.includes("!apps/desktop/resources/ffmpeg/README.md"));
  assert.ok(ignore.includes("vendor/.ffmpeg-cache/"));
});

test("the pack skill's preflight checks the lock and can require a staged folder", () => {
  const preflight = read(path.join(REPO, ".cursor", "skills", "pack-nultron", "scripts", "preflight.mjs"));
  assert.match(preflight, /stage-ffmpeg\.mjs/);
  assert.match(preflight, /--require-ffmpeg/);
  assert.match(preflight, /verifyStaged/);
});

test("sha256Hex is sha-256", () => {
  assert.equal(sha256Hex("abc"), createHash("sha256").update("abc").digest("hex"));
});
