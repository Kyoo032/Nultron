#!/usr/bin/env node
/**
 * Local Nix CI runner with GC-root pinning and optional local file binary cache.
 *
 * Runs Nix natively on Linux, or mirrors committed HEAD into a clean WSL checkout on Windows so
 * LF line endings and git-tracked state hold cleanly without touching any user checkout.
 *
 * Usage:
 *   node scripts/nix-ci.mjs --fast
 *   node scripts/nix-ci.mjs --full
 *   node scripts/nix-ci.mjs --warm-cache
 *   node scripts/nix-ci.mjs --fast --local-cache /var/cache/nultron-nix
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const WARM_INSTALLABLES = [
  ".#pnpm-deps",
  ".#workspace-deps",
  ".#ffmpeg-static",
  ".#sandbox-cache",
  ".#tla2tools",
  ".#ci-fast",
];

export function parseArgs(argv) {
  const args = {
    mode: "fast",
    localCache: null,
    gcRoots: true,
    distro: "NixOS",
    mirror: "~/.cache/nultron-nix-ci",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--fast") args.mode = "fast";
    else if (flag === "--full") args.mode = "full";
    else if (flag === "--warm-cache") args.mode = "warm-cache";
    else if (flag === "--no-gc-roots") args.gcRoots = false;
    else if (flag === "--local-cache" || flag === "--distro" || flag === "--mirror") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
      const key = flag === "--local-cache" ? "localCache" : flag.slice(2);
      args[key] = value;
      i += 1;
    } else if (flag === "--help" || flag === "-h") {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

export function toWslMountPath(windowsPath) {
  if (/^[A-Za-z]:[\\/]/.test(windowsPath)) {
    const resolved = path.win32.resolve(windowsPath).replace(/\\/g, "/");
    const match = /^([A-Za-z]):\/(.*)$/.exec(resolved);
    if (match) return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
  }
  return path.resolve(windowsPath).replace(/\\/g, "/");
}

export function buildNixArgs(args) {
  const extraSubs = args.localCache
    ? ["--extra-substituters", `file://${args.localCache}?trusted=1`]
    : [];
  const rootsFlag = (name) =>
    args.gcRoots ? ["--out-link", `.nix-ci-roots/${name}`] : ["--no-link"];

  if (args.mode === "full") {
    return [["flake", "check", "-L", "--keep-going", ...extraSubs]];
  }
  if (args.mode === "warm-cache") {
    return WARM_INSTALLABLES.map((target) => {
      const name = target.slice(2);
      return ["build", target, "-L", "--keep-going", ...extraSubs, ...rootsFlag(name)];
    });
  }
  return [["build", ".#ci-fast", "-L", "--keep-going", ...extraSubs, ...rootsFlag("ci-fast")]];
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function runLinux(args, root) {
  if (args.gcRoots) {
    mkdirSync(path.join(root, ".nix-ci-roots"), { recursive: true });
  }
  if (args.localCache) {
    mkdirSync(args.localCache, { recursive: true });
  }
  const commands = buildNixArgs(args);
  for (const cmdArgs of commands) {
    const start = Date.now();
    console.log(`$ nix ${cmdArgs.join(" ")}`);
    const res = spawnSync("nix", cmdArgs, { cwd: root, stdio: "inherit" });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (res.status !== 0) {
      console.error(`nix-ci: failed (${elapsed}s)`);
      return res.status ?? 1;
    }
    console.log(`nix-ci: ok (${elapsed}s)`);
  }
  if (args.localCache) {
    const targets = args.mode === "warm-cache" ? WARM_INSTALLABLES : [".#ci-fast"];
    const start = Date.now();
    const copyArgs = ["copy", "--to", `file://${args.localCache}`, ...targets];
    console.log(`$ nix ${copyArgs.join(" ")}`);
    const res = spawnSync("nix", copyArgs, { cwd: root, stdio: "inherit" });
    if (res.status !== 0) return res.status ?? 1;
    console.log(`nix-ci: local cache updated (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  }
  return 0;
}

function resolveWslFetchSource(root) {
  const commonDir = execFileSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
  }).trim();
  const branch = execFileSync("git", ["-C", root, "symbolic-ref", "--quiet", "HEAD"], {
    encoding: "utf8",
  }).trim();
  return { wslRepo: toWslMountPath(commonDir), ref: branch || "HEAD" };
}

function runViaWsl(args, root) {
  const dirty = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).trim();
  const sha = execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  if (dirty) {
    console.log(`nix-ci: note — syncing committed HEAD (${sha}) into WSL; uncommitted changes are not included.`);
  }
  let source;
  try {
    source = resolveWslFetchSource(root);
  } catch {
    source = { wslRepo: toWslMountPath(root), ref: "HEAD" };
  }
  const mirrorExpr = args.mirror.startsWith("~/")
    ? `"$HOME/${args.mirror.slice(2)}"`
    : shellEscape(args.mirror);

  const lines = [
    "set -euo pipefail",
    `MIRROR=${mirrorExpr}`,
    'mkdir -p "$(dirname "$MIRROR")"',
    'if [ ! -d "$MIRROR/.git" ]; then git init -q "$MIRROR"; fi',
    `git -C "$MIRROR" -c safe.directory=${shellEscape(source.wslRepo)} fetch --quiet ${shellEscape(source.wslRepo)} ${shellEscape(source.ref)}`,
    'git -C "$MIRROR" checkout --quiet --detach FETCH_HEAD',
    'cd "$MIRROR"',
  ];
  if (args.gcRoots) {
    lines.push("mkdir -p .nix-ci-roots");
  }
  if (args.localCache) {
    lines.push(`mkdir -p ${shellEscape(args.localCache)}`);
  }
  for (const cmdArgs of buildNixArgs(args)) {
    lines.push(`nix ${cmdArgs.map(shellEscape).join(" ")}`);
  }
  if (args.localCache) {
    const targets = args.mode === "warm-cache" ? WARM_INSTALLABLES : [".#ci-fast"];
    lines.push(
      `nix copy --to ${shellEscape(`file://${args.localCache}`)} ${targets.map(shellEscape).join(" ")}`,
    );
  }
  const start = Date.now();
  const res = spawnSync("wsl", ["-d", args.distro, "--", "bash", "-s"], {
    input: `${lines.join("\n")}\n`,
    stdio: ["pipe", "inherit", "inherit"],
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`nix-ci: finished in ${elapsed}s (exit ${res.status ?? 1})`);
  return res.status ?? 1;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node scripts/nix-ci.mjs [--fast | --full | --warm-cache] [--local-cache <dir>] [--no-gc-roots] [--distro NixOS]",
    );
    return 0;
  }
  if (process.platform === "win32") {
    return runViaWsl(args, defaultRoot);
  }
  return runLinux(args, defaultRoot);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exit(main());
}
