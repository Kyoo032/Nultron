import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNixArgs, parseArgs, toWslMountPath, WARM_INSTALLABLES } from "./nix-ci.mjs";

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
