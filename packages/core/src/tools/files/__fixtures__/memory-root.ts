import { globMatcher } from "../glob";
import { utf8ByteLength } from "../lines";
import { FileRootError } from "../refusals";
import { MAX_SEARCH_HITS, searchLiteralLines } from "../search-text";
import type {
  DeskPath,
  FileAuthor,
  FileEntry,
  FileRoot,
  FileRootKind,
  SearchHit,
  WriteOptions,
  WriteOutcome,
} from "../types";

type StoredFile = { text: string; version: number };

export type RootCall = {
  readonly op: "write" | "remove";
  readonly path: DeskPath;
  readonly by: FileAuthor;
  readonly content?: string;
  /** Present only when the caller passed write options, so a plain write records exactly what it did. */
  readonly options?: WriteOptions;
};

export type MemoryRoot = {
  readonly root: FileRoot;
  readonly files: Map<string, StoredFile>;
  readonly calls: RootCall[];
};

/**
 * A `FileRoot` over a Map. `desk` saves a write as the next version. `folder` records the write and
 * answers `pending_approval` without changing anything, the way the real folder root will.
 */
export function createMemoryRoot(kind: FileRootKind, seed: Record<string, string> = {}): MemoryRoot {
  const files = new Map<string, StoredFile>(
    Object.entries(seed).map(([path, text]) => [path, { text, version: 1 }] as const),
  );
  const calls: RootCall[] = [];

  const entriesFor = (dir: DeskPath | null, glob?: string): FileEntry[] => {
    const matches = glob === undefined ? () => true : globMatcher(glob);
    return [...files.entries()]
      .filter(([path]) => (dir === null || path.startsWith(`${dir}/`)) && matches(path))
      .map(([path, file]) => ({
        path: path as DeskPath,
        kind: "file" as const,
        bytes: utf8ByteLength(file.text),
        updatedAt: 1_700_000_000_000,
        version: file.version,
      }));
  };

  const root: FileRoot = {
    kind,
    list: async (dir, glob) => entriesFor(dir, glob),
    read: async (path) => {
      const file = files.get(path);
      if (!file) {
        throw new FileRootError("not_found", "No file at that path.");
      }
      return {
        path,
        text: file.text,
        sha256: `sha-${file.version}`,
        bytes: utf8ByteLength(file.text),
        version: file.version,
      };
    },
    write: async (path, content, by, options): Promise<WriteOutcome> => {
      calls.push({ op: "write", path, by, content, ...(options === undefined ? {} : { options }) });
      if (kind === "folder") {
        return { status: "pending_approval", path, proposalId: `proposal-${calls.length}` };
      }
      const version = (files.get(path)?.version ?? 0) + 1;
      files.set(path, { text: content, version });
      return { status: "saved", path, version };
    },
    remove: async (path, by): Promise<WriteOutcome> => {
      calls.push({ op: "remove", path, by });
      const file = files.get(path);
      if (!file) {
        throw new FileRootError("not_found", "No file at that path.");
      }
      if (kind === "folder") {
        return { status: "pending_approval", path, proposalId: `proposal-${calls.length}` };
      }
      files.delete(path);
      return { status: "saved", path, version: file.version + 1 };
    },
    search: async (pattern, glob) => {
      const hits: SearchHit[] = [];
      for (const entry of entriesFor(null, glob)) {
        const file = files.get(entry.path);
        if (file) {
          hits.push(...searchLiteralLines(entry.path, file.text, pattern, MAX_SEARCH_HITS + 1 - hits.length));
        }
      }
      return hits;
    },
  };
  return { root, files, calls };
}
