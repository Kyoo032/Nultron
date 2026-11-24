import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildNixArgs, parseArgs, toWslMountPath, WARM_INSTALLABLES } from "./nix-ci.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function localImportsOf(repoRelPath) {
  const text = readFileSync(path.join(REPO_ROOT, repoRelPath), "utf8");
  const matches = [
    ...text.matchAll(/(?:import|export)\s+[\s\S]*?\sfrom\s+["'](\.{1,2}\/[^"']+)["']/g),
    ...text.matchAll(/\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g),
  ];
  return matches.map((m) => path.posix.normalize(path.posix.join(path.posix.dirname(repoRelPath), m[1])));
}

function transitiveLocalImports(entryRepoRelPath) {
  const visited = new Set();
  const queue = [entryRepoRelPath];
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    for (const target of localImportsOf(current)) {
      if (!visited.has(target)) queue.push(target);
    }
  }
  return [...visited].sort();
}

function extractSandboxFilesetPaths(nixText) {
  const start = nixText.indexOf("sandbox = mkSource (");
  assert.ok(start >= 0, "sandbox fileset not found in nix/pkgs/workspace-filesets.nix");
  const block = nixText.slice(start, nixText.indexOf(");", start));
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function isCoveredByFileset(filePath, filesetEntries) {
  return filesetEntries.some((entry) => filePath === entry || filePath.startsWith(`${entry}/`));
}

test("parseArgs selects fast, full, warm-cache, and local-cache flags", () => {
  assert.equal(parseArgs([]).mode, "fast");
  assert.equal(parseArgs(["--full"]).mode, "full");
  const warm = parseArgs(["--warm-cache", "--local-cache", "/var/cache/nultron-nix", "--no-gc-roots"]);
  assert.equal(warm.mode, "warm-cache");
  assert.equal(warm.localCache, "/var/cache/nultron-nix");
  assert.equal(warm.gcRoots, false);
  assert.throws(() => parseArgs(["--local-cache"]), /needs a value/);
  assert.throws(() => parseArgs(["--bogus"]), /unknown argument/);
});

test("toWslMountPath converts Windows drive paths cleanly", () => {
  assert.equal(toWslMountPath("C:\\Users\\rizky\\Documents\\nultron"), "/mnt/c/Users/rizky/Documents/nultron");
});

test("buildNixArgs creates expected Nix commands for fast, full, and warm-cache modes", () => {
  const fast = buildNixArgs(parseArgs(["--fast"]));
  assert.deepEqual(fast, [["build", ".#ci-fast", "-L", "--keep-going", "--out-link", ".nix-ci-roots/ci-fast"]]);

  const full = buildNixArgs(parseArgs(["--full", "--local-cache", "/tmp/cache"]));
  assert.deepEqual(full, [
    ["flake", "check", "-L", "--keep-going", "--extra-substituters", "file:///tmp/cache?trusted=1"],
  ]);

  const warm = buildNixArgs(parseArgs(["--warm-cache", "--no-gc-roots"]));
  assert.equal(warm.length, WARM_INSTALLABLES.length);
  assert.ok(warm[0].includes("--no-link"));
});

test("workspace-filesets.nix sandbox fileset covers every local import and license file of build-sandbox-runtime.mjs", () => {
  const nixText = readFileSync(path.join(REPO_ROOT, "nix", "pkgs", "workspace-filesets.nix"), "utf8");
  const filesetEntries = extractSandboxFilesetPaths(nixText);
  const imports = transitiveLocalImports("scripts/build-sandbox-runtime.mjs");
  assert.ok(imports.includes("scripts/sandbox-licenses/notices.mjs"), "expected notices.mjs in import graph");
  assert.ok(imports.includes("scripts/sandbox-runtime-lock.mjs"), "expected sandbox-runtime-lock.mjs in import graph");

  const lock = JSON.parse(readFileSync(path.join(REPO_ROOT, "scripts", "sandbox-runtime.lock.json"), "utf8"));
  const required = [
    ...imports,
    "scripts/sandbox-runtime.lock.json",
    `scripts/sandbox-licenses/${lock.licenses.pyodide.file}`,
    `scripts/sandbox-licenses/${lock.licenses.cpython.file}`,
  ];

  const uncovered = required.filter((rel) => !isCoveredByFileset(rel, filesetEntries));
  assert.deepEqual(
    uncovered,
    [],
    `sandbox fileset in nix/pkgs/workspace-filesets.nix omits: ${uncovered.join(", ")}`,
  );
});
