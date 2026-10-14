/**
 * The collective projects table, phase F1 (team-board-spec.md section 2b, K-D19).
 *
 * A project is private to its maker by default. Its maker flips one switch to `workspace`, which makes
 * the project's files visible to, and downloadable by, everyone in the company. A file is shared only
 * while it sits in a workspace project (`SHARED_ARTIFACT_SQL` in `packages/host/src/artifacts.ts`).
 *
 * Added the same way as the board's K0 tables (`board-schema.ts`): `CREATE TABLE IF NOT EXISTS` on
 * every open, not a numbered migration, so the tester branch never edits the journal `main` owns.
 *
 * There is no `tenant_id` column. The tenant is reached through `organization_id`, and two triggers
 * refuse a row whose organization is not its desk's organization, the same guard the board uses on
 * `tenant_id`. Every table here hangs off `workspaces` with `ON DELETE cascade`, so a purged desk or
 * company takes its projects with it.
 */
import type Database from "better-sqlite3";

export const PROJECT_TABLES = ["projects"] as const;

/** Refuses a project whose organization is not the organization of its desk. Insert and update. */
function organizationGuards(table: string): string {
  const mismatch = `NEW.organization_id IS NOT (SELECT w.organization_id FROM workspaces w WHERE w.id = NEW.workspace_id)`;
  return `
    CREATE TRIGGER IF NOT EXISTS ${table}_org_insert_guard BEFORE INSERT ON ${table}
      WHEN ${mismatch} BEGIN SELECT RAISE(ABORT, 'project_organization_mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_org_update_guard BEFORE UPDATE OF organization_id, workspace_id ON ${table}
      WHEN ${mismatch} BEGIN SELECT RAISE(ABORT, 'project_organization_mismatch'); END;`;
}

export function ensureProjectTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id text PRIMARY KEY NOT NULL,
      organization_id text NOT NULL REFERENCES organizations(id) ON DELETE cascade,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE cascade,
      name text NOT NULL,
      visibility text NOT NULL DEFAULT 'private',
      created_by text NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      archived_at integer,
      CONSTRAINT projects_visibility_check CHECK (visibility IN ('private', 'workspace'))
    );
    CREATE INDEX IF NOT EXISTS projects_ws_archived_idx ON projects (workspace_id, archived_at);
  `);
  sqlite.exec(PROJECT_TABLES.map(organizationGuards).join("\n"));
}
