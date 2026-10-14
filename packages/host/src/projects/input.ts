/**
 * Request bodies for the project routes, parsed at the boundary (same shape as `board/input.ts`).
 * A body that does not parse is a 400 `invalid_project`; the message is for logs and tools.
 */
import { ApiError } from "@agentforge/core";

export const PROJECT_NAME_MAX = 120;

export type ProjectVisibility = "private" | "workspace";

export type CreateProjectInput = { readonly name: string };

/** The most instructions a Workspace may hold (W1). Long enough for a brief, short enough to sit in every prompt. */
export const PROJECT_INSTRUCTIONS_MAX = 8000;

export type UpdateProjectInput = {
  readonly name?: string;
  readonly visibility?: ProjectVisibility;
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

function visibility(value: unknown): ProjectVisibility {
  if (value !== "private" && value !== "workspace") {
    throw new ApiError("invalid_project", "visibility must be private or workspace.", 400);
  }
  return value;
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
  const changes: { name?: string; visibility?: ProjectVisibility; instructions?: string } = {};
  if (raw.name !== undefined) {
    changes.name = name(raw.name);
  }
  if (raw.visibility !== undefined) {
    changes.visibility = visibility(raw.visibility);
  }
  if (raw.instructions !== undefined) {
    changes.instructions = instructions(raw.instructions);
  }
  if (changes.name === undefined && changes.visibility === undefined && changes.instructions === undefined) {
    throw new ApiError("invalid_project", "Nothing to change: send name, visibility or instructions.", 400);
  }
  return changes;
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
