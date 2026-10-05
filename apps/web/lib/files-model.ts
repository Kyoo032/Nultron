/**
 * The Files section's pure rules: the shapes the host sends, how a list groups by folder, what a new
 * path or an uploaded file must look like before it is sent, and how a text is cut into numbered lines.
 *
 * Nothing here touches React, the network or the clock, so every rule is tested on its own
 * (`files-model.test.ts`). The host is the authority on every limit; the checks here only spare a round
 * trip and say it in the owner's language (`files.*` in the catalogs).
 */
import { formatBytes } from "@agentforge/core/format-bytes";
import type { AppLocale } from "@agentforge/core/locale";
import { getLocale } from "./i18n";

/** `GET /api/v1/files` rows (`FileEntry`, `packages/core/src/tools/files/types.ts`). */
export type FileEntry = {
  readonly path: string;
  readonly kind: "file" | "dir";
  readonly bytes: number;
  readonly updatedAt: number;
  readonly version: number | null;
};

/** `GET /api/v1/files/content` and `/version` (`FileRead`). */
export type FileRead = {
  readonly path: string;
  readonly text: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly version: number | null;
};

/** `GET /api/v1/files/versions` rows (`DeskFileVersion`, `packages/host/src/desk-files/file-store.ts`). */
export type FileVersion = {
  readonly version: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly authorKind: "user" | "agent";
  /** The user id, or the run id for an agent. */
  readonly authorId: string;
  readonly mode: string | null;
  readonly createdAt: number;
};

/**
 * Mirrors `MAX_FILE_BYTES` (`packages/core/src/tools/files/lines.ts`). The renderer does not import that
 * module because it sits beside the tool registry; `files-model.test.ts` reads the source and fails the
 * moment the two disagree.
 */
export const FILES_MAX_BYTES = 2 * 1024 * 1024;
/** Mirrors `MAX_PATH_CHARS` and `MAX_PATH_SEGMENTS` in `packages/core/src/tools/files/path.ts`. */
export const FILES_MAX_PATH_CHARS = 240;
export const FILES_MAX_PATH_SEGMENTS = 8;
/** More lines than this are not drawn: a 2 MB file of short lines would be tens of thousands of rows. */
export const FILES_MAX_RENDER_LINES = 5000;

export type FileGroup = {
  /** `""` for the top level, otherwise the folder path without a trailing slash. */
  readonly folder: string;
  readonly items: readonly FileEntry[];
};

export function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

export function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * Files grouped by the folder they sit in: the top level first, then folders A to Z, and inside each
 * group the files A to Z. Directories (the desk store has none) are dropped. A new array every call.
 */
export function groupByFolder(entries: readonly FileEntry[]): FileGroup[] {
  const byFolder = new Map<string, FileEntry[]>();
  for (const entry of entries) {
    if (entry.kind !== "file") {
      continue;
    }
    const folder = folderOf(entry.path);
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), entry]);
  }
  const compare = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
  return [...byFolder.entries()]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : compare(a, b)))
    .map(([folder, items]) => ({
      folder,
      items: [...items].sort((a, b) => compare(baseName(a.path), baseName(b.path))),
    }));
}

export type PathProblem = "empty" | "absolute" | "backslash" | "dots" | "emptyPart" | "tooLong" | "tooDeep";

/**
 * The first reason a typed path would be refused, or null. A shortlist of the host's `parseDeskPath`
 * rules, enough to catch a typo before sending; the host still decides (and answers `bad_path` for the
 * rest: reserved names, characters Windows forbids, control characters).
 */
export function checkNewPath(raw: string): PathProblem | null {
  const path = raw.trim();
  if (path === "") {
    return "empty";
  }
  if (path.length > FILES_MAX_PATH_CHARS) {
    return "tooLong";
  }
  if (path.includes("\\")) {
    return "backslash";
  }
  if (path.startsWith("/")) {
    return "absolute";
  }
  const segments = path.split("/");
  if (segments.length > FILES_MAX_PATH_SEGMENTS) {
    return "tooDeep";
  }
  if (segments.some((segment) => segment === "")) {
    return "emptyPart";
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "dots";
  }
  return null;
}

/** A size as the screen writes it, its unit kept on the number's line when the row wraps. */
export function bytesLabel(bytes: number): string {
  return formatBytes(bytes).replace(" ", "\u00a0");
}

/** UTF-8 size of a text, the unit the host's 2 MB cap counts. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** `?file=notes%2Fplan.md` as the deep link another page sends, or null. Not validated beyond shape. */
export function fileFromSearch(search: string): string | null {
  let value: string | null;
  try {
    value = new URLSearchParams(search).get("file");
  } catch {
    return null;
  }
  const path = value?.trim() ?? "";
  if (path === "" || path.length > FILES_MAX_PATH_CHARS) {
    return null;
  }
  return path;
}

export type UploadRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "too_large" | "binary" | "read_failed" };

export type UploadSource = {
  readonly size: number;
  readonly arrayBuffer: () => Promise<ArrayBuffer>;
};

/**
 * A picked file as text, or the reason it cannot be one. Over the cap is refused before a byte is
 * read. Binary is refused by decoding as strict UTF-8 (a stray byte throws) and by a NUL, which the
 * host refuses too. The host re-checks size, NUL and encoding on save; this only spares the upload.
 */
export async function readUploadText(file: UploadSource): Promise<UploadRead> {
  if (file.size > FILES_MAX_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    return { ok: false, reason: "read_failed" };
  }
  if (buffer.byteLength > FILES_MAX_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return { ok: false, reason: "binary" };
  }
  if (text.includes("\u0000")) {
    return { ok: false, reason: "binary" };
  }
  return { ok: true, text };
}

export type NumberedText = {
  readonly lines: readonly string[];
  /** Lines in the whole text, before the cap. */
  readonly total: number;
  readonly truncated: boolean;
};

/** A text as lines, a trailing newline not counting as a line of its own, capped for drawing. */
export function numberLines(text: string, cap: number = FILES_MAX_RENDER_LINES): NumberedText {
  if (text === "") {
    return { lines: [], total: 0, truncated: false };
  }
  const all = text.split(/\r\n|\r|\n/);
  if (all.length > 1 && all[all.length - 1] === "") {
    all.pop();
  }
  const truncated = all.length > cap;
  return { lines: truncated ? all.slice(0, cap) : all, total: all.length, truncated };
}

export type AuthorWho = { readonly who: "you" | "teammate" } | { readonly who: "agent"; readonly mode: string | null };

/**
 * Who saved a version. `selfUserId` is the signed-in person on the hosted app and null on Personal,
 * where the one local owner is the only person there is, so every `user` version is theirs.
 */
export function authorOf(version: FileVersion, selfUserId: string | null): AuthorWho {
  if (version.authorKind === "agent") {
    return { who: "agent", mode: version.mode };
  }
  return { who: selfUserId === null || version.authorId === selfUserId ? "you" : "teammate" };
}

const LOCALE_TAGS: Record<AppLocale, string> = { en: "en-US", id: "id-ID" };
const formatters = new Map<AppLocale, Intl.DateTimeFormat>();

/** A moment as the owner's locale writes it, or an empty string for a time that is not one. */
export function formatWhen(ms: number, locale: AppLocale = getLocale()): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "";
  }
  let formatter = formatters.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(LOCALE_TAGS[locale] ?? LOCALE_TAGS.en, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    formatters.set(locale, formatter);
  }
  return formatter.format(new Date(ms));
}

/** Catalog key (under `files.errors.`) for a host error code. Unknown codes read as the generic one. */
const ERROR_KEYS: Readonly<Record<string, string>> = {
  not_found: "notFound",
  too_large: "tooLarge",
  too_many_files: "tooMany",
  denied: "denied",
  bad_path: "badPath",
  invalid_request: "badPath",
  storage_quota_exceeded: "quota",
  root_unavailable: "unavailable",
  network: "network",
  bad_response: "badResponse",
};

export function filesErrorKey(code: string): string {
  return `files.errors.${ERROR_KEYS[code] ?? "generic"}`;
}

/** Every catalog key `filesErrorKey` can return, so a test can hold the catalogs to it. */
export function filesErrorKeys(): string[] {
  return [...new Set(["generic", ...Object.values(ERROR_KEYS)])].map((key) => `files.errors.${key}`);
}
