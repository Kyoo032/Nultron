/**
 * The rules for Workspaces (team-board-spec.md section 2b; `projects` in code). The only writer of `projects`,
 * `project_members`, `project_agents` and of `artifacts.project_id`.
 *
 * A Workspace is shared with its members only, never the whole company (K-D22). Who may do what, by the
 * caller's role inside the Workspace (K-D23), in one place (`MAY`):
 * - Anyone who is not a member: a 404 on every route, the same answer as an unknown id. A company owner or
 *   admin who is not a member is not one either.
 * - Every member: read its files, knowledge and instructions; add their own files; upload; start chats; bring
 *   an agent from their own desk; take out an agent they brought; leave.
 * - Owner and admins: also rename, write the instructions, invite and remove people, take out any agent, and
 *   remove any file. An admin never removes the owner or another admin.
 * - The owner alone: archive the Workspace (W1's delete), set a member's role, and hand ownership to a member.
 * A member without the right role gets a 403.
 */
import { ApiError, isDefaultChatAgent, scanInjection, virtualAgentBySlug, type TenantContext } from "@agentforge/core";
import type { AssignableRole, CreateProjectInput, ProjectVisibility, UpdateProjectInput, WorkspaceRole } from "./input";
import { isCompanyMember, listCompanyPeople, realPersonName, type CompanyPerson } from "../company-people";
import { deleteSource, type KnowledgeSource } from "../knowledge";
import { mediaExt } from "../media";
import { virtualAgentsOnDesk } from "../virtual-agents";
import {
  attachArtifactKnowledge,
  detachArtifactKnowledge,
  listProjectKnowledge,
  uploadedSourceOf,
  uploadProjectFile,
  type ProjectKnowledgeItem,
} from "./knowledge";
import * as store from "./store";
import type { ProjectFileRow, ProjectMediaRow, ProjectRow } from "./store";

/** Live projects one desk may hold. Archived ones do not count. */
export const PROJECT_LIMIT = 200;
const FILE_LIST_LIMIT = 200;

/** What each role may do inside a Workspace (K-D23). Reading is membership itself, so it is not listed. */
const MAY = {
  manage: new Set<WorkspaceRole>(["owner", "admin"]),
  own: new Set<WorkspaceRole>(["owner"]),
} as const;

export type ProjectRecord = {
  id: string;
  name: string;
  /** Derived from the member count for the renderer's old switch; it grants nothing (K-D22). */
  visibility: ProjectVisibility;
  /** The caller's own role in this Workspace. */
  role: WorkspaceRole;
  memberCount: number;
  /** What the Workspace's chats are told (W1). Empty when none has been written. */
  instructions: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

export type ProjectThread = { id: string; title: string; createdAt: number };

export type ProjectMember = {
  userId: string;
  name: string | null;
  role: WorkspaceRole;
  addedBy: string;
  addedAt: number;
};

export type ProjectAgent = { agentId: string; broughtBy: string; addedAt: number };

/** A chat file (`artifact`), or a generated image or video (`image` / `video`, SR-175). */
export type ProjectFileKind = "artifact" | "image" | "video";

export type ProjectFile = {
  id: string;
  kind: ProjectFileKind;
  title: string;
  mime: string;
  sizeBytes: number;
  ownerUserId: string | null;
  updatedAt: number;
  /** The URL a browser can show inline (media only; a chat file has none). */
  previewUrl: string | null;
  /** The URL that saves the file as an attachment. */
  downloadUrl: string;
};

function toRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    visibility: row.member_count > 1 ? "workspace" : "private",
    role: row.role,
    memberCount: row.member_count,
    instructions: row.instructions ?? "",
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toFile(row: ProjectFileRow): ProjectFile {
  return {
    id: row.id,
    kind: "artifact",
    title: row.title,
    mime: row.mime,
    sizeBytes: row.size_bytes,
    ownerUserId: row.owner_user_id,
    updatedAt: row.updated_at,
    previewUrl: null,
    downloadUrl: `/api/v1/artifacts/${encodeURIComponent(row.id)}/file`,
  };
}

/**
 * A stored image or video as a Workspace file. Its title is built from the row (kind, the first eight
 * characters of the id and the extension), the name `GET /api/v1/media/:id/file` saves it under.
 */
function toMediaFile(row: ProjectMediaRow): ProjectFile {
  const kind = row.kind === "video" ? "video" : "image";
  const id = encodeURIComponent(row.id);
  return {
    id: row.id,
    kind,
    title: `${kind}-${row.id.slice(0, 8)}.${mediaExt(row.mime)}`,
    mime: row.mime,
    sizeBytes: row.size_bytes,
    ownerUserId: row.user_id,
    updatedAt: row.created_at,
    previewUrl: `/api/v1/media/${id}/file`,
    downloadUrl: `/api/v1/media/${id}/file?download=1`,
  };
}

// One code for "not a member or not there", the same as the artifact routes, so a caller cannot tell them apart.
function notFound(): ApiError {
  return new ApiError("not_found", "Not found", 404);
}

function notAllowed(message: string): ApiError {
  return new ApiError("not_allowed", message, 403);
}

/** The project the caller is a member of, or the same 404 an id nobody owns gets. */
function requireMember(scope: TenantContext, projectId: string): ProjectRow {
  const row = store.findMemberProject(scope, projectId);
  if (!row) {
    throw notFound();
  }
  return row;
}

/** Membership first (404), then the role (403). */
function requireRole(scope: TenantContext, projectId: string, may: ReadonlySet<WorkspaceRole>, message: string) {
  const row = requireMember(scope, projectId);
  if (!may.has(row.role)) {
    throw notAllowed(message);
  }
  return row;
}

export function listProjects(scope: TenantContext): ProjectRecord[] {
  return store.listMemberProjects(scope, PROJECT_LIMIT).map(toRecord);
}

export function createProject(
  scope: TenantContext,
  input: CreateProjectInput,
  now: number = Date.now(),
): ProjectRecord {
  return store.inTransaction(() => {
    if (store.countLiveProjects(scope) >= PROJECT_LIMIT) {
      throw new ApiError("project_limit", "This desk has as many projects as it can hold. Archive some first.", 409);
    }
    const id = crypto.randomUUID();
    store.insertProject(scope, id, input.name, now);
    return toRecord(requireMember(scope, id));
  });
}

export function updateProject(
  scope: TenantContext,
  projectId: string,
  input: UpdateProjectInput,
  now: number = Date.now(),
): ProjectRecord {
  return store.inTransaction(() => {
    requireRole(scope, projectId, MAY.manage, "Only the owner or an admin of this Workspace can change it.");
    if (input.instructions !== undefined && scanInjection(input.instructions)) {
      // Instructions go into every chat in the Workspace as trusted text, so they get the same guard as a source.
      throw new ApiError(
        "injection_blocked",
        "These instructions were not saved: they carry prompt-injection text.",
        400,
      );
    }
    store.updateProjectRow(scope, projectId, input, now);
    return toRecord(requireMember(scope, projectId));
  });
}

/** W1's delete: the Workspace is archived and every route answers 404 for it. The owner only. */
export function archiveProject(scope: TenantContext, projectId: string, now: number = Date.now()): void {
  store.inTransaction(() => {
    requireRole(scope, projectId, MAY.own, "Only the owner of this Workspace can delete it.");
    store.archiveProjectRow(scope, projectId, now);
  });
}

function toMember(row: store.MemberRow): ProjectMember {
  return {
    userId: row.user_id,
    name: realPersonName(row.user_id, row.name),
    role: row.role,
    addedBy: row.added_by,
    addedAt: row.added_at,
  };
}

function toAgent(row: store.ProjectAgentRow): ProjectAgent {
  return { agentId: row.agent_id, broughtBy: row.brought_by, addedAt: row.added_at };
}

/** The people and agents of a Workspace, for any member. */
export function listProjectMembers(
  scope: TenantContext,
  projectId: string,
): { members: ProjectMember[]; agents: ProjectAgent[] } {
  requireMember(scope, projectId);
  return {
    members: store.listMembers(projectId).map(toMember),
    agents: store.listProjectAgents(projectId).map(toAgent),
  };
}

const INVITE_REFUSED = "Only the owner or an admin of this Workspace can invite people.";

export function listInvitablePeople(scope: TenantContext, projectId: string): CompanyPerson[] {
  return store.inTransaction(() => {
    requireRole(scope, projectId, MAY.manage, INVITE_REFUSED);
    const members = new Set(store.listMembers(projectId).map((row) => row.user_id));
    return listCompanyPeople(scope).filter((person) => !members.has(person.userId));
  });
}

/**
 * Invite a person of the caller's company. An id that is not a person of the company is the same 404 as an
 * unknown Workspace, so the route never says whether an id exists. A person already in keeps their role.
 */
export function addProjectMember(
  scope: TenantContext,
  projectId: string,
  userId: string,
  now: number = Date.now(),
): ProjectMember[] {
  return store.inTransaction(() => {
    requireRole(scope, projectId, MAY.manage, INVITE_REFUSED);
    if (!isCompanyMember(scope, userId)) {
      throw notFound();
    }
    store.insertMember(projectId, userId, "member", scope.userId, now);
    return store.listMembers(projectId).map(toMember);
  });
}

/**
 * Whether `actor` may take `target` out of the Workspace. Nobody removes the owner. The owner removes anyone
 * else; an admin removes members; anyone but the owner may leave on their own.
 */
function mayRemove(actor: { userId: string; role: WorkspaceRole }, target: { userId: string; role: WorkspaceRole }) {
  if (target.role === "owner") {
    return false;
  }
  if (actor.userId === target.userId || actor.role === "owner") {
    return true;
  }
  return actor.role === "admin" && target.role === "member";
}

export function removeProjectMember(scope: TenantContext, projectId: string, userId: string): void {
  store.inTransaction(() => {
    const row = requireMember(scope, projectId);
    const targetRole = store.memberRole(projectId, userId);
    if (targetRole === null) {
      throw notFound();
    }
    if (!mayRemove({ userId: scope.userId, role: row.role }, { userId, role: targetRole })) {
      throw notAllowed(
        targetRole === "owner"
          ? "The owner of a Workspace cannot be removed."
          : "Only the owner, or an admin for a member, can remove this person.",
      );
    }
    store.deleteMember(projectId, userId);
  });
}

/** The owner makes a member an admin, or an admin a member. */
export function setProjectMemberRole(
  scope: TenantContext,
  projectId: string,
  userId: string,
  role: AssignableRole,
): void {
  store.inTransaction(() => {
    requireRole(scope, projectId, MAY.own, "Only the owner of this Workspace can change a role.");
    const targetRole = store.memberRole(projectId, userId);
    if (targetRole === null) {
      throw notFound();
    }
    if (targetRole === "owner") {
      throw notAllowed("The owner's role changes only by handing ownership to another member.");
    }
    store.setMemberRole(projectId, userId, role);
  });
}

/** The owner hands the Workspace to another member and stays on as an admin. */
export function transferProjectOwnership(scope: TenantContext, projectId: string, userId: string): void {
  store.inTransaction(() => {
    requireRole(scope, projectId, MAY.own, "Only the owner of this Workspace can hand it on.");
    const targetRole = store.memberRole(projectId, userId);
    if (targetRole === null) {
      throw notFound();
    }
    if (targetRole === "owner") {
      return;
    }
    // Demote first: one owner per Workspace is a unique index, so the order matters inside the transaction.
    store.setMemberRole(projectId, scope.userId, "admin");
    store.setMemberRole(projectId, userId, "owner");
  });
}

/**
 * A member brings an agent from their own desk (K-D22). The default agent is in every Workspace already, so it is
 * not brought; an agent that is not on the caller's desk is a 404, the same as an unknown id.
 */
export async function bringProjectAgent(
  scope: TenantContext,
  projectId: string,
  agentId: string,
  now: number = Date.now(),
): Promise<ProjectAgent[]> {
  requireMember(scope, projectId);
  const onDesk = await virtualAgentsOnDesk(scope);
  const agent = onDesk.find((candidate) => candidate.id === agentId);
  if (!agent) {
    throw notFound();
  }
  if (agent.generalist) {
    throw new ApiError("invalid_project", "The default agent works in every Workspace already.", 400);
  }
  return store.inTransaction(() => {
    requireMember(scope, projectId);
    store.insertProjectAgent(projectId, agent.id, scope.userId, now);
    return store.listProjectAgents(projectId).map(toAgent);
  });
}

/**
 * Take an agent out. The member who brought it takes out their own copy; the owner or an admin takes it out for
 * everyone. A member who did not bring it gets a 403; an agent that is not in the Workspace is a 404.
 */
export function removeProjectAgent(scope: TenantContext, projectId: string, agentId: string): void {
  store.inTransaction(() => {
    const row = requireMember(scope, projectId);
    if (MAY.manage.has(row.role)) {
      if (store.deleteProjectAgent(projectId, agentId, null) === 0) {
        throw notFound();
      }
      return;
    }
    if (store.deleteProjectAgent(projectId, agentId, scope.userId) > 0) {
      return;
    }
    if (!store.hasProjectAgent(projectId, agentId)) {
      throw notFound();
    }
    throw notAllowed("Only the member who brought this agent, or the owner or an admin, can take it out.");
  });
}

/** The Workspace's files and its generated media, newest first. Each row is filtered by its own rule too. */
export function listProjectFiles(scope: TenantContext, projectId: string): ProjectFile[] {
  requireMember(scope, projectId);
  const artifacts = store.listProjectFiles(scope, projectId, FILE_LIST_LIMIT).map(toFile);
  const media = store.listProjectMedia(scope, projectId, FILE_LIST_LIMIT).map(toMediaFile);
  return [...artifacts, ...media].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, FILE_LIST_LIMIT);
}

/** Put the caller's own chat file into the Workspace, and make it one of the Workspace's knowledge sources. */
export async function addProjectFile(scope: TenantContext, projectId: string, artifactId: string): Promise<void> {
  const file = store.inTransaction(() => {
    requireMember(scope, projectId);
    const found = store.findVisibleFile(scope, artifactId);
    if (!found) {
      throw notFound();
    }
    // A legacy file with no owner is not the caller's either, so it cannot be put into a project.
    if (found.owner_user_id !== scope.userId) {
      throw notAllowed("Only the person who made this file can add it to a project.");
    }
    store.setFileProject(scope, artifactId, projectId);
    return found;
  });
  await attachArtifactKnowledge(scope, file.id, projectId, file.owner_user_id);
}

/**
 * Put the caller's own generated image or video into the Workspace (SR-175). The same three rules as a chat
 * file: a media row the caller cannot see is a 404, one they can see but did not make is a 403, and the caller
 * must be a member of the Workspace. Only images and videos are added; audio is refused.
 */
export function addProjectMedia(scope: TenantContext, projectId: string, mediaId: string): void {
  store.inTransaction(() => {
    requireMember(scope, projectId);
    const found = store.findVisibleMedia(scope, mediaId);
    if (!found) {
      throw notFound();
    }
    if (found.user_id !== scope.userId) {
      throw notAllowed("Only the person who made this file can add it to a project.");
    }
    if (found.kind !== "image" && found.kind !== "video") {
      throw new ApiError("invalid_project", "Only images and videos can be added to a Workspace.", 400);
    }
    store.setMediaProject(scope, mediaId, projectId);
  });
}

/** A file's maker, or the owner or an admin of the Workspace, may take it out. */
function mayTakeOut(row: ProjectRow, scope: TenantContext, makerUserId: string | null): boolean {
  return makerUserId === scope.userId || MAY.manage.has(row.role);
}

export function removeProjectFile(scope: TenantContext, projectId: string, artifactId: string): void {
  store.inTransaction(() => {
    const row = requireMember(scope, projectId);
    const file = store.findVisibleFile(scope, artifactId);
    if (!file || file.project_id !== projectId) {
      throw notFound();
    }
    if (!mayTakeOut(row, scope, file.owner_user_id)) {
      throw notAllowed("Only the maker of this file, or the owner or an admin of the Workspace, can remove it.");
    }
    store.setFileProject(scope, artifactId, null);
    detachArtifactKnowledge(scope, artifactId, projectId);
  });
}

/** Take a generated image or video out of the Workspace (SR-175). */
export function removeProjectMedia(scope: TenantContext, projectId: string, mediaId: string): void {
  store.inTransaction(() => {
    const row = requireMember(scope, projectId);
    const found = store.findVisibleMedia(scope, mediaId);
    if (!found || found.project_id !== projectId) {
      throw notFound();
    }
    if (!mayTakeOut(row, scope, found.user_id)) {
      throw notAllowed("Only the maker of this file, or the owner or an admin of the Workspace, can remove it.");
    }
    store.setMediaProject(scope, mediaId, null);
  });
}

/** The Workspace's knowledge, for a member; anyone else gets the same 404 an unknown Workspace gets. */
export function listProjectKnowledgeFor(scope: TenantContext, projectId: string): ProjectKnowledgeItem[] {
  requireMember(scope, projectId);
  return listProjectKnowledge(scope, projectId);
}

/**
 * An upload into the Workspace. Any member may add knowledge (W1); the uploader owns the source.
 * Returns the source as the Workspace's knowledge list shows it.
 */
export async function uploadProjectKnowledge(
  scope: TenantContext,
  projectId: string,
  file: { filename: string; mime: string; bytes: Uint8Array },
): Promise<ProjectKnowledgeItem> {
  requireMember(scope, projectId);
  const source: KnowledgeSource = await uploadProjectFile(scope, projectId, file, scope.userId);
  return {
    id: source.id,
    name: source.name,
    kind: source.type,
    status: source.status,
    chunks: source.chunks,
    addedBy: scope.userId,
    createdAt: source.createdAt,
  };
}

/**
 * Remove an upload from the Workspace: its uploader, or the owner or an admin, may, and the source is deleted
 * with its chunks and bytes. A source that is not an upload of this Workspace is the same 404 as an unknown id.
 */
export function removeProjectKnowledge(scope: TenantContext, projectId: string, sourceId: string): void {
  const row = requireMember(scope, projectId);
  const upload = uploadedSourceOf(scope, projectId, sourceId);
  if (!upload) {
    throw notFound();
  }
  if (!mayTakeOut(row, scope, upload.ownerUserId)) {
    throw notAllowed("Only the uploader, or the owner or an admin of this Workspace, can remove it.");
  }
  deleteSource(scope, sourceId);
}

/** The caller's own chats that were started in this Workspace. Threads stay per person, so no one else's show. */
export function listProjectThreadsFor(scope: TenantContext, projectId: string): ProjectThread[] {
  requireMember(scope, projectId);
  return store.listOwnProjectThreads(scope, projectId).map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
  }));
}

/**
 * Whether the agent with this row slug may work in the Workspace: the default agent always, a mode agent only
 * while a member has brought it in, and an agent a person built never.
 */
function agentWorksIn(projectId: string, agentSlug: string): boolean {
  if (isDefaultChatAgent({ slug: agentSlug })) {
    return true;
  }
  const agent = virtualAgentBySlug(agentSlug);
  return agent !== undefined && !agent.generalist && store.hasProjectAgent(projectId, agent.id);
}

/**
 * A chat may be started in a Workspace only by a member of it (a 404 otherwise, the same as an unknown id), and
 * only with the default agent or one a member brought in (a 403 otherwise). Returns the id, so the caller can
 * store it on the thread.
 */
export function requireChatWorkspace(scope: TenantContext, projectId: string, agentSlug: string): string {
  requireMember(scope, projectId);
  if (!agentWorksIn(projectId, agentSlug)) {
    throw notAllowed("This agent is not in the Workspace. A member brings it in first.");
  }
  return projectId;
}

/**
 * The Workspace a run reads (its instructions and its knowledge), checked again on every run: null once the
 * caller has left it, it is archived, or the thread's agent was taken out. The chat then runs as an ordinary chat.
 */
export function workspaceForRun(scope: TenantContext, projectId: string | null, agentSlug: string): string | null {
  if (projectId === null) {
    return null;
  }
  return store.findMemberProject(scope, projectId) && agentWorksIn(projectId, agentSlug) ? projectId : null;
}

/**
 * The block of a chat's system prompt that carries its Workspace's instructions (W1), or the empty string
 * when the chat is not in a Workspace, the caller is not a member, or none has been written. Labelled, so
 * the model can tell the Workspace's instructions from the desk's own rules.
 */
export function workspacePromptBlock(scope: TenantContext, projectId: string | null): string {
  if (projectId === null) {
    return "";
  }
  const row = store.findMemberProject(scope, projectId);
  const instructions = row?.instructions?.trim() ?? "";
  return instructions ? `\n\n# Workspace instructions\n${instructions}` : "";
}
