/**
 * Request bodies for the project routes, parsed at the boundary (same shape as `board/input.ts`).
 * A body that does not parse is a 400 `invalid_project`; the message is for logs and tools.
 */
import { ApiError } from "@agentforge/core";

export const PROJECT_NAME_MAX = 120;

/**
 * What the renderer still reads as the old switch (K-D19). Derived now, never set: one member is `private`,
 * more is `workspace`. Who sees a Workspace is its members (K-D22).
 */
export type ProjectVisibility = "private" | "workspace";

/** A person's role inside one Workspace (K-D23). Exactly one `owner` per Workspace. */
export type WorkspaceRole = "owner" | "admin" | "member";

/** The roles an owner may hand out with the role route. `owner` moves only by a transfer. */
export type AssignableRole = Exclude<WorkspaceRole, "owner">;

export type CreateProjectInput = { readonly name: string };

/** The most instructions a Workspace may hold (W1). Long enough for a brief, short enough to sit in every prompt. */
export const PROJECT_INSTRUCTIONS_MAX = 8000;

export type UpdateProjectInput = {
  readonly name?: string;
  readonly instructions?: string;
};

export type AddFileInput = { readonly artifactId: string } | { readonly mediaId: string };

function record(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("invalid_project", "Request body must be a JSON object.", 400);
  }
  return body as Record<string, unknown>;
}

function name(value: unknown): string {
  if (typeof value !== "string") {
    throw new ApiError("invalid_project", "name must be a string.", 400);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ApiError("invalid_project", "name must not be empty.", 400);
  }
  if (trimmed.length > PROJECT_NAME_MAX) {
    throw new ApiError("invalid_project", `name is longer than ${PROJECT_NAME_MAX} characters.`, 400);
  }
  return trimmed;
}

export function parseCreateProject(body: unknown): CreateProjectInput {
  return { name: name(record(body).name) };
}

function instructions(value: unknown): string {
  if (typeof value !== "string") {
    throw new ApiError("invalid_project", "instructions must be a string.", 400);
  }
  if (value.length > PROJECT_INSTRUCTIONS_MAX) {
    throw new ApiError("invalid_project", `instructions are longer than ${PROJECT_INSTRUCTIONS_MAX} characters.`, 400);
  }
  return value.trim();
}

export function parseUpdateProject(body: unknown): UpdateProjectInput {
  const raw = record(body);
  if (raw.visibility !== undefined) {
    // The K-D19 switch is gone (K-D22): a Workspace is shared by inviting members, never by a flag.
    throw new ApiError("invalid_project", "visibility is no longer set: invite members to share a Workspace.", 400);
  }
  const changes: { name?: string; instructions?: string } = {};
  if (raw.name !== undefined) {
    changes.name = name(raw.name);
  }
  if (raw.instructions !== undefined) {
    changes.instructions = instructions(raw.instructions);
  }
  if (changes.name === undefined && changes.instructions === undefined) {
    throw new ApiError("invalid_project", "Nothing to change: send name or instructions.", 400);
  }
  return changes;
}

/** A person or agent id from a body or a path: a short, non-empty string. */
function id(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 128) {
    throw new ApiError("invalid_project", `${field} must be an id.`, 400);
  }
  return value;
}

/** `{ userId }`: the person to invite, or to hand ownership to. */
export function parsePersonInput(body: unknown): { readonly userId: string } {
  return { userId: id(record(body).userId, "userId") };
}

/** `{ role }`: `admin` or `member`. Ownership moves only by the transfer route. */
export function parseRoleInput(body: unknown): { readonly role: AssignableRole } {
  const role = record(body).role;
  if (role !== "admin" && role !== "member") {
    throw new ApiError("invalid_project", "role must be admin or member.", 400);
  }
  return { role };
}

/** `{ agentId }`: the agent a member brings in, by its product-mode id. */
export function parseAgentInput(body: unknown): { readonly agentId: string } {
  return { agentId: id(record(body).agentId, "agentId") };
}

/** A file id from the body: a chat file (`artifactId`) or a generated image or video (`mediaId`). */
function fileId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 64) {
    throw new ApiError("invalid_project", `${field} must be a file id.`, 400);
  }
  return value;
}

/** Exactly one of `artifactId` and `mediaId`. Both, or neither, is a 400. */
export function parseAddFile(body: unknown): AddFileInput {
  const raw = record(body);
  const hasArtifact = raw.artifactId !== undefined;
  const hasMedia = raw.mediaId !== undefined;
  if (hasArtifact === hasMedia) {
    throw new ApiError("invalid_project", "Send exactly one of artifactId or mediaId.", 400);
  }
  if (hasMedia) {
    return { mediaId: fileId(raw.mediaId, "mediaId") };
  }
  return { artifactId: fileId(raw.artifactId, "artifactId") };
}
