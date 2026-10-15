/**
 * The task service (team-board-spec.md section 7): the only writer of the company board tables.
 *
 * Every change writes its `card_events` row in the same transaction as the change, so a client that
 * missed a message can always catch up from the log. The bus is told only after the transaction
 * commits, and only ids travel on it.
 */
import { ApiError, canAdminister } from "@agentforge/core";
import { isCompanyMember, listCompanyPeople } from "../company-people";
import { boardBus } from "./bus";
import { evenKeys, keyBetween } from "./fractional";
import type { CreateCardInput, CreateColumnInput, MoveInput, UpdateCardInput, UpdateColumnInput } from "./input";
import { sealBoardText } from "./seal";
import * as store from "./store";
import type { BoardScope, CardChanges } from "./store";
import {
  BOARD_VOLUME,
  boardId,
  MAX_POSITION_KEY,
  type BoardColumn,
  type BoardSnapshot,
  type CardComment,
  type CardDetail,
} from "./types";

/** `409 card_conflict`: the card moved on since the caller read it. Carries the card as it is now. */
export class CardConflictError extends ApiError {
  readonly card: CardDetail;
  constructor(card: CardDetail) {
    super("card_conflict", "Someone changed this card since you opened it.", 409);
    this.card = card;
  }
}

const PERSON = (scope: BoardScope): store.EventActor => ({ kind: "person", userId: scope.userId });
const SYSTEM: store.EventActor = { kind: "system", userId: null };

function cardNotFound(): ApiError {
  return new ApiError("card_not_found", "Card not found.", 404);
}

function columnNotFound(): ApiError {
  return new ApiError("column_not_found", "Column not found.", 404);
}

/** Runs `work` in one transaction, then publishes the event ids it wrote. Never publishes on a rollback. */
function commit<T>(scope: BoardScope, work: (events: number[]) => T): T {
  const events: number[] = [];
  const result = store.inTransaction(() => work(events));
  for (const eventId of events) {
    boardBus().publish(scope.tenantId, scope.workspaceId, eventId);
  }
  return result;
}

function requireAdmin(scope: BoardScope, message = "Only an owner or admin can change the board's columns."): void {
  if (!canAdminister(scope.role)) {
    throw new ApiError("admin_only", message, 403);
  }
}

function requireMember(scope: BoardScope, userId: string): void {
  if (!isCompanyMember(scope, userId)) {
    throw new ApiError("invalid_card", "The assignee is not a member of this company.", 400);
  }
}

export function getBoard(scope: BoardScope, now: number = Date.now()): BoardSnapshot {
  return store.inTransaction(() => {
    store.seedColumns(scope, now);
    return {
      workspaceId: scope.workspaceId,
      cursor: store.latestEventId(scope),
      columns: store.listColumns(scope),
      cards: store.listCards(scope),
      people: listCompanyPeople(scope),
      me: { userId: scope.userId, canAdminister: canAdminister(scope.role) },
    };
  });
}

export function getCard(scope: BoardScope, cardId: string): { card: CardDetail; comments: CardComment[] } {
  const card = store.findCard(scope, cardId);
  if (!card) {
    throw cardNotFound();
  }
  return { card, comments: store.listComments(scope, cardId) };
}

/** Where a card lands; `rebalanced` when the column's other keys were rewritten to make room. */
type Placement = { readonly columnId: string; readonly position: string; readonly rebalanced: boolean };

function keyOrNull(before: string | null, after: string | null): string | null {
  try {
    return keyBetween(before, after);
  } catch {
    return null;
  }
}

/**
 * The key that puts a card directly above `beforeId` in `columnId`, or at the column's end.
 *
 * Moves into one gap again and again grow a key by about a character every six moves (security review of
 * K0, M1). A key longer than `MAX_POSITION_KEY`, or a gap that cannot be split, is never written: the
 * column's keys are rewritten evenly and short in the same transaction, and the caller tells the board with
 * one `column.changed`. Nothing here answers a 500.
 */
function placeCard(scope: BoardScope, columnId: string, beforeId: string | null, movingId: string | null): Placement {
  const cards = store.columnPositions(scope, columnId, movingId);
  const index = beforeId === null ? cards.length : cards.findIndex((card) => card.id === beforeId);
  if (index < 0) {
    throw new ApiError("invalid_card", "beforeId is not a card in that column.", 400);
  }
  const key = keyOrNull(cards[index - 1]?.position ?? null, cards[index]?.position ?? null);
  if (key !== null && key.length <= MAX_POSITION_KEY) {
    return { columnId, position: key, rebalanced: false };
  }
  let keys: string[];
  try {
    keys = evenKeys(cards.length + 1);
  } catch {
    throw new ApiError("position_exhausted", "This column cannot take another card in that place.", 409);
  }
  for (const [at, card] of cards.entries()) {
    store.setCardPosition(scope, card.id, keys[at < index ? at : at + 1]);
  }
  return { columnId, position: keys[index], rebalanced: true };
}

/** One `column.changed` after a rebalance, so every open board reloads the rewritten keys. */
function noteRebalance(scope: BoardScope, placement: Placement, events: number[], now: number): void {
  if (placement.rebalanced) {
    events.push(
      store.insertEvent(scope, null, "column.changed", { columnId: placement.columnId, rebalanced: true }, SYSTEM, now),
    );
  }
}

let volume: { cards: number; commentsPerCard: number; columns: number } = { ...BOARD_VOLUME };

/** Test seam: smaller caps. Returns the function that restores the real ones. */
export function configureBoardVolume(over: Partial<typeof volume>): () => void {
  volume = { ...BOARD_VOLUME, ...over };
  return () => {
    volume = { ...BOARD_VOLUME };
  };
}

function requireRoomForCard(scope: BoardScope): void {
  if (store.liveCardTotal(scope) >= volume.cards) {
    throw new ApiError("card_limit", "This board holds as many cards as it can. Archive some first.", 409);
  }
}

export function createCard(scope: BoardScope, input: CreateCardInput, now: number = Date.now()): CardDetail {
  return commit(scope, (events) => {
    store.seedColumns(scope, now);
    const column = input.columnId ? store.findColumn(scope, input.columnId) : store.columnOfKind(scope, "todo");
    if (!column) {
      throw new ApiError("invalid_card", "That column is not on this board.", 400);
    }
    if (input.assignee) {
      requireMember(scope, input.assignee.userId);
    }
    requireRoomForCard(scope);
    const id = boardId(now);
    const placement = placeCard(scope, column.id, null, null);
    const position = placement.position;
    noteRebalance(scope, placement, events, now);
    store.insertCard(scope, {
      id,
      columnId: column.id,
      position,
      title: input.title,
      descriptionSealed: input.description ? sealBoardText(input.description) : null,
      assigneeUserId: input.assignee?.userId ?? null,
      now,
    });
    events.push(store.insertEvent(scope, id, "card.created", { columnId: column.id, position }, PERSON(scope), now));
    if (input.assignee) {
      events.push(
        store.insertEvent(
          scope,
          id,
          "card.assigned",
          { assigneeKind: "person", assigneeUserId: input.assignee.userId },
          PERSON(scope),
          now,
        ),
      );
    }
    const created = store.findCard(scope, id);
    if (!created) {
      throw new Error("board: a card written in this transaction did not read back");
    }
    return created;
  });
}

function resolveMove(scope: BoardScope, current: CardDetail, move: MoveInput): Placement {
  const columnId = move.columnId ?? current.columnId;
  if (!store.findColumn(scope, columnId)) {
    throw new ApiError("invalid_card", "That column is not on this board.", 400);
  }
  if (move.beforeId === current.id) {
    throw new ApiError("invalid_card", "A card cannot move above itself.", 400);
  }
  return placeCard(scope, columnId, move.beforeId, current.id);
}

/** A failed compare-and-set: a conflict when the card is still there, else not found. */
function refusal(scope: BoardScope, cardId: string): ApiError {
  const current = store.findCard(scope, cardId);
  return current ? new CardConflictError(current) : cardNotFound();
}

export function updateCard(
  scope: BoardScope,
  cardId: string,
  input: UpdateCardInput,
  now: number = Date.now(),
): CardDetail {
  return commit(scope, (events) => {
    const current = store.findCard(scope, cardId);
    if (!current) {
      throw cardNotFound();
    }
    if (current.version !== input.version) {
      throw new CardConflictError(current);
    }
    const changes: CardChanges = {};
    const edited: string[] = [];
    if (input.title !== undefined && input.title !== current.title) {
      changes.title = input.title;
      edited.push("title");
    }
    if (input.description !== undefined && input.description !== current.description) {
      changes.descriptionSealed = input.description ? sealBoardText(input.description) : null;
      edited.push("description");
    }
    if (input.dueAt !== undefined && input.dueAt !== current.dueAt) {
      changes.dueAt = input.dueAt;
      edited.push("dueAt");
    }
    const move = input.move ? resolveMove(scope, current, input.move) : null;
    if (move) {
      changes.columnId = move.columnId;
      changes.position = move.position;
    }
    const assigneeChanged =
      input.assignee !== undefined && (input.assignee?.userId ?? null) !== (current.assignee?.userId ?? null);
    if (assigneeChanged && input.assignee) {
      requireMember(scope, input.assignee.userId);
    }
    if (assigneeChanged) {
      changes.assigneeUserId = input.assignee?.userId ?? null;
    }
    if (edited.length === 0 && !move && !assigneeChanged) {
      return current;
    }
    if (!store.updateCardIfVersion(scope, cardId, input.version, changes, now)) {
      throw refusal(scope, cardId);
    }
    const version = input.version + 1;
    if (move) {
      noteRebalance(scope, move, events, now);
    }
    if (edited.length > 0) {
      events.push(store.insertEvent(scope, cardId, "card.edited", { version, fields: edited }, PERSON(scope), now));
    }
    if (move) {
      events.push(
        store.insertEvent(
          scope,
          cardId,
          "card.moved",
          { fromColumnId: current.columnId, toColumnId: move.columnId, position: move.position },
          PERSON(scope),
          now,
        ),
      );
    }
    if (assigneeChanged) {
      events.push(
        store.insertEvent(
          scope,
          cardId,
          "card.assigned",
          input.assignee
            ? { assigneeKind: "person", assigneeUserId: input.assignee.userId }
            : { assigneeKind: null, assigneeUserId: null },
          PERSON(scope),
          now,
        ),
      );
    }
    const updated = store.findCard(scope, cardId);
    if (!updated) {
      throw new Error("board: an updated card did not read back");
    }
    return updated;
  });
}

/**
 * Who may archive a card (security review of K0, M4; spec section 13): its creator, its assignee, or an
 * owner or admin. Checked after the card is found, so another company still gets the plain 404.
 */
export function mayArchive(scope: BoardScope, card: CardDetail): boolean {
  return card.createdBy === scope.userId || card.assignee?.userId === scope.userId || canAdminister(scope.role);
}

export function archiveCard(scope: BoardScope, cardId: string, version: number, now: number = Date.now()): void {
  commit(scope, (events) => {
    const current = store.findCard(scope, cardId);
    if (!current) {
      throw cardNotFound();
    }
    if (!mayArchive(scope, current)) {
      throw new ApiError(
        "not_allowed",
        "Only the card's creator, its assignee, or an owner or admin can archive it.",
        403,
      );
    }
    if (!store.updateCardIfVersion(scope, cardId, version, { archivedAt: now }, now)) {
      throw refusal(scope, cardId);
    }
    events.push(store.insertEvent(scope, cardId, "card.archived", {}, PERSON(scope), now));
    store.insertAudit(scope, "card.archive", cardId, now);
  });
}

/**
 * Bring an archived card back (owner or admin only). It returns to the end of the column it was archived
 * from, or to To do when that column is gone, and the restore is audited.
 */
export function restoreCard(scope: BoardScope, cardId: string, version: number, now: number = Date.now()): CardDetail {
  requireAdmin(scope, "Only an owner or admin can restore an archived card.");
  return commit(scope, (events) => {
    store.seedColumns(scope, now);
    const archived = store.findArchivedCard(scope, cardId);
    if (!archived) {
      throw cardNotFound();
    }
    if (archived.version !== version) {
      throw new ApiError("card_conflict", "Someone changed this card since you opened it.", 409);
    }
    requireRoomForCard(scope);
    const column = store.findColumn(scope, archived.columnId) ?? store.columnOfKind(scope, "todo");
    if (!column) {
      throw new Error("board: a desk with seeded columns has no To do column");
    }
    const placement = placeCard(scope, column.id, null, cardId);
    noteRebalance(scope, placement, events, now);
    if (!store.restoreCardIfVersion(scope, cardId, version, placement, now)) {
      throw new ApiError("card_conflict", "Someone changed this card since you opened it.", 409);
    }
    events.push(
      store.insertEvent(
        scope,
        cardId,
        "card.restored",
        { columnId: placement.columnId, position: placement.position },
        PERSON(scope),
        now,
      ),
    );
    store.insertAudit(scope, "card.restore", cardId, now);
    const restored = store.findCard(scope, cardId);
    if (!restored) {
      throw new Error("board: a restored card did not read back");
    }
    return restored;
  });
}

export function addComment(scope: BoardScope, cardId: string, body: string, now: number = Date.now()): CardComment {
  return commit(scope, (events) => {
    if (!store.cardIsLive(scope, cardId)) {
      throw cardNotFound();
    }
    if (store.liveCommentCount(scope, cardId) >= volume.commentsPerCard) {
      throw new ApiError("comment_limit", "This card has as many comments as it can hold.", 409);
    }
    const commentId = store.insertComment(scope, cardId, sealBoardText(body), now);
    events.push(store.insertEvent(scope, cardId, "comment.added", { commentId }, PERSON(scope), now));
    const comment = store.findComment(scope, commentId);
    if (!comment) {
      throw new Error("board: a comment written in this transaction did not read back");
    }
    return comment;
  });
}

function reorder(columns: readonly BoardColumn[], columnId: string, index: number): string[] {
  const ids = columns.map((column) => column.id).filter((id) => id !== columnId);
  ids.splice(Math.min(index, ids.length), 0, columnId);
  return ids;
}

export function createColumn(scope: BoardScope, input: CreateColumnInput, now: number = Date.now()): BoardColumn {
  requireAdmin(scope);
  return commit(scope, (events) => {
    store.seedColumns(scope, now);
    const columns = store.listColumns(scope);
    if (columns.length >= volume.columns) {
      throw new ApiError("column_limit", "This board has as many columns as it can hold.", 409);
    }
    const id = store.insertColumn(scope, input.name, (columns.at(-1)?.position ?? -1) + 1, now);
    if (input.position !== null) {
      store.writeColumnOrder(scope, reorder(store.listColumns(scope), id, input.position));
    }
    events.push(store.insertEvent(scope, null, "column.changed", { columnId: id }, PERSON(scope), now));
    store.insertAudit(scope, "column.create", id, now);
    const created = store.findColumn(scope, id);
    if (!created) {
      throw new Error("board: a column written in this transaction did not read back");
    }
    return created;
  });
}

export function updateColumn(
  scope: BoardScope,
  columnId: string,
  input: UpdateColumnInput,
  now: number = Date.now(),
): BoardColumn | null {
  requireAdmin(scope);
  return commit(scope, (events) => {
    const column = store.findColumn(scope, columnId);
    if (!column) {
      throw columnNotFound();
    }
    if (input.name !== undefined) {
      if (input.name === null && column.kind === "custom") {
        throw new ApiError("invalid_column", "A custom column needs a name.", 400);
      }
      store.renameColumn(scope, columnId, input.name);
      store.insertAudit(scope, "column.rename", columnId, now);
    }
    if (input.position !== undefined) {
      store.writeColumnOrder(scope, reorder(store.listColumns(scope), columnId, input.position));
    }
    if (input.archived) {
      if (column.kind !== "custom") {
        throw new ApiError("builtin_column", "A built-in column cannot be archived.", 409);
      }
      if (store.liveCardCount(scope, columnId) > 0) {
        throw new ApiError("column_not_empty", "Move or archive this column's cards first.", 409);
      }
      store.archiveColumnRow(scope, columnId, now);
      store.writeColumnOrder(
        scope,
        store.listColumns(scope).map((live) => live.id),
      );
      store.insertAudit(scope, "column.archive", columnId, now);
    }
    events.push(store.insertEvent(scope, null, "column.changed", { columnId }, PERSON(scope), now));
    return input.archived ? null : store.findColumn(scope, columnId);
  });
}
