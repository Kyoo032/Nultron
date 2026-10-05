/**
 * The contract every file tool codes against. A root is either the desk's own versioned store
 * (both products) or a real folder the owner opened (Personal only, writes need approval). The
 * tools never branch on the root kind; the root decides what a write means.
 */

/** A desk-relative POSIX path, parsed once at the tool boundary by `parseDeskPath`. */
export type DeskPath = string & { readonly __brand: "DeskPath" };

export type FileRootKind = "desk" | "folder";

export type FileAuthor =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "agent"; readonly runId: string; readonly mode: string };

export type FileEntry = {
  readonly path: DeskPath;
  readonly kind: "file" | "dir";
  readonly bytes: number;
  readonly updatedAt: number;
  /** Desk files only: the head version. */
  readonly version?: number;
};

export type FileRead = {
  readonly path: DeskPath;
  readonly text: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly version?: number;
};

export type SearchHit = {
  readonly path: DeskPath;
  readonly line: number;
  readonly text: string;
};

export type WriteOutcome =
  | { readonly status: "saved"; readonly path: DeskPath; readonly version: number }
  | { readonly status: "pending_approval"; readonly path: DeskPath; readonly proposalId: string };

/**
 * What a caller may require of a write.
 *
 * `expectedSha256` is compare-and-set: the write applies only if the file still has the hash the
 * caller read. An edit is read, change, write, and a step's tool calls run together, so without it
 * two edits to one file both report "saved" and the second silently overwrites the first. A root
 * that finds a different hash refuses with `conflict`. Leave it out to overwrite (that is what
 * `write_file` means).
 */
export type WriteOptions = {
  readonly expectedSha256?: string;
};

export type FileRoot = {
  readonly kind: FileRootKind;
  list(dir: DeskPath | null, glob?: string): Promise<FileEntry[]>;
  read(path: DeskPath): Promise<FileRead>;
  write(path: DeskPath, content: string, by: FileAuthor, options?: WriteOptions): Promise<WriteOutcome>;
  remove(path: DeskPath, by: FileAuthor): Promise<WriteOutcome>;
  search(pattern: string, glob?: string): Promise<SearchHit[]>;
};

/** Refusals a root or a tool returns to the model. Each is a fixed code, never a raw path or stack. */
export type FileRefusalCode =
  | "bad_path"
  | "not_found"
  | "too_large"
  | "too_many_files"
  | "denied"
  | "no_match"
  | "bad_pattern"
  | "ambiguous_match"
  | "root_unavailable"
  | "quota"
  /** A write that expected a file as the caller read it, and the file has changed since. */
  | "conflict";

export type FileRefusal = {
  readonly ok: false;
  readonly code: FileRefusalCode;
  readonly message: string;
};
