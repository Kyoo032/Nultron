import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { FOLDER_PATH_MAX_CHARS, FOLDER_SEGMENT_MAX_CHARS } from "./constants";
import { isDeniedPath } from "./denied-names";
import { isInsideOrEqual } from "./path-compare";
import { refuse } from "./refusal";

/** Characters Windows will not put in a name; refused everywhere so one rule covers every machine. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is being refused
const BAD_SEGMENT_CHARS = /[<>:"|?*\u0000-\u001f]/;

/** `con`, `nul`, `com1` and friends, with or without an extension: Windows opens a device, not a file. */
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Split an owner-folder path into segments, or refuse it.
 *
 * Re-checked here even though the tool boundary parses a `DeskPath` first: this root is the one that
 * touches a real disk, and it does not trust a caller to have been careful. A trailing dot or space
 * is refused because Windows drops them, which would let `.env.` name the file `.env`; a colon is
 * refused because on NTFS it opens an alternate data stream.
 */
export function parseRelPath(input: unknown): string[] {
  if (typeof input !== "string" || input.length === 0 || input.length > FOLDER_PATH_MAX_CHARS) {
    return refuse("bad_path");
  }
  if (input.includes("\\") || input.startsWith("/")) {
    return refuse("bad_path");
  }
  const segments = input.split("/");
  for (const segment of segments) {
    if (
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      segment.length > FOLDER_SEGMENT_MAX_CHARS ||
      BAD_SEGMENT_CHARS.test(segment) ||
      /[. ]$/.test(segment) ||
      RESERVED_DEVICE.test(segment)
    ) {
      return refuse("bad_path");
    }
  }
  return segments;
}

export function relPathOf(rootReal: string, real: string): string[] {
  return path.relative(rootReal, real).split(path.sep).filter(Boolean);
}

export type Resolved = {
  /** Where the file is, or would be, as a real path inside the root. */
  readonly target: string;
  readonly exists: boolean;
};

function errnoOf(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? "";
}

/**
 * Resolve `segments` under `rootReal` by real path, and refuse anything that leaves the root.
 *
 * An existing file is resolved with `realpath`, so a link inside the folder that points outside it
 * is refused (`denied`), and so is a link that points at a denied name inside it. The names are
 * checked a second time on the real relative path, because on Windows a short name such as `ENV~1`
 * is a way to spell `.env` that no name rule on the request would catch.
 *
 * A path that does not exist yet is resolved through its nearest existing ancestor, which must also
 * be inside the root. A broken or looping link at the target is refused rather than replaced.
 */
export async function resolveInside(rootReal: string, segments: readonly string[]): Promise<Resolved> {
  if (isDeniedPath(segments)) {
    return refuse("denied");
  }
  const candidate = path.join(rootReal, ...segments);
  try {
    const real = await realpath(candidate);
    if (!isInsideOrEqual(rootReal, real) || isDeniedPath(relPathOf(rootReal, real))) {
      return refuse("denied");
    }
    return { target: real, exists: true };
  } catch (error) {
    const code = errnoOf(error);
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      return refuse("denied");
    }
  }
  if (await lstatOrNull(candidate)) {
    return refuse("denied");
  }
  return resolveThroughAncestor(rootReal, segments);
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function lstatOrNull(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function resolveThroughAncestor(rootReal: string, segments: readonly string[]): Promise<Resolved> {
  for (let keep = segments.length - 1; keep >= 0; keep -= 1) {
    const ancestor = path.join(rootReal, ...segments.slice(0, keep));
    let ancestorReal: string;
    try {
      ancestorReal = await realpath(ancestor);
    } catch (error) {
      const code = errnoOf(error);
      if (code === "ENOENT") {
        continue;
      }
      return refuse(code === "ENOTDIR" ? "bad_path" : "denied");
    }
    if (!isInsideOrEqual(rootReal, ancestorReal) || isDeniedPath(relPathOf(rootReal, ancestorReal))) {
      return refuse("denied");
    }
    if (!(await isDirectory(ancestorReal))) {
      // A file sits where a folder would have to be.
      return refuse("bad_path");
    }
    return { target: path.join(ancestorReal, ...segments.slice(keep)), exists: false };
  }
  return refuse("not_found");
}
