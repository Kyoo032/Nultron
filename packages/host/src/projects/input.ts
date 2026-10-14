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

export type AddFileInput = { readonly artifactId: string };

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

export function parseAddFile(body: unknown): AddFileInput {
  const artifactId = record(body).artifactId;
  if (typeof artifactId !== "string" || artifactId.trim().length === 0 || artifactId.length > 64) {
    throw new ApiError("invalid_project", "artifactId must be a file id.", 400);
  }
  return { artifactId };
}
