import type Database from "better-sqlite3";

export const MEDIA_APPROVAL_TABLES = ["media_proposals", "media_always_allow"] as const;

export function ensureMediaApprovalTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS media_proposals (
      id text PRIMARY KEY NOT NULL,
      organization_id text NOT NULL REFERENCES organizations(id) ON DELETE cascade,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE cascade,
      thread_id text NOT NULL REFERENCES threads(id) ON DELETE cascade,
      run_id text,
      user_id text NOT NULL,
      kind text NOT NULL,
      model text NOT NULL,
      sealed_request text NOT NULL,
      estimate_micros integer,
      estimate_currency text NOT NULL DEFAULT 'USD',
      status text NOT NULL,
      claimed_at integer,
      created_at integer NOT NULL,
      decided_at integer,
      CONSTRAINT media_proposals_kind_check CHECK (kind IN ('image', 'video')),
      CONSTRAINT media_proposals_status_check CHECK (status IN ('pending', 'generated', 'skipped', 'expired', 'failed'))
    );
    CREATE INDEX IF NOT EXISTS media_proposals_owner_idx ON media_proposals (organization_id, user_id, status);
    CREATE INDEX IF NOT EXISTS media_proposals_thread_idx ON media_proposals (thread_id);
    CREATE TABLE IF NOT EXISTS media_always_allow (
      organization_id text NOT NULL REFERENCES organizations(id) ON DELETE cascade,
      user_id text NOT NULL,
      kind text NOT NULL,
      allowed integer NOT NULL,
      updated_at integer NOT NULL,
      PRIMARY KEY (organization_id, user_id, kind),
      CONSTRAINT media_always_allow_kind_check CHECK (kind IN ('image', 'video'))
    );
  `);
}
