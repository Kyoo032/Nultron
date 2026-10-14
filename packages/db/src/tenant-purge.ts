/**
 * Phase 8 — erase one tenant's rows, and nobody else's.
 *
 * This is the database half of the hosted "Start over". The file half (the storage prefix, the
 * secrets, the gate verdict) lives in `packages/host/src/tenant-reset.ts`, which drives this.
 *
 * **Why this is a plan and not a list of DELETE statements.** The schema has forty-odd tables and
 * will have more. A hand-written sequence of deletes is correct on the day it is written and
 * silently wrong the first time somebody adds a table, in the worst possible direction: a table
 * nobody classified is a table whose rows survive a reset, so a tenant who asked for their data to
 * be gone keeps a copy of it and nobody finds out. So every table in the schema is classified here
 * into exactly one bucket, and `tenant-purge.test.ts` re-derives the real table list from a fresh
 * `ensureSchema` database and fails when a table is in none of them. A new table cannot ship
 * without somebody deciding what a reset does to it.
 *
 * **The four buckets.**
 *
 * - `cascade` — `organizations`. One DELETE by `tenant_id` takes workspaces, agents, threads,
 *   messages, runs, tool invocations, media and the edit trees with it, because every one of those
 *   declares `ON DELETE cascade` up to it and `client.ts` sets `PRAGMA foreign_keys = ON`. Letting
 *   SQLite do this is not laziness: the cascade is derived from the same schema the tables are, so
 *   it cannot fall out of step with them the way a hand-kept order would.
 * - `byWorkspace` — the knowledge tables, `artifacts`, `datasets`, `desk_files` and
 *   `file_proposals`. These carry a
 *   `workspace_id` with no foreign key (they predate the tenancy work and are written by
 *   subsystems that never held an org id), so the cascade does not reach them. They are deleted
 *   **first**, while the workspace ids are still resolvable, because the cascade is what destroys
 *   the only mapping from a tenant to its desks.
 * - `byTenant` — `tenant_state` (the sealed settings envelope and the gate verdict) and
 *   `tenant_storage` (the byte counter, which must go to nothing at the same moment the bytes do).
 * - `kept` and `shared` — everything a reset must NOT touch, each with its reason on the line.
 *
 * **What is deliberately kept.** `tenants`, `tenant_plan`, `tenant_seat`, `tenant_usage` and
 * `billing_events`: a tenant must not be able to erase what they owe, what they have spent or how
 * many seats they hold by pressing a button in their own settings. `tenant_reset_audit` is kept
 * for the same reason plus one more — it is the record of this act, and a reset that erased its
 * own audit trail would be worse than one that kept nothing.
 *
 * **What is deliberately NOT kept any more: sessions and people (owner decision 2026-10-01, SR-65).**
 * Until then `auth_sessions` was kept — "a reset empties an account, it does not sign its people out" —
 * and the host re-staffed the org afterwards. The owner's answer to SR-65 is that erasing the company
 * account deletes every person in it and signs everyone out, so `auth_sessions` is now a `byTenant`
 * table (the sealed refresh tokens go with the rows) and `deleteOrphanedUsers` removes the `user` rows
 * nothing else refers to. The caller's own session goes too: they are signed out by the same
 * transaction that deletes the data, and the renderer follows with the ordinary sign-out.
 *
 * **One transaction, and therefore idempotent.** Everything below runs inside a single
 * `better-sqlite3` transaction, so a process killed half way through leaves the database exactly
 * as it was and the retry starts from the same place. Every statement is a DELETE by id, so a
 * retry after a *completed* purge deletes nothing and reports zero rather than failing.
 */
import type Database from "better-sqlite3";

/** The narrow slice of a connection this module needs. Declared so a test can pass a scratch DB. */
export type PurgeSql = Pick<Database.Database, "prepare" | "transaction">;

/**
 * Tables the cascade from `organizations` reaches, listed so the completeness test can account for
 * them without a second DELETE. Nothing here is deleted by name — SQLite does it.
 */
export const CASCADED_TABLES = [
  "workspaces",
  "workspace_members",
  "organization_members",
  "agents",
  "agent_versions",
  "agent_tool_bindings",
  "threads",
  "messages",
  "runs",
  "tool_invocations",
  "media",
  "edit_projects",
  "edit_ops",
  "edit_snapshots",
  "edit_jobs",
  "edit_cards",
  "edit_unplaced",
  // Reached through `desk_files`, not through `organizations`: the workspace-scoped pass below
  // deletes the desk's files and the foreign key takes their versions with them.
  "desk_file_versions",
  // The team board (tester, `board-schema.ts`): every table references `workspaces` with ON DELETE cascade.
  "board_columns",
  "cards",
  "card_comments",
  "card_events",
  "board_audit",
  // Collective projects (tester, `projects-schema.ts`): a workspace foreign key with ON DELETE cascade.
  "projects",
  // A Workspace's members and the agents brought in: a project foreign key with ON DELETE cascade.
  "project_members",
  "project_agents",
] as const;

/**
 * Tables keyed by a bare `workspace_id` with no foreign key, so the cascade never reaches them.
 * Deleted before the cascade runs, while the tenant's workspace ids can still be resolved.
 *
 * `knowledge_chunks` is an FTS5 virtual table and is deleted the same way the rest of the host
 * already deletes from it (`ensure-local-owner.ts:221`, `knowledge-reindex.ts:238`): a plain
 * `WHERE workspace_id = ?`, which fts5 answers with a scan.
 */
export const WORKSPACE_SCOPED_TABLES = [
  "knowledge_soul",
  "knowledge_memories",
  "knowledge_sources",
  "knowledge_chunks",
  "knowledge_workspace_backend",
  "knowledge_backend_outbox",
  "knowledge_settings",
  "knowledge_vectors",
  "knowledge_retrievals",
  "knowledge_graph_nodes",
  "knowledge_graph_edges",
  "knowledge_verify",
  "knowledge_maps",
  "artifacts",
  "datasets",
  // Desk files: the rows. The sealed version bodies are objects under the tenant's storage prefix,
  // which the host half of the reset removes whole.
  "desk_files",
  "file_proposals",
] as const;

/** Tables keyed directly by `tenant_id` that a reset clears. */
export const TENANT_SCOPED_TABLES = [
  // The sealed settings envelope and the gate verdict (Phase 4). Erasing a tenant's content and
  // leaving their saved gateway key behind would be the one surprise nobody wants from this button.
  "tenant_state",
  // The byte counter (Phase 6). It has to reach zero in the same transaction the rows do, or the
  // tenant is billed storage for objects that no longer exist until somebody runs a recompute.
  "tenant_storage",
  // Every browser session of the tenant, and with each row the portal refresh token sealed on it
  // (`refresh_sealed`, migration 0021). Owner decision 2026-10-01, SR-65: when the company account is
  // erased every person in it is deleted, so nobody stays signed in. It goes in the same transaction
  // as the content, so there is no moment when the data is gone and a session still answers; the
  // next request from any of those browsers finds no row and is a 401. Rows, not revocations: a
  // revoked row would keep a user id and a tenant id for an account that no longer exists.
  "auth_sessions",
] as const;

/**
 * Tables keyed by `tenant_id` that a reset deliberately LEAVES, each with the reason.
 *
 * Read this list as policy, not as an oversight: every entry is something a tenant would benefit
 * from erasing, which is exactly why they may not.
 */
export const KEPT_TENANT_TABLES: Readonly<Record<string, string>> = Object.freeze({
  tenants: "the account itself; a reset empties it, it does not close it",
  tenant_plan: "what the tenant is entitled to and has spent — not theirs to erase",
  tenant_seat: "seats held; erasing them would reset the seat cap from inside the product",
  tenant_usage: "the spend ledger the invoice is built from",
  billing_events: "the provider's own record, idempotency keys included",
  tenant_reset_audit: "the record of this act; a reset that erased it would explain nothing",
});

/**
 * Tables that belong to no tenant. Not kept *for* the tenant — there is nothing of theirs in them.
 */
export const SHARED_TABLES: Readonly<Record<string, string>> = Object.freeze({
  user: "portal identities, shared across orgs and tenants; an erase deletes only those left in no org and with no session (`deleteOrphanedUsers`)",
  tools: "the tool catalogue; the per-tenant bindings go with the cascade",
  market_cache: "a read-through cache of public market data, keyed by ticker",
  market_news_fts: "the FTS index over that same public cache",
  __drizzle_migrations: "the migration journal",
});

/** The root delete. Everything in `CASCADED_TABLES` goes with it. */
export const CASCADE_ROOT_TABLE = "organizations";

export type TenantPurgeResult = {
  /** Rows this purge actually removed, summed over every statement it ran. */
  readonly rowsDeleted: number;
  /** The workspace ids the tenant held, resolved before the cascade destroyed the mapping. */
  readonly workspaceIds: readonly string[];
  /** `auth_sessions` rows removed: every browser that was signed in to this tenant, live or not. */
  readonly sessionsDeleted: number;
  /** `user` rows removed: the people left in no org and with no session once the tenant is gone. */
  readonly usersDeleted: number;
};

/**
 * One live browser session of a tenant, as the host needs it to end the portal's session behind it.
 *
 * `idHash` is the row's own `id`, the sha256 digest of the cookie's value (migration 0021) — never
 * the cookie. The sealed token is bound to exactly that digest (`auth/session-secrets.ts`), so the
 * digest is all that is needed to open it; the cookie itself is not recoverable from the table, which
 * is the point of storing a digest.
 */
export type TenantSessionSeal = {
  readonly idHash: string;
  readonly userId: string;
  readonly refreshSealed: string;
};

/**
 * The live sessions of this tenant that still hold a sealed portal refresh token, most recently seen
 * first. Read **before** the purge, because the purge deletes the rows and with them the only copy of
 * the tokens: the host opens these to sign each person out at the portal on a best-effort basis.
 *
 * Revoked rows are skipped (their token was wiped when they were revoked) and so are rows that hold
 * none (a session that idled out, or one signed in before the token was kept at rest).
 */
export function tenantSessionSeals(sql: PurgeSql, tenantId: string): TenantSessionSeal[] {
  return sql
    .prepare(
      `SELECT id AS idHash, user_id AS userId, refresh_sealed AS refreshSealed
         FROM auth_sessions
        WHERE tenant_id = ? AND revoked_at IS NULL AND refresh_sealed IS NOT NULL
        ORDER BY last_seen_at DESC`,
    )
    .all(tenantId) as TenantSessionSeal[];
}

/** Every person this tenant knows: its org members and anybody who held one of its sessions. */
function candidateUserIds(sql: PurgeSql, tenantId: string): string[] {
  const rows = sql
    .prepare(
      `SELECT om.user_id AS id
         FROM organization_members om
         JOIN organizations o ON o.id = om.organization_id
        WHERE o.tenant_id = ?
       UNION
       SELECT user_id AS id FROM auth_sessions WHERE tenant_id = ?`,
    )
    .all(tenantId, tenantId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/**
 * Delete the people an erased tenant leaves behind, and only them.
 *
 * `user` is shared across orgs and tenants (a portal identity is one person wherever they work), so a
 * person is deleted only when nothing else refers to them any more: no membership of any org, and no
 * session in any tenant. Run **after** the cascade and the session delete, so the membership and
 * session rows of this tenant are already gone and what remains is exactly "somewhere else".
 * Workspace memberships hang off `user` with `ON DELETE cascade`, so none can block the delete.
 */
function deleteOrphanedUsers(sql: PurgeSql, userIds: readonly string[]): number {
  const statement = sql.prepare(
    `DELETE FROM user
      WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM organization_members WHERE user_id = user.id)
        AND NOT EXISTS (SELECT 1 FROM auth_sessions WHERE user_id = user.id)`,
  );
  let deleted = 0;
  for (const userId of userIds) {
    deleted += Number(statement.run(userId).changes ?? 0);
  }
  return deleted;
}

function workspaceIdsOf(sql: PurgeSql, tenantId: string): string[] {
  const rows = sql
    .prepare(
      `SELECT w.id AS id
         FROM workspaces w
         JOIN organizations o ON o.id = w.organization_id
        WHERE o.tenant_id = ?`,
    )
    .all(tenantId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/**
 * Every workspace id this tenant holds. Exported because the host half needs the same list to
 * decide which on-disk job trees belong to the tenant, and it has to read it **before** the purge.
 */
export function tenantWorkspaceIds(sql: PurgeSql, tenantId: string): string[] {
  return workspaceIdsOf(sql, tenantId);
}

/**
 * Delete one tenant's content. Synchronous and transactional; see the module comment for what is
 * removed, what is kept and why.
 *
 * `tenantId` is used only as a bound parameter, never interpolated. The table names below are
 * compile-time constants from the arrays above and never come from a caller.
 */
export function purgeTenantRows(sql: PurgeSql, tenantId: string): TenantPurgeResult {
  const run = sql.transaction((): TenantPurgeResult => {
    const workspaceIds = workspaceIdsOf(sql, tenantId);
    // Read while the memberships and sessions still exist: after the cascade there is no way left to
    // say who the tenant's people were.
    const people = candidateUserIds(sql, tenantId);
    let rowsDeleted = 0;
    let sessionsDeleted = 0;

    // Workspace-scoped first: the cascade below deletes `workspaces`, and after that there is no
    // way left to tell this tenant's knowledge rows from anybody else's.
    for (const table of WORKSPACE_SCOPED_TABLES) {
      const statement = sql.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`);
      for (const workspaceId of workspaceIds) {
        rowsDeleted += Number(statement.run(workspaceId).changes ?? 0);
      }
    }

    // The cascade root. One statement, and SQLite takes `CASCADED_TABLES` with it. `changes`
    // counts only the organizations rows, which is why `rowsDeleted` is a floor and the audit row
    // says so rather than claiming a total nobody measured.
    rowsDeleted += Number(
      sql.prepare(`DELETE FROM ${CASCADE_ROOT_TABLE} WHERE tenant_id = ?`).run(tenantId).changes ?? 0,
    );

    for (const table of TENANT_SCOPED_TABLES) {
      const removed = Number(sql.prepare(`DELETE FROM ${table} WHERE tenant_id = ?`).run(tenantId).changes ?? 0);
      rowsDeleted += removed;
      if (table === "auth_sessions") {
        sessionsDeleted = removed;
      }
    }

    // Last: the membership and session rows the check below reads are already gone.
    const usersDeleted = deleteOrphanedUsers(sql, people);
    rowsDeleted += usersDeleted;

    return { rowsDeleted, workspaceIds, sessionsDeleted, usersDeleted };
  });
  return run();
}
