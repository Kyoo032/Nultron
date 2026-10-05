import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { localDataDir } from "@agentforge/db/vault-key";
import { FOLDER_MOUNT_FILE } from "./constants";
import { log } from "../log";

/** One desk's folder. `path` is the real path the folder had when the owner picked it. */
export type FolderMount = {
  readonly workspaceId: string;
  readonly path: string;
  readonly mountedAt: number;
};

type MountFile = { readonly version: 1; readonly mounts: readonly FolderMount[] };

const EMPTY: MountFile = { version: 1, mounts: [] };

export function mountFilePath(): string {
  return path.join(localDataDir(), FOLDER_MOUNT_FILE);
}

function isMount(value: unknown): value is FolderMount {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.workspaceId === "string" &&
    record.workspaceId.length > 0 &&
    typeof record.path === "string" &&
    record.path.length > 0 &&
    typeof record.mountedAt === "number"
  );
}

function readMountFile(): MountFile {
  let raw: string;
  try {
    raw = readFileSync(mountFilePath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("folder_mount_file_unreadable", { code: (error as NodeJS.ErrnoException).code ?? "unknown" });
    }
    return EMPTY;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const mounts = parsed && typeof parsed === "object" ? (parsed as { mounts?: unknown }).mounts : undefined;
    return { version: 1, mounts: Array.isArray(mounts) ? mounts.filter(isMount) : [] };
  } catch {
    // A damaged record means "no folder is open". The owner picks one again; nothing is guessed.
    log.warn("folder_mount_file_corrupt");
    return EMPTY;
  }
}

/** Temp file in the same directory, then rename: a crash leaves the old record or the new one, never half. */
function writeMountFile(next: MountFile): void {
  const file = mountFilePath();
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function getMount(workspaceId: string): FolderMount | null {
  return readMountFile().mounts.find((mount) => mount.workspaceId === workspaceId) ?? null;
}

export function setMount(workspaceId: string, realPath: string, now: number = Date.now()): FolderMount {
  const mount: FolderMount = { workspaceId, path: realPath, mountedAt: now };
  const others = readMountFile().mounts.filter((existing) => existing.workspaceId !== workspaceId);
  writeMountFile({ version: 1, mounts: [...others, mount] });
  return mount;
}

/** Returns whether a record was removed. */
export function clearMount(workspaceId: string): boolean {
  const current = readMountFile();
  const remaining = current.mounts.filter((mount) => mount.workspaceId !== workspaceId);
  if (remaining.length === current.mounts.length) {
    return false;
  }
  writeMountFile({ version: 1, mounts: remaining });
  return true;
}
