import type Database from "better-sqlite3";

export const DOC_VERSION_TABLES = ["doc_versions"] as const;

export function ensureDocVersionTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS doc_versions (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE cascade,
      version integer NOT NULL,
      spec text NOT NULL,
      kind text NOT NULL,
      changed_section_ids text NOT NULL,
      base_version integer,
      note text,
      author_kind text NOT NULL,
      author_user_id text,
      agent_id text,
      asked_by_user_id text NOT NULL,
      folded_authors text,
      created_at integer NOT NULL,
      CONSTRAINT doc_versions_kind_check CHECK (kind IN ('document', 'workbook')),
      CONSTRAINT doc_versions_author_check CHECK (
        (author_kind = 'person' AND author_user_id IS NOT NULL AND agent_id IS NULL)
        OR (author_kind = 'agent' AND agent_id IS NOT NULL)
      ),
      CONSTRAINT doc_versions_version_check CHECK (version >= 1)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS doc_versions_artifact_version ON doc_versions (artifact_id, version);
    CREATE INDEX IF NOT EXISTS doc_versions_ws_artifact_idx ON doc_versions (workspace_id, artifact_id);
  `);
}
