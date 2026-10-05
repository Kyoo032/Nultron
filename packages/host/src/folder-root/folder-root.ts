import { stat } from "node:fs/promises";
import type {
  DeskPath,
  FileAuthor,
  FileEntry,
  FileRead,
  FileRefusal,
  FileRoot,
  SearchHit,
  TenantContext,
  WriteOutcome,
} from "@agentforge/core";
import { MAX_SEARCH_HITS, searchLiteralLines } from "@agentforge/core/tools/files";
import { folderRootAvailable } from "./availability";
import {
  FOLDER_LIST_MAX,
  FOLDER_PENDING_MAX,
  FOLDER_SEARCH_MAX_BYTES,
  FOLDER_SEARCH_PATTERN_MAX,
  FOLDER_TEXT_MAX_BYTES,
} from "./constants";
import { parseRelPath, resolveInside } from "./contain";
import { defaultFolderDeps, type FolderDeps } from "./deps";
import { compileGlob } from "./glob";
import { openMount } from "./mount";
import type { ProposalStore } from "./proposal-store";
import { isFolderRefusal, refuse, refusalOf } from "./refusal";
import { decodeText, readFileBytes, readTextFile } from "./text-file";
import { walkFiles } from "./walk";

/** The run a proposal belongs to; a person acting directly has none, so it is filed under "user". */
function runIdFor(by: FileAuthor, author: FileAuthor): string {
  if (by.kind === "agent") {
    return by.runId;
  }
  return author.kind === "agent" ? author.runId : "user";
}

async function currentRoot(workspaceId: string): Promise<string> {
  const mount = await openMount(workspaceId);
  if (!mount.ok) {
    return refuse("root_unavailable");
  }
  return mount.rootReal;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

function asDeskPath(segments: readonly string[]): DeskPath {
  return segments.join("/") as DeskPath;
}

async function listFiles(rootReal: string, dir: DeskPath | null, glob: string | undefined): Promise<FileEntry[]> {
  const matches = compileGlob(glob);
  let startReal = rootReal;
  let startRel: string[] = [];
  if (dir !== null) {
    startRel = parseRelPath(dir);
    const resolved = await resolveInside(rootReal, startRel);
    if (!resolved.exists) {
      return refuse("not_found");
    }
    if (!(await isDirectory(resolved.target))) {
      return refuse("bad_path");
    }
    startReal = resolved.target;
  }
  const entries: FileEntry[] = [];
  for await (const file of walkFiles(rootReal, startReal, startRel)) {
    if (!matches(file.rel)) {
      continue;
    }
    entries.push({ path: file.rel as DeskPath, kind: "file", bytes: file.bytes, updatedAt: file.updatedAt });
    if (entries.length >= FOLDER_LIST_MAX) {
      break;
    }
  }
  return entries;
}

/**
 * Plain, case-sensitive text search, one hit per matching line, the same matching the desk root
 * uses (`searchLiteralLines`). It returns one hit past the cap so the tool can tell "exactly 200"
 * from "more than 200". A pattern is a literal, not a regular expression here: this walks up to
 * 50 MB of an owner's files, and a model-written regex is a way to make that run for hours.
 */
async function searchFiles(rootReal: string, pattern: string, glob: string | undefined): Promise<SearchHit[]> {
  if (typeof pattern !== "string" || pattern === "" || pattern.length > FOLDER_SEARCH_PATTERN_MAX) {
    return refuse("bad_pattern");
  }
  const matches = compileGlob(glob);
  const hits: SearchHit[] = [];
  let budget = 0;
  for await (const file of walkFiles(rootReal, rootReal, [])) {
    if (!matches(file.rel) || file.bytes > FOLDER_TEXT_MAX_BYTES) {
      continue;
    }
    if (budget + file.bytes > FOLDER_SEARCH_MAX_BYTES) {
      break;
    }
    budget += file.bytes;
    let text: string;
    try {
      text = decodeText(await readFileBytes(file.abs)).text;
    } catch (error) {
      if (isFolderRefusal(error)) {
        continue;
      }
      throw error;
    }
    hits.push(...searchLiteralLines(file.rel as DeskPath, text, pattern, MAX_SEARCH_HITS + 1 - hits.length));
    if (hits.length > MAX_SEARCH_HITS) {
      break;
    }
  }
  return hits;
}

function assertRoomForProposal(tenant: TenantContext, store: ProposalStore, relPath: string): void {
  // Replacing a path's own pending proposal adds nothing, so it is allowed at the ceiling.
  if (store.countPending(tenant) >= FOLDER_PENDING_MAX && !store.hasPendingFor(tenant, relPath)) {
    refuse("too_many_files");
  }
}

/**
 * The owner's folder as a `FileRoot`.
 *
 * Reads go to the disk, through real-path containment and the name rules. Writes and deletes never
 * do: each becomes a pending proposal that only the owner can approve (`approveProposal`). The
 * folder is looked up again on every call, so unmounting it, or the folder changing under the
 * mount, ends the agent's access at once.
 *
 * Methods throw core's `FileRootError` for a refusal; this function returns a `FileRefusal` when there is
 * no root to hand out at all (server mode, or no folder open on this desk).
 */
export async function createFolderRoot(
  tenant: TenantContext,
  author: FileAuthor,
  deps?: FolderDeps,
): Promise<FileRoot | FileRefusal> {
  if (!folderRootAvailable() || !(await openMount(tenant.workspaceId)).ok) {
    return refusalOf("root_unavailable");
  }
  const { store } = deps ?? (await defaultFolderDeps());
  const rootOf = (): Promise<string> => currentRoot(tenant.workspaceId);

  async function propose(
    path: string,
    kind: "write" | "delete",
    beforeSha256: string | null,
    afterBody: string | null,
    by: FileAuthor,
  ): Promise<WriteOutcome> {
    assertRoomForProposal(tenant, store, path);
    const proposalId = store.propose(tenant, { runId: runIdFor(by, author), path, kind, beforeSha256, afterBody });
    return { status: "pending_approval", path: path as DeskPath, proposalId };
  }

  return {
    kind: "folder",

    async list(dir, glob) {
      return listFiles(await rootOf(), dir, glob);
    },

    async read(path): Promise<FileRead> {
      const rootReal = await rootOf();
      const segments = parseRelPath(path);
      const resolved = await resolveInside(rootReal, segments);
      if (!resolved.exists) {
        return refuse("not_found");
      }
      const file = await readTextFile(resolved.target);
      return { path: asDeskPath(segments), text: file.text, sha256: file.sha256, bytes: file.bytes };
    },

    async write(path, content, by, options) {
      const rootReal = await rootOf();
      const segments = parseRelPath(path);
      const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : null;
      if (bytes === null) {
        return refuse("bad_path");
      }
      if (bytes.byteLength > FOLDER_TEXT_MAX_BYTES) {
        return refuse("too_large");
      }
      if (bytes.includes(0)) {
        return refuse("denied");
      }
      const resolved = await resolveInside(rootReal, segments);
      const current = resolved.exists ? (await readTextFile(resolved.target)).sha256 : null;
      // An edit was computed from the text the model read, so that hash is the proposal's base even if
      // the file changed since: approving then finds the file differs and answers `stale` rather than
      // applying a diff over text the model never saw. A plain write has no read to be loyal to.
      const before = options?.expectedSha256 ?? current;
      return propose(segments.join("/"), "write", before, content, by);
    },

    async remove(path, by) {
      const rootReal = await rootOf();
      const segments = parseRelPath(path);
      const resolved = await resolveInside(rootReal, segments);
      if (!resolved.exists) {
        return refuse("not_found");
      }
      const before = (await readTextFile(resolved.target)).sha256;
      return propose(segments.join("/"), "delete", before, null, by);
    },

    async search(pattern, glob) {
      return searchFiles(await rootOf(), pattern, glob);
    },
  };
}
