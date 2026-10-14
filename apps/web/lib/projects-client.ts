/**
 * The Workspace calls (team-board-spec.md section 2b, K-D19 and K-D20). Server mode only: on Personal
 * the host answers the router's own 404 to every one of them, and the page that calls them is not
 * routed there. On screen a project is a Workspace; in code and on the wire it stays `projects`.
 *
 * Every answer is checked before the page sees it. A refusal keeps the host's own sentence, because
 * the host is the one that decides (a 403 on Remove says why), so the page shows it as it is.
 */
import { apiFetch, isElectron } from "./api-client";
import { filenameFromDisposition } from "./download-name";

export type ProjectVisibility = "private" | "workspace";

export type ProjectRecord = {
  id: string;
  name: string;
  visibility: ProjectVisibility;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

export type ProjectFile = {
  id: string;
  title: string;
  mime: string;
  sizeBytes: number;
  ownerUserId: string | null;
  updatedAt: number;
};

export class ProjectsError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ProjectsError";
    this.code = code;
    this.status = status;
  }
}

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function malformed(): ProjectsError {
  return new ProjectsError("projects_malformed", "The Workspace answer could not be read.", 502);
}

function str(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw malformed();
  }
  return value;
}

function num(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw malformed();
  }
  return value;
}

function list<T>(value: unknown, parse: (row: Row) => T): T[] {
  if (!Array.isArray(value)) {
    throw malformed();
  }
  return value.map((entry) => {
    if (!isRow(entry)) {
      throw malformed();
    }
    return parse(entry);
  });
}

function parseVisibility(value: unknown): ProjectVisibility {
  if (value !== "private" && value !== "workspace") {
    throw malformed();
  }
  return value;
}

export function parseProject(row: Row): ProjectRecord {
  return {
    id: str(row, "id"),
    name: str(row, "name"),
    visibility: parseVisibility(row.visibility),
    createdBy: str(row, "createdBy"),
    createdAt: num(row, "createdAt"),
    updatedAt: num(row, "updatedAt"),
  };
}

export function parseProjectFile(row: Row): ProjectFile {
  return {
    id: str(row, "id"),
    title: str(row, "title"),
    mime: str(row, "mime"),
    sizeBytes: num(row, "sizeBytes"),
    ownerUserId: row.ownerUserId === null || row.ownerUserId === undefined ? null : str(row, "ownerUserId"),
    updatedAt: num(row, "updatedAt"),
  };
}

function errorFrom(payload: unknown, status: number): ProjectsError {
  const error = isRow(payload) && isRow(payload.error) ? payload.error : null;
  const code = error && typeof error.code === "string" ? error.code : "projects_error";
  const message = error && typeof error.message === "string" ? error.message : "The Workspace request failed.";
  return new ProjectsError(code, message, status);
}

async function call(path: string, init: RequestInit = {}): Promise<Row> {
  const res = await apiFetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw errorFrom(data, res.status);
  }
  if (!isRow(data)) {
    throw malformed();
  }
  return data;
}

function send(method: string, path: string, body?: unknown): Promise<Row> {
  return call(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
}

const projectPath = (projectId: string) => `/api/v1/projects/${encodeURIComponent(projectId)}`;

export async function listProjects(): Promise<ProjectRecord[]> {
  const data = await call("/api/v1/projects");
  return list(data.items, parseProject);
}

export async function createProject(name: string): Promise<ProjectRecord> {
  const data = await send("POST", "/api/v1/projects", { name });
  if (!isRow(data.project)) {
    throw malformed();
  }
  return parseProject(data.project);
}

/** Rename, or flip the switch: `visibility` is `private` (only its maker) or `workspace` (the company). */
export async function updateProject(
  projectId: string,
  change: { name?: string; visibility?: ProjectVisibility },
): Promise<ProjectRecord> {
  const data = await send("PATCH", projectPath(projectId), change);
  if (!isRow(data.project)) {
    throw malformed();
  }
  return parseProject(data.project);
}

export async function archiveProject(projectId: string): Promise<void> {
  await send("POST", `${projectPath(projectId)}/archive`);
}

export async function listProjectFiles(projectId: string): Promise<ProjectFile[]> {
  const data = await call(`${projectPath(projectId)}/files`);
  return list(data.items, parseProjectFile);
}

export async function addProjectFile(projectId: string, artifactId: string): Promise<void> {
  await send("POST", `${projectPath(projectId)}/files`, { artifactId });
}

export async function removeProjectFile(projectId: string, artifactId: string): Promise<void> {
  await send("DELETE", `${projectPath(projectId)}/files/${encodeURIComponent(artifactId)}`);
}

/**
 * Downloads a file of a Workspace through the artifact route. The name is the one the host sends in
 * `Content-Disposition` (`filename*` first), so a Hindi or accented title keeps its characters.
 * The desktop shell writes the bytes through its own save dialog inside `apiFetch`.
 */
export async function downloadProjectFile(artifactId: string, fallbackName: string): Promise<void> {
  const res = await apiFetch(`/api/v1/artifacts/${encodeURIComponent(artifactId)}/file`);
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => null);
    throw errorFrom(data, res.status);
  }
  if (isElectron()) {
    return;
  }
  const blob = await res.blob();
  const name = filenameFromDisposition(res.headers.get("Content-Disposition")) ?? fallbackName;
  saveBlob(blob, name);
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
