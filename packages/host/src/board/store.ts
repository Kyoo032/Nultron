/**
 * Every SQL statement the board runs (team-board-spec.md section 16, risk 5: the board's SQL stays in
 * `board/`). Synchronous better-sqlite3, so a service call wraps several of these in one transaction.
 *
 * Every statement filters on `tenant_id` AND `workspace_id` from the caller's resolved `TenantContext`,
 * never from the request. A card, column or comment of another desk is simply not found.
 */
import { sql } from "@agentforge/db";
import type { TenantContext } from "@agentforge/core";
import { openBoardText } from "./seal";
import {
  BUILTIN_COLUMN_KINDS,
  boardId,
  type BoardColumn,
  type BoardEventRow,
  type BoardPerson,
  type CardComment,
  type CardDetail,
  type CardSummary,
  type ColumnKind,
} from "./types";

export type BoardScope = Pick<TenantContext, "tenantId" | "organizationId" | "workspaceId" | "userId" | "role">;

type ColumnRow = { id: string; kind: ColumnKind; name: string | null; position: number };

type CardRow = {
  id: string;
  column_id: string;
  position: string;
  title: string;
  description: string | null;
  assignee_kind: "person" | "agent" | null;
  assignee_user_id: string | null;
  due_at: number | null;
  version: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  comment_count: number;
};

const CARD_COLUMNS = `c.id, c.column_id, c.position, c.title, c.description, c.assignee_kind, c.assignee_user_id,
  c.due_at, c.version, c.created_by, c.created_at, c.updated_at,
  (SELECT count(*) FROM card_comments m WHERE m.card_id = c.id AND m.deleted_at IS NULL) AS comment_count`;

function toSummary(row: CardRow): CardSummary {
  return {
    id: row.id,
    columnId: row.column_id,
    position: row.position,
    title: row.title,
    assignee:
      row.assignee_kind === "person" && row.assignee_user_id ? { kind: "person", userId: row.assignee_user_id } : null,
    dueAt: row.due_at,
    version: row.version,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    commentCount: row.comment_count,
  };
}

/** The five built-in columns, once per desk. `INSERT OR IGNORE` on the per-kind unique index. */
export function seedColumns(scope: BoardScope, now: number): void {
  const insert = sql.prepare(
    `INSERT OR IGNORE INTO board_columns (id, tenant_id, workspace_id, name, position, kind, created_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?)`,
  );
  const existing = sql
    .prepare(`SELECT count(*) AS n FROM board_columns WHERE tenant_id = ? AND workspace_id = ? AND kind <> 'custom'`)
    .get(scope.tenantId, scope.workspaceId) as { n: number };
  if (existing.n >= BUILTIN_COLUMN_KINDS.length) {
    return;
  }
  BUILTIN_COLUMN_KINDS.forEach((kind, index) => {
    insert.run(boardId(now), scope.tenantId, scope.workspaceId, index, kind, now);
  });
}

export function listColumns(scope: BoardScope): BoardColumn[] {
  return sql
    .prepare(
      `SELECT id, kind, name, position FROM board_columns
        WHERE tenant_id = ? AND workspace_id = ? AND archived_at IS NULL ORDER BY position`,
    )
    .all(scope.tenantId, scope.workspaceId) as ColumnRow[];
}

export function findColumn(scope: BoardScope, columnId: string): BoardColumn | null {
  const row = sql
    .prepare(
      `SELECT id, kind, name, position FROM board_columns
        WHERE id = ? AND tenant_id = ? AND workspace_id = ? AND archived_at IS NULL`,
    )
    .get(columnId, scope.tenantId, scope.workspaceId) as ColumnRow | undefined;
  return row ?? null;
}

export function columnOfKind(scope: BoardScope, kind: ColumnKind): BoardColumn | null {
  const row = sql
    .prepare(
      `SELECT id, kind, name, position FROM board_columns
        WHERE kind = ? AND tenant_id = ? AND workspace_id = ? AND archived_at IS NULL ORDER BY position LIMIT 1`,
    )
    .get(kind, scope.tenantId, scope.workspaceId) as ColumnRow | undefined;
  return row ?? null;
}

export function insertColumn(scope: BoardScope, name: string, position: number, now: number): string {
  const id = boardId(now);
  sql
    .prepare(
      `INSERT INTO board_columns (id, tenant_id, workspace_id, name, position, kind, created_at)
       VALUES (?, ?, ?, ?, ?, 'custom', ?)`,
    )
    .run(id, scope.tenantId, scope.workspaceId, name, position, now);
  return id;
}

export function renameColumn(scope: BoardScope, columnId: string, name: string | null): void {
  sql
    .prepare(`UPDATE board_columns SET name = ? WHERE id = ? AND tenant_id = ? AND workspace_id = ?`)
    .run(name, columnId, scope.tenantId, scope.workspaceId);
}

export function archiveColumnRow(scope: BoardScope, columnId: string, now: number): void {
  sql
    .prepare(`UPDATE board_columns SET archived_at = ? WHERE id = ? AND tenant_id = ? AND workspace_id = ?`)
    .run(now, columnId, scope.tenantId, scope.workspaceId);
}

/**
 * Write the live columns' order as given. Two passes, because `(workspace_id, position)` is unique
 * among live columns and a swap would collide half way: first everything moves out of the way.
 */
export function writeColumnOrder(scope: BoardScope, orderedIds: readonly string[]): void {
  const move = sql.prepare(`UPDATE board_columns SET position = ? WHERE id = ? AND tenant_id = ? AND workspace_id = ?`);
  for (const [index, id] of orderedIds.entries()) {
    move.run(-1 - index, id, scope.tenantId, scope.workspaceId);
  }
  for (const [index, id] of orderedIds.entries()) {
    move.run(index, id, scope.tenantId, scope.workspaceId);
  }
}

export function liveCardCount(scope: BoardScope, columnId: string): number {
  return (
    sql
      .prepare(
        `SELECT count(*) AS n FROM cards WHERE column_id = ? AND tenant_id = ? AND workspace_id = ? AND archived_at IS NULL`,
      )
      .get(columnId, scope.tenantId, scope.workspaceId) as { n: number }
  ).n;
}

export function listCards(scope: BoardScope): CardSummary[] {
  const rows = sql
    .prepare(
      `SELECT ${CARD_COLUMNS} FROM cards c
        WHERE c.tenant_id = ? AND c.workspace_id = ? AND c.archived_at IS NULL
        ORDER BY c.column_id, c.position, c.id`,
    )
    .all(scope.tenantId, scope.workspaceId) as CardRow[];
  return rows.map(toSummary);
}

export function findCard(scope: BoardScope, cardId: string): CardDetail | null {
  const row = sql
    .prepare(
      `SELECT ${CARD_COLUMNS} FROM cards c
        WHERE c.id = ? AND c.tenant_id = ? AND c.workspace_id = ? AND c.archived_at IS NULL`,
    )
    .get(cardId, scope.tenantId, scope.workspaceId) as CardRow | undefined;
  return row ? { ...toSummary(row), description: openBoardText(row.description) } : null;
}

/** The position keys of a column's live cards, in order, leaving one card out (the one being moved). */
export function columnPositions(
  scope: BoardScope,
  columnId: string,
  excludeCardId: string | null,
): Array<{ id: string; position: string }> {
  return sql
    .prepare(
      `SELECT id, position FROM cards
        WHERE column_id = ? AND tenant_id = ? AND workspace_id = ? AND archived_at IS NULL AND id IS NOT ?
        ORDER BY position, id`,
    )
    .all(columnId, scope.tenantId, scope.workspaceId, excludeCardId) as Array<{ id: string; position: string }>;
}

export type NewCardRow = {
  readonly id: string;
  readonly columnId: string;
  readonly position: string;
  readonly title: string;
  readonly descriptionSealed: string | null;
  readonly assigneeUserId: string | null;
  readonly now: number;
};

export function insertCard(scope: BoardScope, card: NewCardRow): void {
  sql
    .prepare(
      `INSERT INTO cards (id, tenant_id, workspace_id, column_id, position, title, description, assignee_kind,
         assignee_user_id, created_by, due_at, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
    )
    .run(
      card.id,
      scope.tenantId,
      scope.workspaceId,
      card.columnId,
      card.position,
      card.title,
      card.descriptionSealed,
      card.assigneeUserId ? "person" : null,
      card.assigneeUserId,
      scope.userId,
      card.now,
      card.now,
    );
}

export type CardChanges = {
  title?: string;
  descriptionSealed?: string | null;
  columnId?: string;
  position?: string;
  assigneeUserId?: string | null;
  dueAt?: number | null;
  archivedAt?: number;
};

/**
 * The compare-and-set write (spec section 7, rule 2): `WHERE version = ?`. Returns false when no row
 * matched, which the caller turns into `409 card_conflict` or `404`.
 */
export function updateCardIfVersion(
  scope: BoardScope,
  cardId: string,
  version: number,
  changes: CardChanges,
  now: number,
): boolean {
  const sets: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown) => {
    sets.push(`${column} = ?`);
    values.push(value);
  };
  if (changes.title !== undefined) set("title", changes.title);
  if (changes.descriptionSealed !== undefined) set("description", changes.descriptionSealed);
  if (changes.columnId !== undefined) set("column_id", changes.columnId);
  if (changes.position !== undefined) set("position", changes.position);
  if (changes.assigneeUserId !== undefined) {
    set("assignee_kind", changes.assigneeUserId ? "person" : null);
    set("assignee_user_id", changes.assigneeUserId);
  }
  if (changes.dueAt !== undefined) set("due_at", changes.dueAt);
  if (changes.archivedAt !== undefined) set("archived_at", changes.archivedAt);
  set("updated_at", now);
  const result = sql
    .prepare(
      `UPDATE cards SET ${sets.join(", ")}, version = version + 1
        WHERE id = ? AND tenant_id = ? AND workspace_id = ? AND version = ? AND archived_at IS NULL`,
    )
    .run(...values, cardId, scope.tenantId, scope.workspaceId, version);
  return result.changes === 1;
}

export function insertComment(scope: BoardScope, cardId: string, bodySealed: string, now: number): string {
  const id = boardId(now);
  sql
    .prepare(
      `INSERT INTO card_comments (id, tenant_id, workspace_id, card_id, author_kind, author_user_id, body, created_at)
       VALUES (?, ?, ?, ?, 'person', ?, ?, ?)`,
    )
    .run(id, scope.tenantId, scope.workspaceId, cardId, scope.userId, bodySealed, now);
  return id;
}

type CommentRow = {
  id: string;
  card_id: string;
  author_kind: "person" | "agent";
  author_user_id: string;
  body: string;
  created_at: number;
};

function toComment(row: CommentRow): CardComment {
  return {
    id: row.id,
    cardId: row.card_id,
    authorKind: row.author_kind,
    authorUserId: row.author_user_id,
    body: openBoardText(row.body),
    createdAt: row.created_at,
  };
}

export function listComments(scope: BoardScope, cardId: string): CardComment[] {
  const rows = sql
    .prepare(
      `SELECT id, card_id, author_kind, author_user_id, body, created_at FROM card_comments
        WHERE card_id = ? AND tenant_id = ? AND workspace_id = ? AND deleted_at IS NULL
        ORDER BY created_at, id`,
    )
    .all(cardId, scope.tenantId, scope.workspaceId) as CommentRow[];
  return rows.map(toComment);
}

export function findComment(scope: BoardScope, commentId: string): CardComment | null {
  const row = sql
    .prepare(
      `SELECT id, card_id, author_kind, author_user_id, body, created_at FROM card_comments
        WHERE id = ? AND tenant_id = ? AND workspace_id = ?`,
    )
    .get(commentId, scope.tenantId, scope.workspaceId) as CommentRow | undefined;
  return row ? toComment(row) : null;
}

export type EventActor = { readonly kind: "person" | "agent" | "system"; readonly userId: string | null };

export function insertEvent(
  scope: BoardScope,
  cardId: string | null,
  type: string,
  payload: Record<string, unknown>,
  actor: EventActor,
  now: number,
): number {
  const result = sql
    .prepare(
      `INSERT INTO card_events (tenant_id, workspace_id, card_id, actor_kind, actor_user_id, type, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(scope.tenantId, scope.workspaceId, cardId, actor.kind, actor.userId, type, JSON.stringify(payload), now);
  return Number(result.lastInsertRowid);
}

export function insertAudit(scope: BoardScope, action: string, target: string, now: number): void {
  sql
    .prepare(
      `INSERT INTO board_audit (id, tenant_id, workspace_id, actor_user_id, action, target, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(boardId(now), scope.tenantId, scope.workspaceId, scope.userId, action, target, now);
}

export function latestEventId(scope: Pick<BoardScope, "tenantId" | "workspaceId">): number {
  const row = sql
    .prepare(`SELECT max(id) AS id FROM card_events WHERE tenant_id = ? AND workspace_id = ?`)
    .get(scope.tenantId, scope.workspaceId) as { id: number | null };
  return row.id ?? 0;
}

export function countEventsAfter(
  scope: Pick<BoardScope, "tenantId" | "workspaceId">,
  after: number,
  cap: number,
): number {
  const row = sql
    .prepare(
      `SELECT count(*) AS n FROM (SELECT 1 FROM card_events WHERE tenant_id = ? AND workspace_id = ? AND id > ? LIMIT ?)`,
    )
    .get(scope.tenantId, scope.workspaceId, after, cap) as { n: number };
  return row.n;
}

export function eventsAfter(
  scope: Pick<BoardScope, "tenantId" | "workspaceId">,
  after: number,
  limit: number,
): BoardEventRow[] {
  const rows = sql
    .prepare(
      `SELECT id, card_id, type, payload FROM card_events
        WHERE tenant_id = ? AND workspace_id = ? AND id > ? ORDER BY id LIMIT ?`,
    )
    .all(scope.tenantId, scope.workspaceId, after, limit) as Array<{
    id: number;
    card_id: string | null;
    type: string;
    payload: string;
  }>;
  return rows.map((row) => ({ id: row.id, cardId: row.card_id, type: row.type, payload: parsePayload(row.payload) }));
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The desk's live cards, for the volume cap (spec section 13). */
export function liveCardTotal(scope: Pick<BoardScope, "tenantId" | "workspaceId">): number {
  return (
    sql
      .prepare(`SELECT count(*) AS n FROM cards WHERE tenant_id = ? AND workspace_id = ? AND archived_at IS NULL`)
      .get(scope.tenantId, scope.workspaceId) as { n: number }
  ).n;
}

/** A card's comments that are not deleted, for the volume cap. */
export function liveCommentCount(scope: Pick<BoardScope, "tenantId" | "workspaceId">, cardId: string): number {
  return (
    sql
      .prepare(
        `SELECT count(*) AS n FROM card_comments
          WHERE card_id = ? AND tenant_id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      )
      .get(cardId, scope.tenantId, scope.workspaceId) as { n: number }
  ).n;
}

/**
 * A position rewrite by the service itself (the column's keys grew long). It is not a person's change, so
 * neither `version` nor `updated_at` moves: an open card dialog does not get a conflict out of it.
 */
export function setCardPosition(scope: BoardScope, cardId: string, position: string): void {
  sql
    .prepare(`UPDATE cards SET position = ? WHERE id = ? AND tenant_id = ? AND workspace_id = ?`)
    .run(position, cardId, scope.tenantId, scope.workspaceId);
}

/** An archived card of this desk, with its column and version, or null. */
export function findArchivedCard(
  scope: BoardScope,
  cardId: string,
): { id: string; columnId: string; version: number } | null {
  const row = sql
    .prepare(
      `SELECT id, column_id, version FROM cards
        WHERE id = ? AND tenant_id = ? AND workspace_id = ? AND archived_at IS NOT NULL`,
    )
    .get(cardId, scope.tenantId, scope.workspaceId) as { id: string; column_id: string; version: number } | undefined;
  return row ? { id: row.id, columnId: row.column_id, version: row.version } : null;
}

/** The restore's compare-and-set: only an archived card at `version` comes back. */
export function restoreCardIfVersion(
  scope: BoardScope,
  cardId: string,
  version: number,
  placement: { columnId: string; position: string },
  now: number,
): boolean {
  const result = sql
    .prepare(
      `UPDATE cards SET archived_at = NULL, column_id = ?, position = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND tenant_id = ? AND workspace_id = ? AND version = ? AND archived_at IS NOT NULL`,
    )
    .run(placement.columnId, placement.position, now, cardId, scope.tenantId, scope.workspaceId, version);
  return result.changes === 1;
}

/** True when the card exists on this desk and is not archived. */
export function cardIsLive(scope: Pick<BoardScope, "tenantId" | "workspaceId">, cardId: string): boolean {
  return (
    sql
      .prepare(`SELECT 1 AS ok FROM cards WHERE id = ? AND tenant_id = ? AND workspace_id = ? AND archived_at IS NULL`)
      .get(cardId, scope.tenantId, scope.workspaceId) !== undefined
  );
}

/** The people of the caller's company, by display name. Never reads anything personal beyond the name. */
export function listPeople(scope: BoardScope): BoardPerson[] {
  return sql
    .prepare(
      `SELECT u.id AS userId, u.name AS name
         FROM organization_members om
         JOIN organizations o ON o.id = om.organization_id
         JOIN user u ON u.id = om.user_id
        WHERE om.organization_id = ? AND o.tenant_id = ?
        ORDER BY u.name, u.id`,
    )
    .all(scope.organizationId, scope.tenantId) as BoardPerson[];
}

export function isCompanyMember(scope: BoardScope, userId: string): boolean {
  return (
    sql
      .prepare(
        `SELECT 1 AS ok FROM organization_members om JOIN organizations o ON o.id = om.organization_id
          WHERE om.organization_id = ? AND o.tenant_id = ? AND om.user_id = ?`,
      )
      .get(scope.organizationId, scope.tenantId, userId) !== undefined
  );
}

/** Runs `work` in one SQLite transaction. */
export function inTransaction<T>(work: () => T): T {
  return sql.transaction(work)();
}
