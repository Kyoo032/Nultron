/**
 * The team board's company tables, phase K0 (docs/internal/team-board-spec.md, section 6.1).
 *
 * WHY A HEALER AND NO JOURNAL ENTRY. This is tester code (`tester/chat-first`). `main` adds its own
 * migrations to `drizzle/meta/_journal.json`, and the runner orders them by `when`, so a tester entry
 * there would either collide textually at the next merge from `main` or, with a `when` above main's
 * next one, make every tester database skip main's migration. `CREATE TABLE IF NOT EXISTS` on every
 * boot, like the other `ensure*` healers, needs neither. The promotion pull request turns this into a
 * numbered migration.
 *
 * Only the five tables K0 writes are here. `card_mentions`, `card_files`, `notifications` and
 * `agent_tasks` arrive with K2 to K4: no K0 table references them, and an empty table with no writer
 * would only be one more thing for the tenant purge to classify. `card_comments.agent_task_id` is
 * declared now, nullable and without a foreign key, so K2 adds a table rather than altering one.
 *
 * Every table hangs off `workspaces` with `ON DELETE cascade`, so deleting a desk or erasing a tenant
 * (the cascade from `organizations`, `tenant-purge.ts`) takes the board with it.
 *
 * `card_events.id` is `INTEGER PRIMARY KEY` without `AUTOINCREMENT`: AUTOINCREMENT would add
 * `sqlite_sequence`, an internal table the purge census would have to classify. A rowid alias is
 * still monotonic for the stream's purpose, because events are never deleted except with their whole
 * desk, and a reused id is always above every id a surviving desk has handed out.
 */
import type Database from "better-sqlite3";

export const BOARD_TABLES = ["board_columns", "cards", "card_comments", "card_events", "board_audit"] as const;

/**
 * Spec section 6 puts `tenant_id` on every board row so every query can filter on it. Everywhere else
 * the schema reaches the tenant through `organizations` (`migrate-0015.test.ts`), because a second copy
 * is "an invariant nothing enforces". These triggers enforce it: a row whose `tenant_id` is not its
 * desk's organization's tenant is refused on insert and on any update of either column.
 */
function tenantGuards(table: string): string {
  const mismatch = `NEW.tenant_id IS NOT (SELECT o.tenant_id FROM workspaces w JOIN organizations o ON o.id = w.organization_id WHERE w.id = NEW.workspace_id)`;
  return `
    CREATE TRIGGER IF NOT EXISTS ${table}_tenant_insert_guard BEFORE INSERT ON ${table}
      WHEN ${mismatch} BEGIN SELECT RAISE(ABORT, 'board_tenant_mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_tenant_update_guard BEFORE UPDATE OF tenant_id, workspace_id ON ${table}
      WHEN ${mismatch} BEGIN SELECT RAISE(ABORT, 'board_tenant_mismatch'); END;`;
}

export function ensureBoardTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS board_columns (
      id text PRIMARY KEY NOT NULL,
      tenant_id text NOT NULL,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE cascade,
      name text,
      position integer NOT NULL,
      kind text NOT NULL,
      created_at integer NOT NULL,
      archived_at integer,
      CONSTRAINT board_columns_kind_check CHECK (kind IN ('todo', 'doing', 'review', 'blocked', 'done', 'custom'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS board_columns_live_position ON board_columns (workspace_id, position) WHERE archived_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS board_columns_builtin_kind ON board_columns (workspace_id, kind) WHERE kind <> 'custom';
    CREATE TABLE IF NOT EXISTS cards (
      id text PRIMARY KEY NOT NULL,
      tenant_id text NOT NULL,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE cascade,
      column_id text NOT NULL REFERENCES board_columns(id) ON DELETE cascade,
      position text NOT NULL,
      title text NOT NULL,
      description text,
      assignee_kind text,
      assignee_user_id text,
      created_by text NOT NULL,
      due_at integer,
      version integer NOT NULL DEFAULT 1,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      archived_at integer,
      CONSTRAINT cards_assignee_kind_check CHECK (assignee_kind IS NULL OR assignee_kind IN ('person', 'agent')),
      CONSTRAINT cards_assignee_pair_check CHECK ((assignee_kind IS NULL) = (assignee_user_id IS NULL))
    );
    CREATE INDEX IF NOT EXISTS cards_ws_column_position_idx ON cards (workspace_id, column_id, position);
    CREATE TABLE IF NOT EXISTS card_comments (
      id text PRIMARY KEY NOT NULL,
      tenant_id text NOT NULL,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE cascade,
      card_id text NOT NULL REFERENCES cards(id) ON DELETE cascade,
      author_kind text NOT NULL,
      author_user_id text NOT NULL,
      body text NOT NULL,
      agent_task_id text,
      created_at integer NOT NULL,
      edited_at integer,
      deleted_at integer,
      CONSTRAINT card_comments_author_kind_check CHECK (author_kind IN ('person', 'agent'))
    );
    CREATE INDEX IF NOT EXISTS card_comments_card_created_idx ON card_comments (card_id, created_at);
    CREATE TABLE IF NOT EXISTS card_events (
      id integer PRIMARY KEY NOT NULL,
      tenant_id text NOT NULL,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE cascade,
      card_id text,
      actor_kind text NOT NULL,
      actor_user_id text,
      type text NOT NULL,
      payload text NOT NULL,
      created_at integer NOT NULL,
      CONSTRAINT card_events_actor_kind_check CHECK (actor_kind IN ('person', 'agent', 'system'))
    );
    CREATE INDEX IF NOT EXISTS card_events_ws_id_idx ON card_events (workspace_id, id);
    CREATE TABLE IF NOT EXISTS board_audit (
      id text PRIMARY KEY NOT NULL,
      tenant_id text NOT NULL,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE cascade,
      actor_user_id text NOT NULL,
      action text NOT NULL,
      target text NOT NULL,
      created_at integer NOT NULL,
      CONSTRAINT board_audit_action_check CHECK (action IN ('column.create', 'column.rename', 'column.archive', 'card.archive', 'card.restore', 'member.remove_from_board', 'leaver.decide'))
    );
    CREATE INDEX IF NOT EXISTS board_audit_ws_created_idx ON board_audit (workspace_id, created_at);
  `);
  sqlite.exec(BOARD_TABLES.map(tenantGuards).join("\n"));
}
