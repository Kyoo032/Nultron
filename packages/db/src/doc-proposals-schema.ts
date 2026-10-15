import type Database from "better-sqlite3";

export const DOC_PROPOSAL_TABLES = ["doc_proposals"] as const;

export function ensureDocProposalTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS doc_proposals (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE cascade,
      section_id text NOT NULL,
      base_version integer NOT NULL,
      section text NOT NULL,
      agent_id text NOT NULL,
      asked_by_user_id text NOT NULL,
      status text NOT NULL,
      kept_version integer,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      CONSTRAINT doc_proposals_status_check CHECK (status IN ('pending', 'kept', 'discarded')),
      CONSTRAINT doc_proposals_base_check CHECK (base_version >= 1),
      CONSTRAINT doc_proposals_kept_check CHECK (
        (status = 'kept' AND kept_version IS NOT NULL) OR (status <> 'kept' AND kept_version IS NULL)
      )
    );
    CREATE UNIQUE INDEX IF NOT EXISTS doc_proposals_one_pending_section ON doc_proposals (artifact_id, section_id) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS doc_proposals_ws_artifact_idx ON doc_proposals (workspace_id, artifact_id);
  `);
}
