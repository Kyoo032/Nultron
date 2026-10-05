import type { Dirent } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeniedName, isSkippedDirName } from "./denied-names";
import { isInsideOrEqual } from "./path-compare";

export type WalkedFile = {
  /** Path from the folder root, POSIX separators. */
  readonly rel: string;
  /** Where to open it. */
  readonly abs: string;
  readonly bytes: number;
  readonly updatedAt: number;
};

/**
 * Every ordinary file below `startReal`, in name order.
 *
 * Denied names and the noise directories are skipped, and so is every link: a listing never follows
 * one, so it cannot be walked out of the folder. A directory is also checked by real path before it
 * is entered, which is what catches a Windows junction whatever the directory entry says it is.
 * `startRel` is the path of `startReal` from the root, empty for the root itself.
 */
export async function* walkFiles(
  rootReal: string,
  startReal: string,
  startRel: readonly string[],
): AsyncGenerator<WalkedFile> {
  const pending: Array<{ abs: string; rel: readonly string[] }> = [{ abs: startReal, rel: startRel }];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (!dir) {
      break;
    }
    let dirReal: string;
    let entries: Dirent[];
    try {
      dirReal = await realpath(dir.abs);
      if (!isInsideOrEqual(rootReal, dirReal)) {
        continue;
      }
      entries = await readdir(dirReal, { withFileTypes: true });
    } catch {
      continue;
    }
    const names = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs: Array<{ abs: string; rel: readonly string[] }> = [];
    for (const entry of names) {
      if (entry.isSymbolicLink() || isDeniedName(entry.name)) {
        continue;
      }
      const abs = path.join(dirReal, entry.name);
      const rel = [...dir.rel, entry.name];
      if (entry.isDirectory()) {
        if (!isSkippedDirName(entry.name)) {
          subdirs.push({ abs, rel });
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      try {
        const info = await lstat(abs);
        yield { rel: rel.join("/"), abs, bytes: info.size, updatedAt: Math.round(info.mtimeMs) };
      } catch {
        // Gone between the listing and the stat: nothing to show.
      }
    }
    // Depth-first in name order: the stack takes the last pushed first, so push in reverse.
    for (let index = subdirs.length - 1; index >= 0; index -= 1) {
      pending.push(subdirs[index]);
    }
  }
}
