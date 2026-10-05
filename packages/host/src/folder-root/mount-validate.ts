import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { localDataDir } from "@agentforge/db/vault-key";
import { FOLDER_PATH_MAX_CHARS } from "./constants";
import { SENSITIVE_DIR_NAMES } from "./denied-names";
import { isInsideOrEqual, isSamePath } from "./path-compare";

export const MOUNT_REFUSAL_REASONS = [
  "not_absolute",
  "not_found",
  "not_a_directory",
  "filesystem_root",
  "home_directory",
  "app_data",
  "system_directory",
  "sensitive_directory",
] as const;

export type MountRefusalReason = (typeof MOUNT_REFUSAL_REASONS)[number];

export type MountCheck =
  | { readonly ok: true; readonly real: string }
  | { readonly ok: false; readonly reason: MountRefusalReason };

/** Fixed sentences for the route to return. None names the path the owner picked. */
export const MOUNT_REFUSAL_MESSAGES: Readonly<Record<MountRefusalReason, string>> = {
  not_absolute: "Pick a folder by its full path.",
  not_found: "That folder does not exist.",
  not_a_directory: "That is not a folder.",
  filesystem_root: "A whole drive cannot be opened. Pick a folder inside it.",
  home_directory: "Your whole home folder cannot be opened. Pick a folder inside it.",
  app_data: "That folder holds this app's own data and cannot be opened.",
  system_directory: "System folders cannot be opened.",
  sensitive_directory: "That folder holds keys or version-control internals and cannot be opened.",
};

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

const WINDOWS_SYSTEM = /^[a-z]:\\(windows|programdata|program files( \(x86\))?)(\\|$)/;

const WINDOWS_SYSTEM_ENV: readonly string[] = [
  "SystemRoot",
  "windir",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "ProgramData",
];

const MAC_SYSTEM: readonly string[] = [
  "/system",
  "/library",
  "/applications",
  "/usr",
  "/bin",
  "/sbin",
  "/etc",
  "/private/etc",
];

const LINUX_SYSTEM: readonly string[] = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/boot",
];

/**
 * True for the operating system's own directories. Pure, so each platform's rule is tested with
 * literal paths rather than only on the platform the suite happens to run on.
 *
 * `/private/etc` is listed beside `/etc` because on macOS the second is a link to the first and the
 * mount check works on real paths. `/private/var` is deliberately not listed: it holds the per-user
 * temp directories.
 */
export function isSystemDirectory(
  real: string,
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (platform === "win32") {
    const lower = real.toLowerCase().replace(/\//g, "\\");
    if (WINDOWS_SYSTEM.test(lower)) {
      return true;
    }
    return WINDOWS_SYSTEM_ENV.some((name) => {
      const value = env[name];
      return value !== undefined && value.trim() !== "" && isInsideOrEqual(value, real, "win32");
    });
  }
  const roots = platform === "darwin" ? MAC_SYSTEM : LINUX_SYSTEM;
  return roots.some((root) => isInsideOrEqual(root, real, platform));
}

function isFilesystemRoot(real: string): boolean {
  const impl = process.platform === "win32" ? path.win32 : path.posix;
  const root = impl.parse(real).root;
  return isSamePath(root, real);
}

function hasSensitiveSegment(real: string): boolean {
  return real.split(/[\\/]/).some((segment) => SENSITIVE_DIR_NAMES.has(segment.toLowerCase()));
}

function isAbsoluteHere(input: string): boolean {
  if (process.platform === "win32") {
    // `\\server\share`, `\\?\C:\` and `\foo` are all "absolute" to path.isAbsolute, and none of them
    // is a folder on a local drive the owner picked.
    return WINDOWS_ABSOLUTE.test(input);
  }
  return path.isAbsolute(input);
}

async function realOrNull(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

/** Overrides for the two places a test needs its own idea of where things live. */
export type MountCheckPlaces = { readonly homeDir?: string; readonly dataDir?: string };

/**
 * Decide whether `input` may become a desk's folder, and return its real path if so.
 *
 * The folder must be a real directory the agent has no business being refused from: not a drive
 * root, not the whole home directory, not a system directory, and neither inside the app's own data
 * dir nor an ancestor of it. The ancestor rule is what keeps `.master-key`, `settings.enc` and the
 * SQLite file (none of which have a denied name) out of the agent's reach: any folder that contains
 * the data dir is refused, which also covers `C:\Users`, `/Users` and `/home`.
 */
export async function checkMountPath(input: unknown, places: MountCheckPlaces = {}): Promise<MountCheck> {
  if (typeof input !== "string" || input.length === 0 || input.length > FOLDER_PATH_MAX_CHARS || input.includes("\0")) {
    return { ok: false, reason: "not_absolute" };
  }
  if (!isAbsoluteHere(input)) {
    return { ok: false, reason: "not_absolute" };
  }
  const real = await realOrNull(input);
  if (real === null) {
    return { ok: false, reason: "not_found" };
  }
  try {
    if (!(await stat(real)).isDirectory()) {
      return { ok: false, reason: "not_a_directory" };
    }
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (isFilesystemRoot(real)) {
    return { ok: false, reason: "filesystem_root" };
  }
  const home = await realOrNull(places.homeDir ?? homedir());
  if (home !== null && isSamePath(home, real)) {
    return { ok: false, reason: "home_directory" };
  }
  const dataDir = await realOrNull(places.dataDir ?? localDataDir());
  if (dataDir !== null && (isInsideOrEqual(dataDir, real) || isInsideOrEqual(real, dataDir))) {
    return { ok: false, reason: "app_data" };
  }
  if (isSystemDirectory(real)) {
    return { ok: false, reason: "system_directory" };
  }
  if (hasSensitiveSegment(real)) {
    return { ok: false, reason: "sensitive_directory" };
  }
  return { ok: true, real };
}
