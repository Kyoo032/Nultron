/**
 * The team board's calls (team-board-spec.md section 13, phase K0). Server mode only: on Personal
 * the host answers 404 to every one of them, and the page that calls them is not routed there.
 *
 * Every answer is checked before the page sees it. The host is ours, but a proxy error page or a
 * half-written answer must become a `BoardError`, not a card with an undefined title.
 */
import { apiFetch } from "./api-client";

export const BUILTIN_COLUMN_KINDS = ["todo", "doing", "review", "blocked", "done"] as const;
export type ColumnKind = (typeof BUILTIN_COLUMN_KINDS)[number] | "custom";

export type BoardColumn = { id: string; kind: ColumnKind; name: string | null; position: number };
export type CardAssignee = { kind: "person"; userId: string };

export type CardSummary = {
  id: string;
  columnId: string;
  position: string;
  title: string;
  assignee: CardAssignee | null;
  dueAt: number | null;
  version: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  commentCount: number;
};

export type CardDetail = CardSummary & { description: string };

export type CardComment = {
  id: string;
  cardId: string;
  authorKind: "person" | "agent";
  authorUserId: string;
  body: string;
  createdAt: number;
};

export type BoardPerson = { userId: string; name: string };

export type BoardSnapshot = {
  workspaceId: string;
  cursor: number;
  columns: BoardColumn[];
  cards: CardSummary[];
  people: BoardPerson[];
  me: { userId: string; canAdminister: boolean };
};

/** The fields a card edit may carry. `version` is the card's version as the page last read it. */
export type CardChange = {
  version: number;
  title?: string;
  description?: string;
  columnId?: string;
  beforeId?: string | null;
  assignee?: CardAssignee | null;
};

export class BoardError extends Error {
  readonly code: string;
  readonly status: number;
  /** On `card_conflict`: the card as it is now, so the page can show it beside the person's edits. */
  readonly card: CardDetail | null;

  constructor(code: string, message: string, status: number, card: CardDetail | null = null) {
    super(message);
    this.name = "BoardError";
    this.code = code;
    this.status = status;
    this.card = card;
  }
}

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function malformed(): BoardError {
  return new BoardError("board_malformed", "The board answer could not be read.", 502);
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

function parseColumn(row: Row): BoardColumn {
  const kind = str(row, "kind");
  if (kind !== "custom" && !(BUILTIN_COLUMN_KINDS as readonly string[]).includes(kind)) {
    throw malformed();
  }
  return {
    id: str(row, "id"),
    kind: kind as ColumnKind,
    name: row.name === null ? null : str(row, "name"),
    position: num(row, "position"),
  };
}

function parseAssignee(value: unknown): CardAssignee | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isRow(value) || value.kind !== "person") {
    throw malformed();
  }
  return { kind: "person", userId: str(value, "userId") };
}

export function parseCardSummary(row: Row): CardSummary {
  return {
    id: str(row, "id"),
    columnId: str(row, "columnId"),
    position: str(row, "position"),
    title: str(row, "title"),
    assignee: parseAssignee(row.assignee),
    dueAt: row.dueAt === null || row.dueAt === undefined ? null : num(row, "dueAt"),
    version: num(row, "version"),
    createdBy: str(row, "createdBy"),
    createdAt: num(row, "createdAt"),
    updatedAt: num(row, "updatedAt"),
    commentCount: typeof row.commentCount === "number" ? row.commentCount : 0,
  };
}

export function parseCardDetail(row: Row): CardDetail {
  return { ...parseCardSummary(row), description: typeof row.description === "string" ? row.description : "" };
}

function parseComment(row: Row): CardComment {
  return {
    id: str(row, "id"),
    cardId: str(row, "cardId"),
    authorKind: row.authorKind === "agent" ? "agent" : "person",
    authorUserId: str(row, "authorUserId"),
    body: str(row, "body"),
    createdAt: num(row, "createdAt"),
  };
}

export function parseBoardSnapshot(value: unknown): BoardSnapshot {
  if (!isRow(value) || !isRow(value.me)) {
    throw malformed();
  }
  return {
    workspaceId: str(value, "workspaceId"),
    cursor: num(value, "cursor"),
    columns: list(value.columns, parseColumn),
    cards: list(value.cards, parseCardSummary),
    people: list(value.people, (row) => ({ userId: str(row, "userId"), name: str(row, "name") })),
    me: { userId: str(value.me, "userId"), canAdminister: value.me.canAdminister === true },
  };
}

function errorFrom(payload: unknown, status: number): BoardError {
  const error = isRow(payload) && isRow(payload.error) ? payload.error : null;
  const code = error && typeof error.code === "string" ? error.code : "board_error";
  const message = error && typeof error.message === "string" ? error.message : "The board request failed.";
  let card: CardDetail | null = null;
  if (isRow(payload) && isRow(payload.card)) {
    try {
      card = parseCardDetail(payload.card);
    } catch {
      card = null;
    }
  }
  return new BoardError(code, message, status, card);
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

function send(method: string, path: string, body: unknown): Promise<Row> {
  return call(path, { method, body: JSON.stringify(body) });
}

const cardPath = (cardId: string) => `/api/v1/board/cards/${encodeURIComponent(cardId)}`;

export async function loadBoard(signal?: AbortSignal): Promise<BoardSnapshot> {
  return parseBoardSnapshot((await call("/api/v1/board", { signal })).board);
}

export async function loadCard(cardId: string): Promise<{ card: CardDetail; comments: CardComment[] }> {
  const data = await call(cardPath(cardId));
  if (!isRow(data.card)) {
    throw malformed();
  }
  return { card: parseCardDetail(data.card), comments: list(data.comments, parseComment) };
}

export async function createCard(input: { title: string; columnId?: string }): Promise<CardDetail> {
  const data = await send("POST", "/api/v1/board/cards", input);
  if (!isRow(data.card)) {
    throw malformed();
  }
  return parseCardDetail(data.card);
}

export async function updateCard(cardId: string, change: CardChange): Promise<CardDetail> {
  const data = await send("PATCH", cardPath(cardId), change);
  if (!isRow(data.card)) {
    throw malformed();
  }
  return parseCardDetail(data.card);
}

export async function archiveCard(cardId: string, version: number): Promise<void> {
  await send("POST", `${cardPath(cardId)}/archive`, { version });
}

export async function addComment(cardId: string, body: string): Promise<CardComment> {
  const data = await send("POST", `${cardPath(cardId)}/comments`, { body });
  if (!isRow(data.comment)) {
    throw malformed();
  }
  return parseComment(data.comment);
}

export async function createColumn(name: string): Promise<void> {
  await send("POST", "/api/v1/board/columns", { name });
}

export async function updateColumn(columnId: string, change: { name?: string | null; archived?: true }): Promise<void> {
  await send("PATCH", `/api/v1/board/columns/${encodeURIComponent(columnId)}`, change);
}
