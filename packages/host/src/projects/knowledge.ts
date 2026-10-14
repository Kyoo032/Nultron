/**
 * A Workspace's knowledge (team-board-spec.md section 2b, W1; K-D20). A file put into a Workspace is also a
 * knowledge source of that Workspace, so a chat started in it can search it (`knowledge-visibility.ts`).
 *
 * - A chat file (an artifact the caller made) keeps its artifact row; its knowledge source is the artifact's
 *   origin (`origin_kind = 'artifact'`), so the card a job already wrote for that file is reused, not duplicated.
 * - An upload is a knowledge source with its bytes on disk (`addFileSource`), owned by its uploader.
 *   Uploads are not artifacts: an artifact body is capped at 4 MB and limited to a few MIME types, and a Workspace
 *   upload accepts the 25 MB the Knowledge page accepts.
 *
 * Callers have already checked the Workspace is visible to the caller; these functions do not repeat the 404.
 */
import { sql } from "@agentforge/db";
import type { TenantContext } from "@agentforge/core";
import { isBinaryArtifactMime } from "@agentforge/core/artifacts";
import { artifactStore } from "../artifacts";
import { extractText } from "../knowledge-extract";
import {
  addFileSource,
  findSourceByOrigin,
  indexGuardedSource,
  markSourceFailed,
  type KnowledgeSource,
} from "../knowledge";
import { andVisibleSource } from "../knowledge-visibility";
import { log } from "../log";

const KNOWLEDGE_LIST_LIMIT = 200;

export type ProjectKnowledgeItem = {
  id: string;
  name: string;
  kind: string;
  status: KnowledgeSource["status"];
  chunks: number;
  addedBy: string | null;
  createdAt: number;
};

type KnowledgeRow = {
  id: string;
  name: string;
  type: string;
  status: KnowledgeSource["status"];
  chunks: number;
  owner_user_id: string | null;
  created_at: number;
};

/** The Workspace's sources the caller may see: every row is a member's, because the rule is membership. */
export function listProjectKnowledge(scope: TenantContext, projectId: string): ProjectKnowledgeItem[] {
  const visible = andVisibleSource(scope, undefined, { projectId });
  const rows = sql
    .prepare(
      `SELECT id, name, type, status, chunks, owner_user_id, created_at FROM knowledge_sources
        WHERE workspace_id = ? AND project_id = ?${visible.sql}
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(scope.workspaceId, projectId, ...visible.params, KNOWLEDGE_LIST_LIMIT) as KnowledgeRow[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.type,
    status: row.status,
    chunks: row.chunks,
    addedBy: row.owner_user_id,
    createdAt: row.created_at,
  }));
}

/** The text a chat file contributes: its body, or for a binary file the text read out of its base64 bytes. */
async function artifactText(title: string, mime: string, body: string): Promise<string> {
  if (!isBinaryArtifactMime(mime)) {
    return body;
  }
  return extractText(title, mime, Buffer.from(body, "base64"));
}

function failureCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return error instanceof Error && error.message ? error.message.slice(0, 120) : "internal_error";
}

/**
 * Make a chat file a knowledge source of the Workspace. A source the file already has (a card a job wrote)
 * is moved into the Workspace in place; otherwise the file is indexed now. Never throws for a file that
 * will not read: the source is recorded as `Failed` with the reason, as every other source is.
 */
export async function attachArtifactKnowledge(
  scope: TenantContext,
  artifactId: string,
  projectId: string,
  ownerUserId: string | null,
): Promise<void> {
  const existing = findSourceByOrigin(scope, { kind: "artifact", id: artifactId });
  if (existing) {
    sql
      .prepare("UPDATE knowledge_sources SET project_id = ? WHERE workspace_id = ? AND id = ?")
      .run(projectId, scope.workspaceId, existing.id);
    return;
  }
  const artifact = artifactStore().get(scope, artifactId);
  if (!artifact) {
    return;
  }
  const input = {
    id: crypto.randomUUID(),
    name: artifact.title,
    type: "File",
    origin: { kind: "artifact" as const, id: artifactId },
    ownerUserId,
    projectId,
  };
  try {
    const text = await artifactText(artifact.title, artifact.mime, artifact.body);
    await indexGuardedSource(scope, { ...input, text });
  } catch (error) {
    log.warn("project_artifact_index_failed", { code: failureCode(error) });
    markSourceFailed(scope, input, failureCode(error));
  }
}

/**
 * A chat file left the Workspace: its knowledge source stays (the file is still the maker's) but no longer
 * belongs to the Workspace, so it is found by its owner's rule again.
 */
export function detachArtifactKnowledge(scope: TenantContext, artifactId: string, projectId: string): void {
  sql
    .prepare(
      `UPDATE knowledge_sources SET project_id = NULL
        WHERE workspace_id = ? AND origin_kind = 'artifact' AND origin_id = ? AND project_id = ?`,
    )
    .run(scope.workspaceId, artifactId, projectId);
}

/**
 * An upload into the Workspace: indexed as a source owned by the uploader, with the Workspace's id. Text is
 * read here with the same extractor and limits the Knowledge page uses (25 MB, magic bytes must agree).
 */
export async function uploadProjectFile(
  scope: TenantContext,
  projectId: string,
  file: { filename: string; mime: string; bytes: Uint8Array },
  ownerUserId: string | null,
): Promise<KnowledgeSource> {
  return addFileSource(scope, file, { ownerUserId, projectId });
}

/** The row an upload left in the Workspace, or null when the source is not one of its uploads. */
export function uploadedSourceOf(
  scope: TenantContext,
  projectId: string,
  sourceId: string,
): { ownerUserId: string | null } | null {
  const row = sql
    .prepare(
      `SELECT owner_user_id FROM knowledge_sources
        WHERE workspace_id = ? AND id = ? AND project_id = ? AND origin_kind IS NULL`,
    )
    .get(scope.workspaceId, sourceId, projectId) as { owner_user_id: string | null } | undefined;
  return row ? { ownerUserId: row.owner_user_id } : null;
}
