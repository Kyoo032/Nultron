// Third-party notices for the code-sandbox runtime folder (scripts/build-sandbox-runtime.mjs writes the result as
// THIRD_PARTY_NOTICES.txt at the folder's root, so it ships in resources/sandbox and /app/sandbox with everything else).
//
// Where each license text comes from, all of it pinned:
//   - the Python wheels: their own `*.dist-info/` license files, read out of the wheel (a sha256-pinned zip);
//   - the three QuickJS npm packages: the LICENSE file the lock already pins and the build already copied;
//   - Pyodide and CPython, whose npm package carries no license file: the two committed files beside this one,
//     each with a header (component, version, license, source URL, sha256 of the text) and a body that is the
//     upstream file byte for byte, LF endings. The lock pins the same sha256, and a header whose version is
//     not the lock's version is refused, so a version bump cannot ship a stale text.
//
// The zip reader is small on purpose: the build script runs in the image's build stage and in the packaging
// scripts, where only Node's own modules are certain to resolve (jszip lives in packages/core, not at the root).
// Everything here is pure (Buffers and strings in, strings out) except `collectNoticeComponents`, which reads files.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { byCodeUnit, PYODIDE_DIR } from "../sandbox-runtime-lock.mjs";

export const NOTICES_NAME = "THIRD_PARTY_NOTICES.txt";
export const LICENSES_DIR = path.dirname(fileURLToPath(import.meta.url));
/** The line that ends the header of a committed license file; the body is everything after it. */
export const LICENSE_TEXT_MARKER = "----- LICENSE TEXT FOLLOWS -----";
const REQUIRED_HEADER = ["Component", "Version", "License", "Source", "Source-SHA256"];

const MAX_LICENSE_BYTES = 256 * 1024;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const RULE = "=".repeat(80);
const THIN = "-".repeat(80);

const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

// ---------------------------------------------------------------------------------------------
// A zip reader (central directory, stored and deflated entries)
// ---------------------------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** `{name, method, flags, compressedSize, size, offset}` for every entry of the zip in `zip`. */
export function readZipEntries(zip, label = "zip") {
  const fail = (why) => {
    throw new Error(`${label}: not a readable zip file (${why})`);
  };
  if (!Buffer.isBuffer(zip) || zip.length < 22) fail("too short");
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i -= 1) {
    if (zip.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fail("no end-of-central-directory record");
  const count = zip.readUInt16LE(eocd + 10);
  const dirSize = zip.readUInt32LE(eocd + 12);
  let at = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || dirSize === 0xffffffff || at === 0xffffffff) fail("zip64 is not supported");
  const entries = [];
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== CENTRAL_SIG) fail(`bad central directory entry ${n}`);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const nameEnd = at + 46 + nameLength;
    if (nameEnd > zip.length) fail(`entry ${n} runs past the end of the file`);
    entries.push({
      name: zip.toString("utf8", at + 46, nameEnd),
      flags: zip.readUInt16LE(at + 8),
      method: zip.readUInt16LE(at + 10),
      compressedSize: zip.readUInt32LE(at + 20),
      size: zip.readUInt32LE(at + 24),
      offset: zip.readUInt32LE(at + 42),
    });
    at = nameEnd + extraLength + commentLength;
  }
  return entries;
}

/** The bytes of one entry. An entry larger than `maxBytes`, an encrypted one or an unknown method is refused. */
export function readZipEntry(zip, entry, label = "zip", maxBytes = MAX_LICENSE_BYTES) {
  const fail = (why) => {
    throw new Error(`${label}: cannot read ${entry.name} (${why})`);
  };
  if (entry.flags & 1) fail("encrypted");
  if (entry.size > maxBytes) fail(`${entry.size} bytes, more than the ${maxBytes} byte limit`);
  if (entry.offset + 30 > zip.length || zip.readUInt32LE(entry.offset) !== LOCAL_SIG) fail("bad local header");
  const start = entry.offset + 30 + zip.readUInt16LE(entry.offset + 26) + zip.readUInt16LE(entry.offset + 28);
  const end = start + entry.compressedSize;
  if (end > zip.length) fail("truncated");
  const raw = zip.subarray(start, end);
  let data;
  if (entry.method === 0) data = Buffer.from(raw);
  else if (entry.method === 8) {
    try {
      data = inflateRawSync(raw, { maxOutputLength: maxBytes });
    } catch (error) {
      fail(`inflate failed: ${error.message}`);
    }
  } else fail(`compression method ${entry.method} is not supported`);
  if (data.length !== entry.size) fail(`expected ${entry.size} bytes, got ${data.length}`);
  return data;
}

// ---------------------------------------------------------------------------------------------
// License text
// ---------------------------------------------------------------------------------------------

/**
 * A license file's bytes as the text the notices carry: UTF-8, LF line endings, no BOM, no trailing blank space.
 * Throws, naming `label`, on text that is not UTF-8, holds a NUL (a binary file) or is empty.
 */
export function licenseTextFrom(data, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error(`${label}: the license text is not valid UTF-8`);
  }
  text = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (text.includes("\u0000")) throw new Error(`${label}: the license text is binary`);
  const trimmed = text.replace(/\s+$/, "");
  if (trimmed === "") throw new Error(`${label}: the license text is empty`);
  return trimmed;
}

const WHEEL_LICENSE_NAME = /^(?:LICEN[CS]E|COPYING|NOTICE)(?:[-_.][^/]*)?$/i;

/** The entries of a wheel that are license files: top-level LICENSE/COPYING/NOTICE files and a `licenses/` tree (PEP 639). */
export function wheelLicenseEntries(entries) {
  return entries
    .filter((entry) => {
      const inside = /^[^/]+\.dist-info\/(.+)$/.exec(entry.name)?.[1];
      if (!inside || inside.endsWith("/")) return false;
      return /^licen[cs]es\//i.test(inside) || WHEEL_LICENSE_NAME.test(inside);
    })
    .sort((a, b) => byCodeUnit(a.name, b.name));
}

/** `[{label, text}]` for every license file inside a wheel; throws when the wheel has none. */
export function wheelLicenses(wheel, label) {
  const entries = readZipEntries(wheel, label);
  const picked = wheelLicenseEntries(entries);
  if (picked.length === 0) {
    throw new Error(
      `no license text found in ${label}: it has no LICENSE, COPYING or NOTICE file under its .dist-info/ directory`,
    );
  }
  return picked.map((entry) => ({
    label: entry.name.replace(/^[^/]+\.dist-info\//, ""),
    text: licenseTextFrom(readZipEntry(wheel, entry, label), `${label}: ${entry.name}`),
  }));
}

/** The license a wheel's METADATA declares (License-Expression, else a one-line License), or undefined. */
export function wheelMetadataLicense(wheel, label) {
  const entry = readZipEntries(wheel, label).find((e) => /^[^/]+\.dist-info\/METADATA$/.test(e.name));
  if (!entry) return undefined;
  const head = readZipEntry(wheel, entry, label, MAX_METADATA_BYTES)
    .toString("utf8")
    .split(/\r?\n\r?\n/)[0];
  const field = (name) => new RegExp(`^${name}: (.+)$`, "m").exec(head)?.[1].trim();
  const expression = field("License-Expression");
  if (expression) return expression;
  const plain = field("License");
  return plain && plain.length <= 100 ? plain : undefined;
}

/**
 * A committed license file (header, marker line, upstream text) as `{meta, text}`. The text below the marker must
 * hash to the header's Source-SHA256; `meta` is the header's `Key: value` lines. The hash is of the text with LF
 * line endings, so a checkout that turned them into CRLF still verifies.
 */
export function parseLicenseFile(raw, label) {
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const marker = new RegExp(`^${LICENSE_TEXT_MARKER}$`, "m").exec(text);
  if (!marker) throw new Error(`${label}: no "${LICENSE_TEXT_MARKER}" line`);
  const meta = {};
  for (const line of text.slice(0, marker.index).split("\n")) {
    const match = /^([A-Za-z][A-Za-z0-9-]*): (.*)$/.exec(line);
    if (match) meta[match[1]] = match[2].trim();
  }
  for (const key of REQUIRED_HEADER) {
    if (!meta[key]) throw new Error(`${label}: the header is missing "${key}:"`);
  }
  if (!/^https:\/\//.test(meta.Source)) throw new Error(`${label}: Source must be an https URL`);
  const body = text.slice(marker.index + LICENSE_TEXT_MARKER.length + 1);
  const actual = sha256Hex(body);
  if (actual !== meta["Source-SHA256"]) {
    throw new Error(
      `${label}: the text hashes to ${actual}, but the header says Source-SHA256: ${meta["Source-SHA256"]}`,
    );
  }
  return { meta, text: licenseTextFrom(Buffer.from(body, "utf8"), label) };
}

/**
 * One committed license text: `spec` is a lock entry `{license, file, sha256}`, `expect` is `{name, version}` of the
 * component it must be for. Refuses a missing file, a text that does not match the lock's pin and a stale version.
 */
export function loadLicenseText(dir, spec, expect) {
  const where = `scripts/sandbox-licenses/${spec.file}`;
  const file = path.join(dir, spec.file);
  if (!existsSync(file)) {
    throw new Error(
      `license text for ${expect.name} is missing: ${where}. It is committed with the build script: restore it, ` +
        `or fetch the LICENSE of ${expect.name} ${expect.version} and add the header described in scripts/sandbox-licenses/notices.mjs.`,
    );
  }
  const { meta, text } = parseLicenseFile(readFileSync(file, "utf8"), where);
  if (meta.Version !== expect.version) {
    throw new Error(
      `${where} is the license of ${expect.name} ${meta.Version}, but the lock pins ${expect.version}: ` +
        "fetch the LICENSE at the new version, update the file's header and the lock's licenses entry.",
    );
  }
  if (meta["Source-SHA256"] !== spec.sha256) {
    throw new Error(
      `sha256 mismatch for ${where}: the lock pins ${spec.sha256}, the file's text is ${meta["Source-SHA256"]}`,
    );
  }
  return { label: `${meta.Source}`, text };
}

// ---------------------------------------------------------------------------------------------
// The notices file
// ---------------------------------------------------------------------------------------------

/**
 * The components of the runtime folder with their license texts, read from the built folder `root` (wheels and
 * the QuickJS LICENSE files, already copied and hash-checked) and from the committed files in `licensesDir`.
 * `{name, version, license, homepage?, covers, note?, texts: [{label, text}]}`, in the order the notices list them.
 */
export function collectNoticeComponents(lock, { root, licensesDir = LICENSES_DIR }) {
  const py = lock.pyodide;
  const lic = lock.licenses;
  const core = (file) => `${PYODIDE_DIR}/${file}`;
  const components = [
    {
      name: "Pyodide",
      version: py.version,
      license: lic.pyodide.license,
      homepage: lic.pyodide.homepage,
      covers: [core("pyodide.mjs"), core("pyodide.asm.mjs"), core("pyodide.asm.wasm"), core("pyodide-lock.json")],
      note:
        `Source code: ${lic.pyodide.homepage} (tag ${py.version}). The files are the ones in the pyodide@${py.version} npm package; ` +
        `pyodide-lock.json is that package's lock file cut down to the ${py.wheels.length} wheels listed below.`,
      texts: [loadLicenseText(licensesDir, lic.pyodide, { name: "Pyodide", version: py.version })],
    },
    {
      name: "CPython",
      version: py.python,
      license: lic.cpython.license,
      homepage: lic.cpython.homepage,
      covers: [core("python_stdlib.zip"), `the interpreter compiled into ${core("pyodide.asm.wasm")}`],
      texts: [loadLicenseText(licensesDir, lic.cpython, { name: "CPython", version: py.python })],
    },
  ];
  for (const wheel of py.wheels) {
    const label = wheel.file;
    components.push({
      name: wheel.name,
      version: wheel.version,
      license: lic.wheels[wheel.name],
      covers: [core(wheel.file)],
      texts: wheelLicenses(readFileSync(path.join(root, ...core(wheel.file).split("/"))), label),
    });
  }
  const quickjs = lock.quickjs.packages;
  components.push({
    name: "quickjs-emscripten",
    version: quickjs[0].version,
    license: "MIT",
    homepage: "https://github.com/justjake/quickjs-emscripten",
    covers: quickjs.map((pkg) => `node_modules/${pkg.name}/`),
    texts: quickjs.map((pkg) => {
      const file = `node_modules/${pkg.name}/LICENSE`;
      return {
        label: `${pkg.name}@${pkg.version} LICENSE`,
        text: licenseTextFrom(readFileSync(path.join(root, ...file.split("/"))), file),
      };
    }),
  });
  return components;
}

/** Texts with identical content merged, their labels joined; first-seen order. */
function mergedTexts(texts) {
  const byText = new Map();
  for (const { label, text } of texts) {
    const labels = byText.get(text) ?? [];
    byText.set(text, [...labels, label]);
  }
  return [...byText].map(([text, labels]) => ({ labels, text }));
}

function assertNoticeComponent(component) {
  const who = `third-party notices: ${component.name} ${component.version}`;
  if (!component.license) throw new Error(`${who}: no license name`);
  if (!Array.isArray(component.texts) || component.texts.length === 0) throw new Error(`${who}: no license text`);
  for (const { label, text } of component.texts) {
    if (typeof text !== "string" || text.trim() === "") throw new Error(`${who}: the license text ${label} is empty`);
  }
}

function componentSection(component) {
  const lines = [RULE, `${component.name} ${component.version}`, `License: ${component.license}`];
  if (component.homepage) lines.push(`Home: ${component.homepage}`);
  lines.push("Covers:", ...component.covers.map((item) => `  - ${item}`));
  if (component.note) lines.push(component.note);
  for (const { labels, text } of mergedTexts(component.texts)) {
    lines.push(THIN, `License text: ${labels.join(", ")}`, "", text, "");
  }
  return lines;
}

/** The notices file's text: a list of the components, then each one's license texts. Deterministic. */
export function buildNoticesText(components) {
  if (!Array.isArray(components) || components.length === 0) throw new Error("third-party notices: no components");
  for (const component of components) assertNoticeComponent(component);
  const lines = [
    "THIRD-PARTY NOTICES",
    "===================",
    "",
    "This folder is the code-sandbox runtime of Nultron. It ships the third-party software listed below, each under",
    "its own license, whose full text follows the list. Nultron's own code in this folder (py-child.mjs and",
    "qjs-child.mjs) is not covered by this file.",
    "",
    "vendor/pyodide/pyc-cache.json.gz, when present, is byte-code compiled from the Python packages below and is",
    "covered by their licenses.",
    "",
    "Generated by scripts/build-sandbox-runtime.mjs from scripts/sandbox-runtime.lock.json. The texts come from the",
    "license files inside the pinned wheels and npm packages and from scripts/sandbox-licenses/. Do not edit by hand.",
    "",
    "Components",
    "----------",
    ...components.map((c, i) => `${i + 1}. ${c.name} ${c.version} - ${c.license}`),
    "",
  ];
  for (const component of components) lines.push(...componentSection(component));
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}
