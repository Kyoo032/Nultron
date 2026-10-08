/**
 * Reading the shapes the file, Knowledge and code tools hand back, for the Chat tool rows.
 * Pure data in, plain data out: no React, no catalog, so the labels in `lib/tool-labels.ts` and the
 * row components share one reading of a tool result.
 *
 * The shapes are the tools' own (the renderer never imports the host or core):
 * - a file tool succeeds with `{ ok: true, ... }` and refuses with `{ ok: false, code, message }`;
 * - a folder write is not applied yet: `{ ok: true, status: "pending_approval", path, proposalId }`;
 * - `knowledge_search` answers `{ results, note? }` or `{ ok: false, reason: "unavailable", message }`;
 * - `run_code` answers a `CodeRunResult`: `{ ok, stdout, stderr, filesWritten, reason? }`;
 * - `build_deck` answers `{ ok: true, artifactId, filename, slideCount }` or `{ ok: false, reason, message }`
 *   (`deck-result.ts` reads it for the card);
 * - a spent budget refuses any tool with `{ ok: false, reason: "budget", message }`.
 */

export const FILE_TOOL_KEYS = [
  "list_files",
  "read_file",
  "write_file",
  "edit_file",
  "search_files",
  "delete_file",
] as const;

export type FileToolKey = (typeof FILE_TOOL_KEYS)[number];
export type RichToolKey = FileToolKey | "knowledge_search" | "run_code" | "build_deck";

const RICH_TOOLS: ReadonlySet<string> = new Set<string>([
  ...FILE_TOOL_KEYS,
  "knowledge_search",
  "run_code",
  "build_deck",
]);
const FILE_TOOLS: ReadonlySet<string> = new Set<string>(FILE_TOOL_KEYS);

/** The tools whose rows say more than one line. Every other tool keeps the one-line summary. */
export function isRichTool(key: string): key is RichToolKey {
  return RICH_TOOLS.has(key);
}

export function isFileTool(key: string): key is FileToolKey {
  return FILE_TOOLS.has(key);
}

/** The tools that change a file, and so can be held for the owner's approval on a folder. */
export function isWriteTool(key: string): boolean {
  return key === "write_file" || key === "edit_file" || key === "delete_file";
}

export type ToolStatus = "started" | "completed";
export type Rec = Readonly<Record<string, unknown>>;

/** An object payload. A JSON string of an object is read once; anything else is not a record. */
export function asRecord(value: unknown): Rec | null {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text.startsWith("{")) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Rec) : null;
    } catch {
      return null;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Rec;
  }
  return null;
}

export function readString(record: Rec | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readNumber(record: Rec | null, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readList(record: Rec | null, key: string): unknown[] | undefined {
  const value = record?.[key];
  return Array.isArray(value) ? value : undefined;
}

export type ToolOutcome =
  | { readonly state: "running" }
  | { readonly state: "done" }
  | { readonly state: "budget"; readonly message: string }
  | { readonly state: "refused"; readonly message: string }
  | { readonly state: "pending"; readonly path: string };

const CODE_FAILURES = ["timeout", "memory", "syntax", "runtime", "too_large", "busy", "unavailable"] as const;
export type CodeFailure = (typeof CODE_FAILURES)[number];

export type CodeResult = {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly filesWritten: ReadonlyArray<{ readonly path: string; readonly version?: number }>;
  readonly reason?: CodeFailure | string;
};

/** A `CodeRunResult`, or null when the output is a refusal or something else. */
export function readCodeResult(output: unknown): CodeResult | null {
  const record = asRecord(output);
  if (!record || (record.ok === false && record.reason === "budget")) {
    return null;
  }
  const written = readList(record, "filesWritten");
  const looksLikeRun =
    typeof record.stdout === "string" ||
    typeof record.stderr === "string" ||
    written !== undefined ||
    (CODE_FAILURES as readonly string[]).includes(String(record.reason));
  if (!looksLikeRun) {
    return null;
  }
  const filesWritten = (written ?? []).flatMap((entry) => {
    const item = asRecord(entry);
    const path = readString(item, "path");
    if (!path) {
      return [];
    }
    const version = readNumber(item, "version");
    return [version === undefined ? { path } : { path, version }];
  });
  return {
    ok: record.ok === true,
    stdout: typeof record.stdout === "string" ? record.stdout : "",
    stderr: typeof record.stderr === "string" ? record.stderr : "",
    filesWritten,
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
  };
}

function refusalMessage(record: Rec): string {
  return readString(record, "message") ?? readString(record, "error") ?? "";
}

/**
 * Which state a tool call is in. A budget refusal and a refusal are different on screen (the budget
 * one says the run's tool allowance is gone); a folder write waiting for the owner is a third; a
 * `run_code` that ran and failed is `done` here, because the code row reads its own failure reason.
 */
export function classifyOutcome(toolKey: string, status: ToolStatus, output: unknown): ToolOutcome {
  if (status === "started") {
    return { state: "running" };
  }
  const record = asRecord(output);
  if (!record) {
    return { state: "done" };
  }
  if (record.ok === false && record.reason === "budget") {
    return { state: "budget", message: refusalMessage(record) };
  }
  if (record.status === "pending_approval") {
    return { state: "pending", path: readString(record, "path") ?? "" };
  }
  if (toolKey === "run_code" && readCodeResult(record)) {
    return { state: "done" };
  }
  if (record.ok === false || record.success === false) {
    return { state: "refused", message: refusalMessage(record) };
  }
  return { state: "done" };
}

/** Where the Knowledge Base opens one desk file. */
export function knowledgeFileHref(path: string): string {
  return `/knowledge?file=${encodeURIComponent(path)}`;
}

/** A saved desk write has a file to open. A delete does not, and a folder write is not applied yet. */
export function savedDeskPath(toolKey: string, output: unknown): { path: string; version?: number } | null {
  if (toolKey !== "write_file" && toolKey !== "edit_file") {
    return null;
  }
  const record = asRecord(output);
  if (record?.ok !== true || record.status !== "saved" || record.root === "folder") {
    return null;
  }
  const path = readString(record, "path");
  if (!path) {
    return null;
  }
  const version = readNumber(record, "version");
  return version === undefined ? { path } : { path, version };
}
