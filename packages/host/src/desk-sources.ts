/**
 * The source text a job is written from: what the person pasted, plus up to five desk files the HOST
 * reads. Documents, Presentation and Open Slide all assemble their source here. The model never
 * fetches a source itself, so "use only the source" always means the text assembled here.
 *
 * A file comes in through the desk root, never by a path on disk, and passes the same injection guard
 * and the same 120k-character ceiling as pasted source material (`job-source.ts`). Pasted text takes
 * its share first, then the files in the order given, each under a header that counts against the
 * ceiling. The file that crosses it is cut with the pasted-text marker; a file the ceiling never
 * reaches is named and left unread.
 */
import { ApiError, type TenantContext } from "@agentforge/core";
import { FileRootError, isFileRefusal, parseDeskPath } from "@agentforge/core/tools/files";
import type { DeskPath, FileRefusalCode, FileRoot } from "@agentforge/core/tools/files";
import { createDeskRoot } from "./desk-files/store";
import {
  assertSafeSourceText,
  readSourceText,
  SOURCE_TEXT_MAX_CHARS,
  SOURCE_TRUNCATED_MARKER,
  type SourceTextOptions,
} from "./job-source";

/** Desk files one request may name. */
export const MAX_SOURCE_FILES = 5;

/** How a file shows up in the source, so the model and the person can tell where a line came from. */
export function deskFileHeader(path: string): string {
  return `=== Desk file: ${path} ===`;
}

const OMITTED_NOTE = "[omitted: the source limit was reached before this file]";
const EMPTY_NOTE = "[this file is empty]";
const SHOWN_PATH_CHARS = 80;

/** What the person reads when a file cannot be used. `denied` is the desk's "not valid text" answer. */
const REFUSAL_STATUS: Readonly<Record<FileRefusalCode, number>> = {
  bad_path: 400,
  not_found: 400,
  too_large: 413,
  too_many_files: 409,
  denied: 400,
  no_match: 400,
  bad_pattern: 400,
  ambiguous_match: 400,
  root_unavailable: 503,
  quota: 403,
  conflict: 409,
};

export type SourceFileUse = {
  readonly path: string;
  /** Characters of the file that went into the source. */
  readonly chars: number;
  /** Cut at the source limit, or left out whole when nothing of the limit remained. */
  readonly truncated: boolean;
};

export type AssembledSource = {
  /** Pasted text first, then each desk file under its header. Empty when there is no source. */
  readonly text: string;
  readonly files: readonly SourceFileUse[];
};

function shown(path: string): string {
  return path.length > SHOWN_PATH_CHARS ? `${path.slice(0, SHOWN_PATH_CHARS)}…` : path;
}

/**
 * The optional `sourceFiles` body field as parsed desk paths, in the order given, repeats dropped.
 * Absent means none. A shape or path the desk would refuse is a 400 that names the offender.
 */
export function readSourceFilePaths(body: unknown): DeskPath[] {
  if (!body || typeof body !== "object") {
    return [];
  }
  const raw = (body as { sourceFiles?: unknown }).sourceFiles;
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    throw new ApiError("invalid_request", "sourceFiles must be a list of desk file paths", 400);
  }
  if (raw.length > MAX_SOURCE_FILES) {
    throw new ApiError("invalid_request", `Pick at most ${MAX_SOURCE_FILES} desk files as sources`, 400);
  }
  const seen = new Set<string>();
  const paths: DeskPath[] = [];
  for (const item of raw as string[]) {
    const parsed = parseDeskPath(item);
    if (isFileRefusal(parsed)) {
      throw new ApiError(parsed.code, `Source file "${shown(item)}" is not a desk path: ${parsed.message}`, 400);
    }
    if (!seen.has(parsed)) {
      seen.add(parsed);
      paths.push(parsed);
    }
  }
  return paths;
}

function refusal(error: unknown, path: string): never {
  if (error instanceof FileRootError) {
    if (error.code === "not_found") {
      throw new ApiError("source_file_not_found", `Source file "${shown(path)}" is not on this desk`, 400);
    }
    throw new ApiError(error.code, `Source file "${shown(path)}": ${error.message}`, REFUSAL_STATUS[error.code]);
  }
  throw error;
}

function guardFile(path: string, text: string, options: SourceTextOptions): void {
  try {
    assertSafeSourceText(text, options);
  } catch (error) {
    if (error instanceof ApiError && error.code === "injection_blocked") {
      throw new ApiError("injection_blocked", `Source file "${shown(path)}": ${error.message}`, 400);
    }
    throw error;
  }
}

/** The body a file contributes, within `room` characters. An empty file says so instead of a bare header. */
function bodyWithin(text: string, room: number): { body: string; chars: number; truncated: boolean } {
  if (text.length === 0) {
    return { body: EMPTY_NOTE, chars: 0, truncated: false };
  }
  if (text.length <= room) {
    return { body: text, chars: text.length, truncated: false };
  }
  return { body: `${text.slice(0, room)}\n${SOURCE_TRUNCATED_MARKER}`, chars: room, truncated: true };
}

/**
 * Read the named files through `root` and lay them out under a header each, within what is left of
 * the 120k ceiling after the pasted text. A file the ceiling cuts keeps its start and ends with the
 * same marker pasted text gets; one the ceiling never reaches is named and left unread.
 */
export async function readDeskSourceFiles(
  root: FileRoot,
  paths: readonly DeskPath[],
  budgetChars: number,
  options: SourceTextOptions = {},
): Promise<{ blocks: string[]; files: SourceFileUse[] }> {
  const blocks: string[] = [];
  const files: SourceFileUse[] = [];
  let left = budgetChars;
  for (const path of paths) {
    const header = deskFileHeader(path);
    if (left <= header.length + 1) {
      blocks.push(`${header}\n${OMITTED_NOTE}`);
      files.push({ path, chars: 0, truncated: true });
      continue;
    }
    let text: string;
    try {
      text = (await root.read(path)).text.trim();
    } catch (error) {
      refusal(error, path);
    }
    guardFile(path, text, options);
    const { body, chars, truncated } = bodyWithin(text, left - header.length - 1);
    blocks.push(`${header}\n${body}`);
    files.push({ path, chars, truncated });
    // The blank line that joins the blocks counts too, so the whole stays within the ceiling.
    left -= header.length + 1 + body.length + 2;
  }
  return { blocks, files };
}

/**
 * `readSourceText` plus the desk files `sourceFiles` names. Same ceiling and guard for both. A body
 * that names no file never touches the file store.
 */
export async function assembleDeskSource(
  tenant: TenantContext,
  body: unknown,
  options: SourceTextOptions = {},
): Promise<AssembledSource> {
  const pasted = readSourceText(body, options);
  const paths = readSourceFilePaths(body);
  if (paths.length === 0) {
    return { text: pasted, files: [] };
  }
  const root = createDeskRoot(tenant, { kind: "user", userId: tenant.userId });
  const { blocks, files } = await readDeskSourceFiles(
    root,
    paths,
    Math.max(0, SOURCE_TEXT_MAX_CHARS - pasted.length),
    options,
  );
  return { text: [pasted, ...blocks].filter(Boolean).join("\n\n"), files };
}
