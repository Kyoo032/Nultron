import type Database from "better-sqlite3";
import type { ProtectedVersions } from "./types";

export function pendingBaseVersions(db: Database.Database): ProtectedVersions {
  return (artifactId) =>
    new Set(
      (
        db
          .prepare("SELECT base_version FROM doc_proposals WHERE artifact_id = ? AND status = 'pending'")
          .all(artifactId) as Array<{ base_version: number }>
      ).map((row) => row.base_version),
    );
}
