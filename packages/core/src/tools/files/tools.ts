import { z } from "zod";
import { defineTool } from "../define-tool";
import { applyExactEdit, matchFileLineEndings } from "./edit-text";
import { checkGlob } from "./glob";
import { cutText, MAX_FILE_BYTES, MAX_READ_LINES } from "./lines";
import { formatNumberedLines } from "./numbered-lines";
import { parseDeskPath } from "./path";
import { isFileRefusal } from "./refusals";
import { searchByRegex } from "./search-regex";
import { checkSearchPattern, MAX_HIT_TEXT_CHARS, MAX_SEARCH_HITS } from "./search-text";
import { checkContentSize, withRoot, writeResult } from "./tool-support";
import type { FileRootKind, SearchHit } from "./types";

/** Entries `list_files` shows at once. A desk holds up to 2000 files, which is too much to read in one go. */
export const MAX_LIST_ENTRIES = 500;

const rootSchema = z.enum(["desk", "folder"]).optional();

const ROOT_HELP =
  'root: "desk" (the default) is this desk\'s own file store and is always there. "folder" is the real folder the owner opened, on the desktop app only; when none is open the call is refused with root_unavailable.';

const WRITE_HELP =
  'On the desk the change is saved at once as a new version. On the "folder" root nothing changes yet: the result has status pending_approval and the change is applied only after the owner approves it, so say that it is waiting.';

const GLOB_HELP =
  "glob is matched against the full path from the top, such as notes/**/*.md: * and ? stay inside one folder, a whole ** part crosses folders, {a,b} picks alternatives, case matters. At most 200 characters.";

export const listFilesTool = defineTool({
  key: "list_files",
  name: "List files",
  description: `List the files you can work with. ${ROOT_HELP} dir: a folder such as notes; leave it out for the top. ${GLOB_HELP} Shows at most ${MAX_LIST_ENTRIES} entries and sets truncated when there are more, so narrow it with dir or glob.`,
  schema: z
    .object({
      root: rootSchema,
      dir: z.string().max(512).optional(),
      glob: z.string().max(2000).optional(),
    })
    .strict(),
  trust: "user_content",
  execute: async ({ root: rootKind, dir, glob }, tenant) => {
    const parsedDir = dir === undefined || dir === "" ? null : parseDeskPath(dir);
    if (isFileRefusal(parsedDir)) {
      return parsedDir;
    }
    const globRefusal = checkGlob(glob);
    if (globRefusal) {
      return globRefusal;
    }
    return withRoot(tenant, rootKind, async ({ root }) => {
      const entries = [...(await root.list(parsedDir, glob))].sort((a, b) => (a.path < b.path ? -1 : 1));
      return {
        ok: true as const,
        root: root.kind,
        dir: parsedDir,
        total: entries.length,
        truncated: entries.length > MAX_LIST_ENTRIES,
        entries: entries.slice(0, MAX_LIST_ENTRIES),
      };
    });
  },
});

export const readFileTool = defineTool({
  key: "read_file",
  name: "Read file",
  description: `Read a text file. ${ROOT_HELP} The content comes back with 1-based line numbers; do not copy the numbers into edits. At most ${MAX_READ_LINES} lines are shown and longer lines are cut, and truncated tells you more follows: call again with offset set to the next line. offset: first line to show (default 1). limit: lines to show (default and maximum ${MAX_READ_LINES}).`,
  schema: z
    .object({
      root: rootSchema,
      path: z.string().max(512),
      offset: z.number().int().optional(),
      limit: z.number().int().optional(),
    })
    .strict(),
  trust: "user_content",
  execute: async ({ root: rootKind, path, offset, limit }, tenant) => {
    const parsed = parseDeskPath(path);
    if (isFileRefusal(parsed)) {
      return parsed;
    }
    return withRoot(tenant, rootKind, async ({ root }) => {
      const file = await root.read(parsed);
      const view = formatNumberedLines(file.text, offset, limit);
      return {
        ok: true as const,
        root: root.kind,
        path: file.path,
        bytes: file.bytes,
        ...(file.version === undefined ? {} : { version: file.version }),
        totalLines: view.totalLines,
        firstLine: view.firstLine,
        lastLine: view.lastLine,
        truncated: view.truncated,
        content: view.text,
      };
    });
  },
});

export const writeFileTool = defineTool({
  key: "write_file",
  name: "Write file",
  description: `Create a text file, or replace a whole file with new content. ${ROOT_HELP} content: the full text, at most 2 MB. ${WRITE_HELP} To change part of an existing file use edit_file instead, so the rest is not rewritten.`,
  schema: z
    .object({
      root: rootSchema,
      path: z.string().max(512),
      content: z.string(),
    })
    .strict(),
  trust: "user_content",
  execute: async ({ root: rootKind, path, content }, tenant) => {
    const parsed = parseDeskPath(path);
    if (isFileRefusal(parsed)) {
      return parsed;
    }
    const sizeRefusal = checkContentSize(content);
    if (sizeRefusal) {
      return sizeRefusal;
    }
    return withRoot(tenant, rootKind, async ({ root, author }) =>
      writeResult(root.kind, await root.write(parsed, content, author)),
    );
  },
});

export const editFileTool = defineTool({
  key: "edit_file",
  name: "Edit file",
  description: `Change part of an existing text file by exact replacement. ${ROOT_HELP} old_string must match the file exactly, including spaces, indentation and line breaks, and must occur once: include a few lines around it to make it unique, or set replace_all to change every occurrence. Read the file first and copy old_string from it without the line numbers. new_string replaces it; the result is at most 2 MB. If the call is refused with conflict, the file changed after you read it: read it again and redo the edit. ${WRITE_HELP}`,
  schema: z
    .object({
      root: rootSchema,
      path: z.string().max(512),
      old_string: z.string().max(MAX_FILE_BYTES),
      new_string: z.string().max(MAX_FILE_BYTES),
      replace_all: z.boolean().optional(),
    })
    .strict(),
  trust: "user_content",
  execute: async ({ root: rootKind, path, old_string, new_string, replace_all }, tenant) => {
    const parsed = parseDeskPath(path);
    if (isFileRefusal(parsed)) {
      return parsed;
    }
    return withRoot(tenant, rootKind, async ({ root, author }) => {
      const file = await root.read(parsed);
      const edited = applyExactEdit(
        file.text,
        matchFileLineEndings(file.text, old_string),
        matchFileLineEndings(file.text, new_string),
        replace_all === true,
      );
      if (isFileRefusal(edited)) {
        return edited;
      }
      const sizeRefusal = checkContentSize(edited.text);
      if (sizeRefusal) {
        return sizeRefusal;
      }
      // Compare-and-set against the text this edit was computed from: if another call changed the
      // file after the read, the root refuses with `conflict` instead of overwriting that change.
      const outcome = await root.write(parsed, edited.text, author, { expectedSha256: file.sha256 });
      return { ...writeResult(root.kind, outcome), replacements: edited.replacements };
    });
  },
});

function searchResult(root: FileRootKind, mode: "text" | "regex", hits: readonly SearchHit[], truncated: boolean) {
  return {
    ok: true as const,
    root,
    mode,
    truncated,
    hits: hits
      .slice(0, MAX_SEARCH_HITS)
      .map((hit) => ({ path: hit.path, line: hit.line, text: cutText(hit.text, MAX_HIT_TEXT_CHARS) })),
  };
}

export const searchFilesTool = defineTool({
  key: "search_files",
  name: "Search files",
  description: `Find text inside files. ${ROOT_HELP} pattern: plain text by default, case sensitive, matched within one line; set regex to true to read it as a JavaScript regular expression instead. At most 200 characters. Returns {path, line, text} for each matching line, at most ${MAX_SEARCH_HITS}, with truncated set when there are more. ${GLOB_HELP}`,
  schema: z
    .object({
      root: rootSchema,
      pattern: z.string().max(2000),
      glob: z.string().max(2000).optional(),
      regex: z.boolean().optional(),
    })
    .strict(),
  trust: "user_content",
  execute: async ({ root: rootKind, pattern, glob, regex }, tenant) => {
    const useRegex = regex === true;
    const refusal = checkSearchPattern(pattern, useRegex) ?? checkGlob(glob);
    if (refusal) {
      return refusal;
    }
    return withRoot(tenant, rootKind, async ({ root }) => {
      if (useRegex) {
        const outcome = await searchByRegex(root, pattern, glob);
        return isFileRefusal(outcome) ? outcome : searchResult(root.kind, "regex", outcome.hits, outcome.truncated);
      }
      const found = await root.search(pattern, glob);
      return searchResult(root.kind, "text", found, found.length > MAX_SEARCH_HITS);
    });
  },
});

export const deleteFileTool = defineTool({
  key: "delete_file",
  name: "Delete file",
  description: `Delete one file. ${ROOT_HELP} On the desk the delete is saved at once and the file's earlier versions are kept. On the "folder" root nothing is deleted yet: the result has status pending_approval and the file is removed only after the owner approves, so say that it is waiting. Only delete a file the user asked you to remove.`,
  schema: z
    .object({
      root: rootSchema,
      path: z.string().max(512),
    })
    .strict(),
  trust: "user_content",
  execute: async ({ root: rootKind, path }, tenant) => {
    const parsed = parseDeskPath(path);
    if (isFileRefusal(parsed)) {
      return parsed;
    }
    return withRoot(tenant, rootKind, async ({ root, author }) =>
      writeResult(root.kind, await root.remove(parsed, author)),
    );
  },
});

export const FILE_TOOLS = [listFilesTool, readFileTool, writeFileTool, editFileTool, searchFilesTool, deleteFileTool];
