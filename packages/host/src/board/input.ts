/**
 * Request bodies parsed into typed inputs at the boundary. Everything past here trusts these shapes.
 * A body that does not parse is `400` with the route's code; the message is for logs and tools, the
 * renderer shows its own copy for the code.
 */
import { ApiError } from "@agentforge/core";
import { BOARD_LIMITS } from "./types";

export type AssigneeInput = { readonly kind: "person"; readonly userId: string } | null;

export type CreateCardInput = {
  readonly title: string;
  readonly description: string;
  readonly columnId: string | null;
  readonly assignee: AssigneeInput;
};

export type MoveInput = {
  readonly columnId: string | null;
  /** The card this one should sit directly above; null puts it at the end of the column. */
  readonly beforeId: string | null;
};

export type UpdateCardInput = {
  readonly version: number;
  readonly title?: string;
  readonly description?: string;
  readonly move?: MoveInput;
  readonly assignee?: AssigneeInput;
  readonly dueAt?: number | null;
};

export type CreateColumnInput = { readonly name: string; readonly position: number | null };

export type UpdateColumnInput = {
  readonly name?: string | null;
  readonly position?: number;
  readonly archived?: true;
};

const MAX_DUE_AT = Date.UTC(2200, 0, 1);

function record(body: unknown, code: string): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(code, "Request body must be a JSON object.", 400);
  }
  return body as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number, code: string, allowEmpty: boolean): string {
  if (typeof value !== "string") {
    throw new ApiError(code, `${field} must be a string.`, 400);
  }
  const trimmed = field === "title" || field === "name" ? value.trim() : value;
  if (!allowEmpty && trimmed.trim().length === 0) {
    throw new ApiError(code, `${field} must not be empty.`, 400);
  }
  if (trimmed.length > max) {
    throw new ApiError(code, `${field} is longer than ${max} characters.`, 400);
  }
  return trimmed;
}

function id(value: unknown, field: string, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 100) {
    throw new ApiError(code, `${field} must be an id.`, 400);
  }
  return value;
}

function optionalId(value: unknown, field: string, code: string): string | null {
  return value === undefined || value === null ? null : id(value, field, code);
}

function assignee(value: unknown, code: string): AssigneeInput {
  if (value === null) {
    return null;
  }
  const row = record(value, code);
  if (row.kind !== "person") {
    throw new ApiError(code, "An assignee is a person in this version.", 400);
  }
  return { kind: "person", userId: id(row.userId, "assignee.userId", code) };
}

function dueAt(value: unknown, code: string): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_DUE_AT) {
    throw new ApiError(code, "dueAt must be a time in epoch milliseconds, or null.", 400);
  }
  return value;
}

export function parseCreateCard(body: unknown): CreateCardInput {
  const code = "invalid_card";
  const row = record(body, code);
  return {
    title: text(row.title, "title", BOARD_LIMITS.title, code, false),
    description:
      row.description === undefined || row.description === null
        ? ""
        : text(row.description, "description", BOARD_LIMITS.description, code, true),
    columnId: optionalId(row.columnId, "columnId", code),
    assignee: row.assignee === undefined ? null : assignee(row.assignee, code),
  };
}

export function parseUpdateCard(body: unknown): UpdateCardInput {
  const code = "invalid_card";
  const row = record(body, code);
  if (typeof row.version !== "number" || !Number.isSafeInteger(row.version) || row.version < 1) {
    throw new ApiError(code, "version is required: the card's version as you last read it.", 400);
  }
  const moving = row.columnId !== undefined || row.beforeId !== undefined;
  const input: UpdateCardInput = {
    version: row.version,
    ...(row.title !== undefined ? { title: text(row.title, "title", BOARD_LIMITS.title, code, false) } : {}),
    ...(row.description !== undefined
      ? { description: text(row.description ?? "", "description", BOARD_LIMITS.description, code, true) }
      : {}),
    ...(moving
      ? {
          move: {
            columnId: optionalId(row.columnId, "columnId", code),
            beforeId: optionalId(row.beforeId, "beforeId", code),
          },
        }
      : {}),
    ...(row.assignee !== undefined ? { assignee: assignee(row.assignee, code) } : {}),
    ...(row.dueAt !== undefined ? { dueAt: dueAt(row.dueAt, code) } : {}),
  };
  if (Object.keys(input).length === 1) {
    throw new ApiError(code, "Nothing to change.", 400);
  }
  return input;
}

export function parseVersion(body: unknown): number {
  const row = record(body, "invalid_card");
  if (typeof row.version !== "number" || !Number.isSafeInteger(row.version) || row.version < 1) {
    throw new ApiError("invalid_card", "version is required.", 400);
  }
  return row.version;
}

export function parseComment(body: unknown): string {
  const code = "invalid_comment";
  return text(record(body, code).body, "body", BOARD_LIMITS.comment, code, false);
}

function position(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1000) {
    throw new ApiError(code, "position must be a column index.", 400);
  }
  return value;
}

export function parseCreateColumn(body: unknown): CreateColumnInput {
  const code = "invalid_column";
  const row = record(body, code);
  return {
    name: text(row.name, "name", BOARD_LIMITS.columnName, code, false),
    position: row.position === undefined || row.position === null ? null : position(row.position, code),
  };
}

export function parseUpdateColumn(body: unknown): UpdateColumnInput {
  const code = "invalid_column";
  const row = record(body, code);
  if (row.archived !== undefined && row.archived !== true) {
    throw new ApiError(code, "archived can only be set to true.", 400);
  }
  const input: UpdateColumnInput = {
    ...(row.name !== undefined
      ? { name: row.name === null ? null : text(row.name, "name", BOARD_LIMITS.columnName, code, false) }
      : {}),
    ...(row.position !== undefined ? { position: position(row.position, code) } : {}),
    ...(row.archived === true ? { archived: true as const } : {}),
  };
  if (Object.keys(input).length === 0) {
    throw new ApiError(code, "Nothing to change.", 400);
  }
  return input;
}
