/**
 * What the Workspaces page decides on its own, kept pure so a node test can read it. Every rule here
 * is a display rule: the host enforces membership, roles, Remove and archive, and answers a refusal that
 * the page then shows.
 */
import { DOCX_MIME, PDF_MIME, PPTX_MIME, XLSX_MIME } from "@agentforge/core/artifacts";
import type { ModeIconName } from "@/components/mode-icons";
import type { ProjectAgent, ProjectFile, ProjectMember, ProjectRecord, WorkspaceRole } from "./projects-client";

export type FileKind = "document" | "sheet" | "slides" | "pdf" | "image" | "video" | "audio" | "text" | "other";

/** The kind a file's mime says it is. Unknown types are "other", never guessed from the name. */
export function fileKind(mime: string): FileKind {
  if (mime === DOCX_MIME) return "document";
  if (mime === XLSX_MIME) return "sheet";
  if (mime === PPTX_MIME) return "slides";
  if (mime === PDF_MIME) return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("text/") || mime === "application/json") return "text";
  return "other";
}

const ICON_BY_KIND: Record<FileKind, ModeIconName> = {
  document: "documents",
  sheet: "finance",
  slides: "presentations",
  pdf: "documents",
  image: "images",
  video: "videos",
  audio: "music",
  text: "documents",
  other: "documents",
};

export function fileIconName(mime: string): ModeIconName {
  return ICON_BY_KIND[fileKind(mime)];
}

/**
 * What each role may press inside a Workspace, the host's rules (`projects/service.ts`, K-D23) mirrored for
 * display only. The host checks every one again and answers 403 or 404 when it refuses.
 */
const MAY = {
  manage: new Set<WorkspaceRole>(["owner", "admin"]),
  own: new Set<WorkspaceRole>(["owner"]),
} as const;

/** Rename, invite people, take out any agent, remove any file. */
export function canManage(role: WorkspaceRole): boolean {
  return MAY.manage.has(role);
}

/** Archive the Workspace, set a role, hand ownership on. */
export function isOwner(role: WorkspaceRole): boolean {
  return MAY.own.has(role);
}

/** The buttons a member's row shows to the person looking at it. */
export type MemberActions = {
  readonly setRole: boolean;
  readonly handOver: boolean;
  readonly remove: boolean;
  readonly leave: boolean;
};

const NO_ACTIONS: MemberActions = { setRole: false, handOver: false, remove: false, leave: false };

/**
 * Nobody removes the owner. The owner removes anyone else, sets roles and hands ownership on; an admin removes
 * plain members; anyone but the owner leaves on their own.
 */
export function memberActions(
  viewer: { readonly userId: string; readonly role: WorkspaceRole } | null,
  target: ProjectMember,
): MemberActions {
  if (!viewer || target.role === "owner") {
    return NO_ACTIONS;
  }
  if (target.userId === viewer.userId) {
    return { ...NO_ACTIONS, leave: true };
  }
  const owner = isOwner(viewer.role);
  return {
    setRole: owner,
    handOver: owner,
    remove: owner || (viewer.role === "admin" && target.role === "member"),
    leave: false,
  };
}

/** The member who brought the agent takes out their own; the owner or an admin takes it out for everyone. */
export function canTakeOutAgent(agent: ProjectAgent, role: WorkspaceRole, me: string | null): boolean {
  return canManage(role) || (me !== null && agent.broughtBy === me);
}

/** The desk's own agents that are not in the Workspace yet. The default agent is in every Workspace already. */
export function agentsToBring<T extends { readonly id: string; readonly generalist: boolean }>(
  desk: readonly T[],
  inWorkspace: readonly ProjectAgent[],
): T[] {
  const present = new Set(inWorkspace.map((agent) => agent.agentId));
  return desk.filter((agent) => !agent.generalist && !present.has(agent.id));
}

/**
 * Who may press Remove on a file: its maker, or the Workspace's owner or an admin. The host checks the same rule
 * and answers 403 when it refuses, so a true here is only a reason to show the button.
 */
export function canRemoveFile(file: ProjectFile, project: ProjectRecord, me: string | null): boolean {
  if (!me) return false;
  return file.ownerUserId === me || canManage(project.role);
}

/** The list splits into the Workspaces the person owns and the ones others shared with them. */
export function splitProjects(projects: readonly ProjectRecord[]): { own: ProjectRecord[]; shared: ProjectRecord[] } {
  return {
    own: projects.filter((project) => isOwner(project.role)),
    shared: projects.filter((project) => !isOwner(project.role)),
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
