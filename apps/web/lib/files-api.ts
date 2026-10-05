/**
 * The desk files routes (`packages/host/src/desk-files/routes.ts`) as typed calls.
 *
 *   GET    /api/v1/files           list (query dir, glob)
 *   GET    /api/v1/files/content   head text (query path)
 *   GET    /api/v1/files/versions  history (query path)
 *   GET    /api/v1/files/version   one version's text (query path, version)
 *   POST   /api/v1/files           save {path, content}
 *   POST   /api/v1/files/revert    {path, version}: a new version holding an old body
 *   DELETE /api/v1/files           soft delete (query path)
 *
 * Paths ride in the query, never in the URL, exactly as the host reads them. Every call answers an
 * outcome and never throws: a dead network is `network`, a body this app cannot read is `bad_response`,
 * and a host refusal keeps the host's own code so the screen can say it in the owner's language.
 */
import { apiFetch } from "@/lib/api-client";
import type { FileEntry, FileRead, FileVersion } from "./files-model";

/** The slice of `apiFetch` these calls use, so a test can hand it a stub. */
export type FilesFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type FilesOutcome<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: string; readonly status: number };

export type SavedFile = { readonly path: string; readonly version: number };

export type FilesApi = {
  list(dir?: string, glob?: string): Promise<FilesOutcome<FileEntry[]>>;
  content(path: string): Promise<FilesOutcome<FileRead>>;
  versions(path: string): Promise<FilesOutcome<FileVersion[]>>;
  version(path: string, version: number): Promise<FilesOutcome<FileRead>>;
  save(path: string, content: string): Promise<FilesOutcome<SavedFile>>;
  revert(path: string, version: number): Promise<FilesOutcome<SavedFile>>;
  remove(path: string): Promise<FilesOutcome<SavedFile>>;
};

const BASE = "/api/v1/files";

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseEntry(raw: unknown): FileEntry | null {
  if (!isObj(raw) || typeof raw.path !== "string" || (raw.kind !== "file" && raw.kind !== "dir")) {
    return null;
  }
  return {
    path: raw.path,
    kind: raw.kind,
    bytes: num(raw.bytes) ?? 0,
    updatedAt: num(raw.updatedAt) ?? 0,
    version: num(raw.version),
  };
}

function parseRead(raw: unknown): FileRead | null {
  if (!isObj(raw) || typeof raw.path !== "string" || typeof raw.text !== "string") {
    return null;
  }
  return {
    path: raw.path,
    text: raw.text,
    sha256: typeof raw.sha256 === "string" ? raw.sha256 : "",
    bytes: num(raw.bytes) ?? 0,
    version: num(raw.version),
  };
}

function parseVersion(raw: unknown): FileVersion | null {
  if (!isObj(raw)) {
    return null;
  }
  const version = num(raw.version);
  if (version === null || (raw.authorKind !== "user" && raw.authorKind !== "agent")) {
    return null;
  }
  return {
    version,
    bytes: num(raw.bytes) ?? 0,
    sha256: typeof raw.sha256 === "string" ? raw.sha256 : "",
    authorKind: raw.authorKind,
    authorId: typeof raw.authorId === "string" ? raw.authorId : "",
    mode: typeof raw.mode === "string" ? raw.mode : null,
    createdAt: num(raw.createdAt) ?? 0,
  };
}

function parseSaved(raw: unknown): SavedFile | null {
  if (!isObj(raw) || raw.status !== "saved" || typeof raw.path !== "string") {
    return null;
  }
  const version = num(raw.version);
  return version === null ? null : { path: raw.path, version };
}

function parseList<T>(raw: unknown, parseOne: (item: unknown) => T | null): T[] | null {
  if (!isObj(raw) || !Array.isArray(raw.items)) {
    return null;
  }
  const items: T[] = [];
  for (const item of raw.items) {
    const parsed = parseOne(item);
    if (parsed === null) {
      return null;
    }
    items.push(parsed);
  }
  return items;
}

/** The host's `{ error: { code, message } }`, reduced to its code. */
function errorCode(body: unknown): string {
  if (isObj(body) && isObj(body.error) && typeof body.error.code === "string") {
    return body.error.code;
  }
  return "error";
}

function query(params: Readonly<Record<string, string | number | undefined>>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}

function jsonPost(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export function createFilesApi(fetcher: FilesFetch = apiFetch): FilesApi {
  async function call<T>(
    url: string,
    init: RequestInit | undefined,
    parse: (body: unknown) => T | null,
  ): Promise<FilesOutcome<T>> {
    let res: Response;
    try {
      res = await fetcher(url, init);
    } catch {
      return { ok: false, code: "network", status: 0 };
    }
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, code: errorCode(body), status: res.status };
    }
    const data = parse(body);
    return data === null ? { ok: false, code: "bad_response", status: res.status } : { ok: true, data };
  }

  return {
    list: (dir, glob) => call(`${BASE}${query({ dir, glob })}`, undefined, (body) => parseList(body, parseEntry)),
    content: (path) => call(`${BASE}/content${query({ path })}`, undefined, parseRead),
    versions: (path) => call(`${BASE}/versions${query({ path })}`, undefined, (body) => parseList(body, parseVersion)),
    version: (path, version) => call(`${BASE}/version${query({ path, version })}`, undefined, parseRead),
    save: (path, content) => call(BASE, jsonPost({ path, content }), parseSaved),
    revert: (path, version) => call(`${BASE}/revert`, jsonPost({ path, version }), parseSaved),
    remove: (path) => call(`${BASE}${query({ path })}`, { method: "DELETE" }, parseSaved),
  };
}
