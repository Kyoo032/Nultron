/**
 * The Workspace calls (team-board-spec.md section 2b, K-D20, K-D22, K-D23). Server mode only: on Personal
 * the host answers the router's own 404 to every one of them, and the page that calls them is not
 * routed there. On screen a project is a Workspace; in code and on the wire it stays `projects`.
 *
 * Every answer is checked before the page sees it. A refusal keeps the host's own sentence, because
 * the host is the one that decides (a 403 on Remove says why), so the page shows it as it is.
 */
import { apiFetch, isElectron } from "./api-client";
import { filenameFromDisposition } from "./download-name";

/** A person's role inside one Workspace (K-D23). Exactly one `owner`. */
export type WorkspaceRole = "owner" | "admin" | "member";

/** The roles the role route hands out. `owner` moves only by a hand-over. */
export type AssignableRole = Exclude<WorkspaceRole, "owner">;

export type ProjectRecord = {
  id: string;
  name: string;
  /** The caller's own role in this Workspace. */
  role: WorkspaceRole;
  memberCount: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

export type ProjectMember = {
  userId: string;
  name: string;
  role: WorkspaceRole;
  addedBy: string;
  addedAt: number;
};

/** An agent a member brought in. The same agent may be brought by several members, one row each. */
export type ProjectAgent = { agentId: string; broughtBy: string; addedAt: number };

export type ProjectPeople = { members: ProjectMember[]; agents: ProjectAgent[] };

/** A chat file, or a generated image or video the person put into the Workspace (SR-175). */
export type ProjectFileKind = "artifact" | "image" | "video";

export type ProjectFile = {
  id: string;
  kind: ProjectFileKind;
  title: string;
  mime: string;
  sizeBytes: number;
  ownerUserId: string | null;
  updatedAt: number;
  /** A host path a browser can show inline. Null for a chat file, which shows as a card. */
  previewUrl: string | null;
  /** A host path that saves the file as an attachment. */
  downloadUrl: string;
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

function parseRole(value: unknown): WorkspaceRole {
  if (value !== "owner" && value !== "admin" && value !== "member") {
    throw malformed();
  }
  return value;
}

export function parseProject(row: Row): ProjectRecord {
  return {
    id: str(row, "id"),
    name: str(row, "name"),
    role: parseRole(row.role),
    memberCount: num(row, "memberCount"),
    createdBy: str(row, "createdBy"),
    createdAt: num(row, "createdAt"),
    updatedAt: num(row, "updatedAt"),
  };
}

function parseMember(row: Row): ProjectMember {
  return {
    userId: str(row, "userId"),
    name: str(row, "name"),
    role: parseRole(row.role),
    addedBy: str(row, "addedBy"),
    addedAt: num(row, "addedAt"),
  };
}

function parseAgent(row: Row): ProjectAgent {
  return { agentId: str(row, "agentId"), broughtBy: str(row, "broughtBy"), addedAt: num(row, "addedAt") };
}

function parseFileKind(value: unknown): ProjectFileKind {
  if (value !== "artifact" && value !== "image" && value !== "video") {
    throw malformed();
  }
  return value;
}

function optionalStr(row: Row, key: string): string | null {
  return row[key] === null || row[key] === undefined ? null : str(row, key);
}

export function parseProjectFile(row: Row): ProjectFile {
  return {
    id: str(row, "id"),
    kind: parseFileKind(row.kind),
    title: str(row, "title"),
    mime: str(row, "mime"),
    sizeBytes: num(row, "sizeBytes"),
    ownerUserId: optionalStr(row, "ownerUserId"),
    updatedAt: num(row, "updatedAt"),
    previewUrl: optionalStr(row, "previewUrl"),
    downloadUrl: str(row, "downloadUrl"),
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

/** Rename. Who sees a Workspace is its members, so a rename sends the name and nothing else. */
export async function renameProject(projectId: string, name: string): Promise<ProjectRecord> {
  const data = await send("PATCH", projectPath(projectId), { name });
  if (!isRow(data.project)) {
    throw malformed();
  }
  return parseProject(data.project);
}

/** The people of a Workspace, owner first, and the agents its members brought in. */
export async function listProjectPeople(projectId: string): Promise<ProjectPeople> {
  const data = await call(`${projectPath(projectId)}/members`);
  return { members: list(data.members, parseMember), agents: list(data.agents, parseAgent) };
}

const memberPath = (projectId: string, userId: string) =>
  `${projectPath(projectId)}/members/${encodeURIComponent(userId)}`;

/** Invites a person of the company by their account id, the one thing the host's invite route takes. */
export async function inviteProjectMember(projectId: string, userId: string): Promise<ProjectMember[]> {
  const data = await send("POST", `${projectPath(projectId)}/members`, { userId });
  return list(data.members, parseMember);
}

export async function setProjectMemberRole(projectId: string, userId: string, role: AssignableRole): Promise<void> {
  await send("PATCH", memberPath(projectId, userId), { role });
}

/** Removes a person, or, with the caller's own id, leaves the Workspace. */
export async function removeProjectMember(projectId: string, userId: string): Promise<void> {
  await send("DELETE", memberPath(projectId, userId));
}

/** Hands the Workspace to another member. The caller stays on as an admin. */
export async function handOverProject(projectId: string, userId: string): Promise<void> {
  await send("POST", `${projectPath(projectId)}/owner`, { userId });
}

/** Brings an agent from the caller's own desk, by its mode id. */
export async function bringProjectAgent(projectId: string, agentId: string): Promise<ProjectAgent[]> {
  const data = await send("POST", `${projectPath(projectId)}/agents`, { agentId });
  return list(data.agents, parseAgent);
}

export async function takeOutProjectAgent(projectId: string, agentId: string): Promise<void> {
  await send("DELETE", `${projectPath(projectId)}/agents/${encodeURIComponent(agentId)}`);
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

/** Puts one of the person's own generated images or videos into the Workspace (SR-175). */
export async function addProjectMedia(projectId: string, mediaId: string): Promise<void> {
  await send("POST", `${projectPath(projectId)}/files`, { mediaId });
}

/** Takes a generated image or video out of the Workspace. The host decides whether the caller may. */
export async function removeProjectMedia(projectId: string, mediaId: string): Promise<void> {
  await send("DELETE", `${projectPath(projectId)}/media/${encodeURIComponent(mediaId)}`);
}

/** Downloads a chat file of a Workspace through the artifact route. */
export async function downloadProjectFile(artifactId: string, fallbackName: string): Promise<void> {
  await downloadFile(`/api/v1/artifacts/${encodeURIComponent(artifactId)}/file`, fallbackName);
}

/**
 * Saves a host file by its path: a Workspace file's `downloadUrl`, or the artifact route. The name is the one
 * the host sends in `Content-Disposition` (`filename*` first), so a Hindi or accented title keeps its
 * characters. The desktop shell writes the bytes through its own save dialog inside `apiFetch`.
 */
export async function downloadFile(url: string, fallbackName: string): Promise<void> {
  const res = await apiFetch(url);
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
