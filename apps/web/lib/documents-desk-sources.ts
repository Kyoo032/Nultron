/**
 * The Documents form's side of "use desk files as sources" and of the checks the host runs on a draft.
 *
 * Pure rules, no React and no network, so each is tested on its own (`documents-desk-sources.test.ts`).
 * The host is the authority: it reads the files, caps them and refuses a bad path. Nothing here
 * decides what the model sees; it only spares a round trip and says the outcome in the owner's language.
 */
import type { DocumentDraft } from "@/lib/document-outline";
import type { FileEntry } from "@/lib/files-model";

/** Mirrors `MAX_SOURCE_FILES` in `packages/host/src/desk-sources.ts`. */
export const MAX_DESK_SOURCE_FILES = 5;

/** Mirrors the host's 120k-character ceiling on all source material in one request (`job-source.ts`). */
export const DESK_SOURCE_MAX_CHARS = 120_000;

/** The files that can be picked, A to Z by path. Directories are not sources. */
export function pickableFiles(entries: readonly FileEntry[]): FileEntry[] {
  return entries
    .filter((entry) => entry.kind === "file")
    .sort((a, b) => a.path.localeCompare(b.path, "en", { numeric: true, sensitivity: "base" }));
}

/**
 * A desk path as its folders and its file name, so a narrow row can shorten the folders and keep the
 * name. `dir` keeps its trailing slash; a top-level file has an empty `dir`.
 */
export function splitDeskPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? { dir: "", name: path } : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

/** Add `path`, or remove it when it is already picked. At the cap an add changes nothing. */
export function toggleDeskSource(selected: readonly string[], path: string): string[] {
  if (selected.includes(path)) {
    return selected.filter((item) => item !== path);
  }
  return selected.length >= MAX_DESK_SOURCE_FILES ? [...selected] : [...selected, path];
}

/** Drop picked paths that are no longer on the desk, so a deleted file does not make every request fail. */
export function pruneDeskSources(selected: readonly string[], onDesk: readonly string[]): string[] {
  const live = new Set(onDesk);
  return selected.filter((path) => live.has(path));
}

/**
 * Whether the picked files and the pasted text together pass the source ceiling. Bytes stand in for
 * characters, which they match for English and overcount for other scripts, so this only warns early.
 */
export function deskSourcesOverLimit(
  selected: readonly string[],
  entries: readonly FileEntry[],
  pastedChars: number,
): boolean {
  const bytes = new Map(entries.map((entry) => [entry.path, entry.bytes]));
  const total = selected.reduce((sum, path) => sum + (bytes.get(path) ?? 0), pastedChars);
  return total > DESK_SOURCE_MAX_CHARS;
}

/** The request field for the picked files; nothing when none are picked, so the body is as it was. */
export function sourceFilesBody(selected: readonly string[]): { sourceFiles?: string[] } {
  return selected.length > 0 ? { sourceFiles: [...selected] } : {};
}

// ---- the host's check report -------------------------------------------------------------------

export type DocumentCheckKind = "structure" | "grounding";

export type DocumentChecksView = {
  readonly passed: boolean;
  readonly rounds: number;
  readonly failures: ReadonlyArray<{
    readonly check: DocumentCheckKind;
    readonly error: string;
    /** Zero-based sections the failure is about. */
    readonly sections: readonly number[];
  }>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readChecks(raw: unknown): DocumentChecksView | null {
  if (!isObject(raw) || !Array.isArray(raw.failures)) {
    return null;
  }
  const failures: Array<DocumentChecksView["failures"][number]> = [];
  for (const item of raw.failures) {
    if (!isObject(item) || (item.check !== "structure" && item.check !== "grounding")) {
      continue;
    }
    const sections = Array.isArray(item.sections)
      ? item.sections.filter((index): index is number => Number.isInteger(index) && (index as number) >= 0)
      : [];
    failures.push({ check: item.check, error: typeof item.error === "string" ? item.error : "", sections });
  }
  return {
    passed: raw.passed === true && failures.length === 0,
    rounds: typeof raw.rounds === "number" ? raw.rounds : 0,
    failures,
  };
}

/** The generate response as the draft the preview and the download use, and the checks it carries. */
export function splitDraftResponse(data: unknown): { draft: DocumentDraft; checks: DocumentChecksView | null } {
  const record = isObject(data) ? data : {};
  const { checks, ...draft } = record;
  return { draft: draft as DocumentDraft, checks: readChecks(checks) };
}

export type DocumentChecksNoteModel =
  | { readonly kind: "grounding"; readonly headings: readonly string[] }
  | { readonly kind: "structure" };

/**
 * What the page says about checks that still failed after the repair round, or null when nothing
 * failed. A grounding failure wins: it names sections the person can act on.
 */
export function checksNote(
  checks: DocumentChecksView | null,
  sections: ReadonlyArray<{ readonly heading: string }>,
): DocumentChecksNoteModel | null {
  if (!checks || checks.passed || checks.failures.length === 0) {
    return null;
  }
  const grounding = checks.failures.find((failure) => failure.check === "grounding");
  if (grounding) {
    const named = [...new Set(grounding.sections)]
      .map((index) => sections[index]?.heading)
      .filter((heading): heading is string => typeof heading === "string" && heading.trim() !== "");
    // Two sections can share a heading; the note names it once.
    const headings = [...new Set(named)];
    if (headings.length > 0) {
      return { kind: "grounding", headings };
    }
  }
  return checks.failures.some((failure) => failure.check === "structure") ? { kind: "structure" } : null;
}
