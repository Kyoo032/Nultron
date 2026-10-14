import { randomBytes } from "node:crypto";

/** Spec section 12.2. Counted in UTF-16 code units, as the renderer counts them. */
export const BOARD_LIMITS = {
  title: 200,
  description: 20_000,
  comment: 20_000,
  columnName: 60,
} as const;

/**
 * How much one desk may hold (security review of K0, M2; spec section 13). The task service checks these
 * inside the write's transaction. `configureBoardVolume` in `service.ts` lowers them in tests only.
 */
export const BOARD_VOLUME = {
  cards: 5_000,
  commentsPerCard: 500,
  columns: 50,
} as const;

/** A position key longer than this is never written: the column's keys are rewritten short instead. */
export const MAX_POSITION_KEY = 48;

export const BUILTIN_COLUMN_KINDS =["todo", "doing", "review", "blocked", "done"] as const;
export type BuiltinColumnKind = (typeof BUILTIN_COLUMN_KINDS)[number];
export type ColumnKind = BuiltinColumnKind | "custom";

/** The event types K0 writes (spec section 7.1). Agents, files and mentions add theirs in K2 to K4. */
export const BOARD_EVENT_TYPES = [
  "card.created",
  "card.edited",
  "card.moved",
  "card.assigned",
  "card.archived",
  "card.restored",
  "comment.added",
  "column.changed",
] as const;
export type BoardEventType = (typeof BOARD_EVENT_TYPES)[number];

/** Who a card is assigned to. K0 assigns people only; `agent` is K2. */
export type CardAssignee = { readonly kind: "person"; readonly userId: string };

export type BoardColumn = {
  readonly id: string;
  readonly kind: ColumnKind;
  /** Null on a built-in column nobody renamed: the renderer shows its own name for the kind. */
  readonly name: string | null;
  readonly position: number;
};

export type CardSummary = {
  readonly id: string;
  readonly columnId: string;
  readonly position: string;
  readonly title: string;
  readonly assignee: CardAssignee | null;
  readonly dueAt: number | null;
  readonly version: number;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly commentCount: number;
};

export type CardDetail = CardSummary & { readonly description: string };

export type CardComment = {
  readonly id: string;
  readonly cardId: string;
  readonly authorKind: "person" | "agent";
  readonly authorUserId: string;
  readonly body: string;
  readonly createdAt: number;
};

export type BoardPerson = { readonly userId: string; readonly name: string };

export type BoardSnapshot = {
  readonly workspaceId: string;
  /** The newest `card_events.id` this snapshot includes; the stream resumes after it. */
  readonly cursor: number;
  readonly columns: readonly BoardColumn[];
  readonly cards: readonly CardSummary[];
  readonly people: readonly BoardPerson[];
  readonly me: { readonly userId: string; readonly canAdminister: boolean };
};

export type BoardEventRow = {
  readonly id: number;
  readonly cardId: string | null;
  readonly type: string;
  readonly payload: Record<string, unknown>;
};

/** UUIDv7 (spec section 6): a 48-bit millisecond time, then random bits, so ids sort by time. */
export function boardId(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
