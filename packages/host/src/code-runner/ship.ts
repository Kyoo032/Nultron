import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPackagedRuntime, type CodeLanguage } from "@agentforge/core";
import { log } from "../log";
import { SANDBOX_DIR_ENV } from "./limits";

/**
 * The ship directory: the Pyodide and QuickJS files plus the two child entry scripts, copied by the
 * packaging lane in exactly this layout.
 *
 *   <ship>/py-child.mjs                      Python child entry   (child/py-child.mjs in this folder)
 *   <ship>/qjs-child.mjs                     JavaScript child entry
 *   <ship>/vendor/pyodide/MANIFEST.json      { files: [{ name, sha256 }] }, names relative to vendor/pyodide
 *   <ship>/vendor/pyodide/*                  pyodide.mjs, pyodide.asm.*, the lock file and the wheels
 *   <ship>/node_modules/quickjs-emscripten-core, <ship>/node_modules/@jitl/quickjs-wasmfile-release-sync
 *   <ship>/MANIFEST.json                     OPTIONAL { files: [{ name, sha256 }] }, names relative to <ship>;
 *                                            when present it is verified too (use it to pin the child
 *                                            scripts and QuickJS, which the Pyodide manifest does not list)
 */
export const PY_ENTRY = "py-child.mjs";
export const JS_ENTRY = "qjs-child.mjs";
const PYODIDE_MANIFEST = join("vendor", "pyodide", "MANIFEST.json");
const PYODIDE_DIR = join("vendor", "pyodide");
const ROOT_MANIFEST = "MANIFEST.json";
const QUICKJS_PROBE = join("node_modules", "quickjs-emscripten-core", "package.json");

export type ShipStatus =
  | { readonly ok: true; readonly dir: string; readonly languages: ReadonlySet<CodeLanguage> }
  | { readonly ok: false; readonly why: "missing" | "mismatch" | "unreadable" | "incomplete" };

type ManifestFile = { readonly name: string; readonly sha256: string };

let dirOverride: string | null = null;
const verdicts = new Map<string, Promise<ShipStatus>>();

/** Test seam: pin the ship directory without touching the environment. */
export function setShipDirForTests(dir: string | null): void {
  dirOverride = dir;
}

export function resetShipVerdictForTests(): void {
  verdicts.clear();
}

/** The directory containing this module, in webdev (ESM) and in the esbuild CJS bundle alike. */
function moduleDirectory(): string | null {
  try {
    const url = import.meta.url;
    if (typeof url === "string" && url.startsWith("file:")) {
      return dirname(fileURLToPath(url));
    }
  } catch {
    // Inside host.cjs `import.meta` is empty; fall through.
  }
  return typeof __dirname === "string" ? __dirname : null;
}

/** The checkout root, found by walking up to the workspace file. Null when there is none (a packaged app). */
export function findRepoRoot(starts: readonly (string | null)[] = [moduleDirectory(), process.cwd()]): string | null {
  for (const start of starts) {
    let current = start ? resolve(start) : null;
    while (current) {
      if (existsSync(join(current, "pnpm-workspace.yaml"))) {
        return current;
      }
      const parent = dirname(current);
      current = parent === current ? null : parent;
    }
  }
  return null;
}

/**
 * Where the ship directory should be, or null when nowhere is plausible.
 *
 * `AGENTFORGE_SANDBOX_DIR` is a dev and test hook and wins when set, except in the packaged app, which
 * always reads its own `resources/sandbox` (the same rule as the gateway hooks, SR-85): an environment
 * the app was launched from must not be able to point the sandbox at other files.
 */
export function locateShipDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (dirOverride) {
    return dirOverride;
  }
  const hooked = env[SANDBOX_DIR_ENV]?.trim();
  if (hooked && !isPackagedRuntime()) {
    return resolve(hooked);
  }
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (process.versions.electron && resources) {
    return join(resources, "sandbox");
  }
  const root = findRepoRoot();
  return root ? join(root, "vendor", "sandbox-runtime") : null;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function readManifest(path: string): Promise<ManifestFile[] | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
  const files = (parsed as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) {
    return null;
  }
  const listed: ManifestFile[] = [];
  for (const entry of files) {
    const name = (entry as { name?: unknown } | null)?.name;
    const sha256 = (entry as { sha256?: unknown } | null)?.sha256;
    if (typeof name !== "string" || typeof sha256 !== "string" || name.includes("..")) {
      return null;
    }
    listed.push({ name, sha256: sha256.toLowerCase() });
  }
  return listed;
}

/** Names the first file whose hash differs, or null when all match. A missing file counts as a mismatch. */
async function firstMismatch(base: string, files: readonly ManifestFile[]): Promise<string | null> {
  for (const file of files) {
    let actual: string | null = null;
    try {
      actual = await sha256File(join(base, file.name));
    } catch {
      actual = null;
    }
    if (actual !== file.sha256) {
      return file.name;
    }
  }
  return null;
}

async function verifyShip(dir: string): Promise<ShipStatus> {
  if (!existsSync(dir)) {
    return { ok: false, why: "missing" };
  }
  if (dir.includes(",")) {
    // `--allow-fs-read` takes a comma-separated list, so a comma in the path would grant a different directory.
    log.error("code_runner_ship_path_unsupported", { detail: "the ship directory path contains a comma" });
    return { ok: false, why: "incomplete" };
  }
  const languages = new Set<CodeLanguage>();

  const rootManifest = existsSync(join(dir, ROOT_MANIFEST)) ? await readManifest(join(dir, ROOT_MANIFEST)) : undefined;
  if (rootManifest === null) {
    log.error("code_runner_ship_unreadable", { file: ROOT_MANIFEST });
    return { ok: false, why: "unreadable" };
  }
  if (rootManifest) {
    const bad = await firstMismatch(dir, rootManifest);
    if (bad) {
      log.error("code_runner_ship_mismatch", { file: bad });
      return { ok: false, why: "mismatch" };
    }
  }

  if (existsSync(join(dir, PYODIDE_MANIFEST)) && existsSync(join(dir, PY_ENTRY))) {
    const pyodide = await readManifest(join(dir, PYODIDE_MANIFEST));
    if (!pyodide) {
      log.error("code_runner_ship_unreadable", { file: PYODIDE_MANIFEST });
      return { ok: false, why: "unreadable" };
    }
    const bad = await firstMismatch(join(dir, PYODIDE_DIR), pyodide);
    if (bad) {
      log.error("code_runner_ship_mismatch", { file: join(PYODIDE_DIR, bad) });
      return { ok: false, why: "mismatch" };
    }
    languages.add("python");
  }
  if (existsSync(join(dir, QUICKJS_PROBE)) && existsSync(join(dir, JS_ENTRY))) {
    languages.add("javascript");
  }
  if (languages.size === 0) {
    return { ok: false, why: "incomplete" };
  }
  return { ok: true, dir, languages };
}

/**
 * The ship directory and what it can run, verified once per process: every file a manifest lists is
 * hashed before the first child is spawned, and the verdict is cached (a failure too, so a tampered
 * directory is not re-read on every call). A mismatch is logged with the manifest-relative name for the
 * operator and reaches the model only as `unavailable`.
 */
export function checkShip(): Promise<ShipStatus> {
  const dir = locateShipDir();
  if (!dir) {
    return Promise.resolve({ ok: false, why: "missing" });
  }
  let verdict = verdicts.get(dir);
  if (!verdict) {
    verdict = verifyShip(dir).catch((error: unknown) => {
      log.error("code_runner_ship_failed", { detail: error instanceof Error ? error.message : "unknown" });
      return { ok: false, why: "unreadable" } as const;
    });
    verdicts.set(dir, verdict);
  }
  return verdict;
}
