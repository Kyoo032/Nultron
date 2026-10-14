/**
 * The collective projects tables (team-board-spec.md section 2b; on screen a project is a Workspace).
 *
 * A Workspace is shared with its members only, never the whole company (K-D22). `project_members` holds
 * them with a role (K-D23): exactly one `owner`, any number of `admin` and `member`. A file in a Workspace is
 * readable by its members (`sharedArtifactSql` in `packages/host/src/artifacts.ts`). `projects.visibility`
 * is the retired K-D19 switch: kept in the table, read by nothing that grants access.
 * `project_agents` holds the agents each member brought in, by product-mode id.
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

export const PROJECT_TABLES = ["projects", "project_members", "project_agents"] as const;

/** Refuses a project whose organization is not the organization of its desk. Insert and update. */
function organizationGuards(table: string): string {
  const mismatch = `NEW.organization_id IS NOT (SELECT w.organization_id FROM workspaces w WHERE w.id = NEW.workspace_id)`;
  return `
    CREATE TRIGGER IF NOT EXISTS ${table}_org_insert_guard BEFORE INSERT ON ${table}
      WHEN ${mismatch} BEGIN SELECT RAISE(ABORT, 'project_organization_mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_org_update_guard BEFORE UPDATE OF organization_id, workspace_id ON ${table}
      WHEN ${mismatch} BEGIN SELECT RAISE(ABORT, 'project_organization_mismatch'); END;`;
}

/**
 * The instructions a Workspace gives its chats (W1, team-board-spec.md section 2b). Added on open when a
 * table from before W1 lacks it: `CREATE TABLE IF NOT EXISTS` never alters an existing table, and an
 * ALTER in the journal cannot be replayed (see `ensure-schema.ts`, `ensureOwnershipColumns`).
 */
function ensureInstructionsColumn(sqlite: Database.Database): void {
  const columns = (sqlite.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
  if (columns.length > 0 && !columns.includes("instructions")) {
    sqlite.exec("ALTER TABLE projects ADD instructions text");
  }
}

/**
 * Every project with no member row gets its maker as `owner`. Only those: a project always keeps its owner
 * (nobody can remove one), so a project that has rows already had its owner set, and a maker who handed
 * ownership on and was then removed is never written back. A project shared company-wide under K-D19 gets
 * no extra members: the safe direction, its maker invites them.
 */
function backfillOwners(sqlite: Database.Database): void {
  sqlite.exec(`
    INSERT INTO project_members (project_id, user_id, role, added_by, added_at)
      SELECT p.id, p.created_by, 'owner', p.created_by, p.created_at FROM projects p
       WHERE NOT EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id);
  `);
}

export function ensureProjectTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id text PRIMARY KEY NOT NULL,
      organization_id text NOT NULL REFERENCES organizations(id) ON DELETE cascade,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE cascade,
      name text NOT NULL,
      visibility text NOT NULL DEFAULT 'private',
      instructions text,
      created_by text NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      archived_at integer,
      CONSTRAINT projects_visibility_check CHECK (visibility IN ('private', 'workspace'))
    );
    CREATE INDEX IF NOT EXISTS projects_ws_archived_idx ON projects (workspace_id, archived_at);
  `);
  ensureInstructionsColumn(sqlite);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS project_members (
      project_id text NOT NULL REFERENCES projects(id) ON DELETE cascade,
      user_id text NOT NULL,
      role text NOT NULL,
      added_by text NOT NULL,
      added_at integer NOT NULL,
      PRIMARY KEY (project_id, user_id),
      CONSTRAINT project_members_role_check CHECK (role IN ('owner', 'admin', 'member'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS project_members_one_owner ON project_members (project_id) WHERE role = 'owner';
    CREATE INDEX IF NOT EXISTS project_members_user_idx ON project_members (user_id, project_id);
    CREATE TABLE IF NOT EXISTS project_agents (
      project_id text NOT NULL REFERENCES projects(id) ON DELETE cascade,
      agent_id text NOT NULL,
      brought_by text NOT NULL,
      added_at integer NOT NULL,
      PRIMARY KEY (project_id, agent_id, brought_by)
    );
  `);
  backfillOwners(sqlite);
  // The two new tables hang off `projects`, so the organization guard on `projects` covers them.
  sqlite.exec(organizationGuards("projects"));
}
