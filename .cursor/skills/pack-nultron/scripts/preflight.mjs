#!/usr/bin/env node
/**
 * Fail closed before a Nultron pack on this Windows desk.
 *   node .cursor/skills/pack-nultron/scripts/preflight.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const skillDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(skillDir, "..", "..", "..");
const desktopRoot = join(repoRoot, "apps", "desktop");
const PYTHON_312 = join(homedir(), "AppData", "Local", "Programs", "Python", "Python312", "python.exe");

function fail(message) {
  console.error(`pack-preflight: ${message}`);
  process.exit(1);
}

function ok(message) {
  console.log(`pack-preflight: ok - ${message}`);
}

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", cwd: repoRoot, ...opts }).trim();
  } catch (error) {
    return "";
  }
}

if (process.platform !== "win32") {
  fail("this skill is the Windows operator desk only (Cloud / Mac abort)");
}
if (process.env.CI || process.env.CURSOR_CLOUD) {
  fail("Cloud/CI must not pack; the NSIS + Docker mac path is this PC");
}
if (process.env.ELECTRON_RUN_AS_NODE) {
  fail("ELECTRON_RUN_AS_NODE is set; unset it in the pack shell (agent shells often inject it)");
}

const python = process.env.PYTHON || PYTHON_312;
if (!existsSync(python)) {
  fail(`Python 3.12 missing at ${python} (do not use Windows Store 3.14)`);
}
const pyVer = run(python, ["-c", "import sys; print(sys.version.split()[0])"]);
if (!pyVer.startsWith("3.12")) {
  fail(`need Python 3.12 for node-gyp, got ${pyVer || "none"} from ${python}`);
}
ok(`python ${pyVer} (${python})`);

const dockerOs = run("docker", ["info", "--format", "{{.OSType}}"]);
if (!dockerOs.includes("linux")) {
  fail("macOS route needs Docker Desktop in Linux mode (Windows NSIS does not use this daemon)");
}
ok(`docker linux (${dockerOs})`);

const version = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+/.test(version)) fail("apps/desktop/package.json version is not semver");
ok(`version ${version}`);

const git = run("git", ["status", "--porcelain"]);
ok(git ? `dirty tree (${git.split(/\r?\n/).length} paths) — mac docker builds HEAD only` : "working tree clean");

const starters = join(desktopRoot, "resources", "starters");
const clips = join(desktopRoot, "resources", "examples", "videos");
const starterFiles = existsSync(starters)
  ? readdirSync(starters).filter((n) => /\.(mp4|m4a)$/i.test(n))
  : [];
const clipFiles = existsSync(clips) ? readdirSync(clips).filter((n) => /\.mp4$/i.test(n)) : [];
if (starterFiles.length < 7) fail(`starter media: ${starterFiles.length}/7 in ${starters}`);
if (clipFiles.length < 6) fail(`example clips: ${clipFiles.length}/6 in ${clips}`);
ok(`media ${starterFiles.length} starters, ${clipFiles.length} clips`);

// Bundled ffmpeg (apps/desktop/scripts/stage-ffmpeg.mjs). Every installer carries ffmpeg and ffprobe; an installer
// without them shows people an "install ffmpeg" notice, which is the bug this check exists to stop.
//   - the lock must be valid and pin all three targets (the Windows pack and both mac arches);
//   - a staged resources/ffmpeg, when there is one, must match the lock (a wrong-arch swap fails here);
//   - with --require-ffmpeg the folder MUST be staged for win32-x64: run it in the pack worktree after
//     `node apps/desktop/scripts/stage-ffmpeg.mjs --target win32-x64` and before `desktop:build`.
// The mac route stages and verifies inside its Docker run (build-mac.sh), so nothing is staged for it here.
const stageFfmpeg = await import(pathToFileURL(join(desktopRoot, "scripts", "stage-ffmpeg.mjs")).href);
let ffmpegLock;
try {
  ffmpegLock = stageFfmpeg.readLock();
} catch (error) {
  fail(`ffmpeg lock: ${error.message}`);
}
for (const target of stageFfmpeg.TARGETS) {
  if (!ffmpegLock.targets[target]) fail(`ffmpeg.lock.json pins nothing for ${target}: that pack would ship without ffmpeg`);
}
ok(`ffmpeg lock pins ${stageFfmpeg.TARGETS.join(", ")}`);
const ffmpegManifest = join(stageFfmpeg.DEFAULT_OUT, "MANIFEST.json");
const ffmpegStaged = existsSync(ffmpegManifest)
  ? stageFfmpeg.verifyStaged({ lock: ffmpegLock, out: stageFfmpeg.DEFAULT_OUT })
  : null;
if (ffmpegStaged && !ffmpegStaged.ok) {
  fail(`resources/ffmpeg does not match the lock: ${ffmpegStaged.problems.slice(0, 5).join("; ")}`);
}
if (process.argv.includes("--require-ffmpeg")) {
  if (!ffmpegStaged) {
    fail("resources/ffmpeg is not staged: run `node apps/desktop/scripts/stage-ffmpeg.mjs --target win32-x64` first");
  }
  if (ffmpegStaged.target !== "win32-x64") {
    fail(`resources/ffmpeg is staged for ${ffmpegStaged.target}, the Windows pack needs win32-x64`);
  }
}
ok(
  ffmpegStaged
    ? `ffmpeg staged for ${ffmpegStaged.target}, matches the lock`
    : "ffmpeg not staged in this checkout (desktop:build stages win32-x64; mac stages per arch in Docker)",
);

const dist = join(desktopRoot, "dist");
if (existsSync(dist)) {
  const stale = readdirSync(dist).filter(
    (n) => /Setup.*\.exe$/i.test(n) && !n.includes(version),
  );
  // Artifacts cut before 2026-09-29 are named DPSBuddy-*; they are stale too.
  const macStale = readdirSync(dist).filter(
    (n) => /(?:Nultron|DPSBuddy)-.*-mac-/.test(n) && !n.includes(version),
  );
  if (stale.length || macStale.length) {
    ok(`archive stale dist first: ${[...stale, ...macStale].join(", ")}`);
  }
}

const packDir = join(homedir(), `agentforge-pack-${version}`);
console.log(
  JSON.stringify(
    {
      version,
      routes: {
        windows: {
          cwd: packDir,
          command: "npx pnpm@9.15.9 desktop:build",
          python,
          artifacts: `dist/Nultron Setup ${version}.exe + .blockmap + latest.yml`,
          proof: "doctor.mjs --desktop after launching win-unpacked/Nultron.exe",
        },
        macos: {
          cwd: repoRoot,
          command: "npx pnpm@9.15.9 desktop:build:mac:docker --arch all",
          docker: dockerOs,
          artifacts: `apps/desktop/dist/Nultron-${version}-mac-<arch>.dmg|zip`,
          proof: "container verify-bundle.py (app + dmg + zip); not doctor --desktop",
        },
      },
      release: {
        cwd: repoRoot,
        command:
          "npx pnpm@9.15.9 --filter @agentforge/desktop exec node scripts/release-desktop.mjs --require-mac --dry-run",
        after: "copy Windows exe/blockmap/latest.yml from the worktree dist into main dist",
      },
    },
    null,
    2,
  ),
);
ok("preflight passed");
