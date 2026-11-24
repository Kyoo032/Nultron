import { sql } from "@agentforge/db";
import type { TenantContext } from "@agentforge/core";
import type { KnowledgeBackendId, RetrievedChunk, RetrieveResult } from "./knowledge/backend";
import { knowledgeInjection, sourcesPart, type KnowledgeInjection } from "./knowledge";
import { openVectorBody } from "./knowledge-vector-seal";
import { andVisibleSource } from "./knowledge-visibility";
import { log } from "./log";

/**
 * What a Chat thread's last turn was handed from the knowledge base, read back from the record that
 * turn left (`knowledge_retrievals`), so the context chip can show its Sources row without asking the
 * gateway to embed anything.
 *
 * `GET /api/v1/knowledge/context?query=` retrieves, and retrieving embeds the query: a paid call on a
 * keyed desk. Chat used to make it every time a thread with messages came on screen. The send already
 * paid for its retrieval once and recorded the chunks it injected, so the chip reads that record: the
 * same chunks, the same order, no second query. A thread whose last completed run was handed nothing
 * has no rows for that run, which reads as an empty Sources row rather than as the run before it.
 */

const EMPTY_RETRIEVAL: RetrieveResult = { chunks: [], mode: "none", backend: "builtin", vectorModel: null };

const LAST_COMPLETED_RUN = `SELECT id FROM runs
  WHERE organization_id = ? AND thread_id = ? AND status = 'completed'
  ORDER BY started_at DESC, rowid DESC LIMIT 1`;

/**
 * Hosted, the join also leaves out a source this person may not see. A record this build writes never
 * names one (retrieval never hands it over), but one written by an earlier build can, and the popover
 * would otherwise replay a colleague's chunk to the person whose thread was handed it.
 */
function recordedChunksSql(visibleSource: string): string {
  return `SELECT r.source_id AS sourceId, r.chunk_index AS chunkIndex, r.score AS score,
    r.backend AS backend, s.name AS sourceName
  FROM knowledge_retrievals r
  JOIN knowledge_sources s ON s.id = r.source_id AND s.workspace_id = r.workspace_id
  WHERE r.workspace_id = ? AND r.thread_id = ? AND r.run_id = ?${visibleSource}
  ORDER BY r.rowid`;
}

type RecordedChunk = {
  sourceId: string;
  chunkIndex: number;
  score: number;
  backend: string;
  sourceName: string;
};

/** The text of the chunks a run was handed. Every indexed source has vector rows, local stubs included. */
function chunkBodies(workspaceId: string, sourceIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (sourceIds.length === 0) {
    return out;
  }
  const rows = sql
    .prepare(
      `SELECT source_id, chunk_index, body FROM knowledge_vectors
       WHERE workspace_id = ? AND source_id IN (${sourceIds.map(() => "?").join(", ")})`,
    )
    .all(workspaceId, ...sourceIds) as Array<{ source_id: string; chunk_index: number; body: string }>;
  for (const row of rows) {
    const key = `${row.source_id}#${row.chunk_index}`;
    if (!out.has(key)) {
      out.set(key, openVectorBody(row.body));
    }
  }
  return out;
}

/**
 * The chunks the thread's last completed run was handed, as a retrieval result. Never retrieves, never
 * throws: a record that cannot be read is an empty Sources row, not a failed chip. `mode` is `none`
 * because the record keeps the engine and not which half of it answered, so the line says how many
 * chunks and not how they were found.
 */
export function lastTurnRetrieval(tenant: TenantContext, threadId: string): RetrieveResult {
  try {
    const run = sql.prepare(LAST_COMPLETED_RUN).get(tenant.organizationId, threadId) as { id: string } | undefined;
    if (!run) {
      return EMPTY_RETRIEVAL;
    }
    const visible = andVisibleSource(tenant, "s");
    const recorded = sql
      .prepare(recordedChunksSql(visible.sql))
      .all(tenant.workspaceId, threadId, run.id, ...visible.params) as RecordedChunk[];
    if (recorded.length === 0) {
      return EMPTY_RETRIEVAL;
    }
    const bodies = chunkBodies(tenant.workspaceId, [...new Set(recorded.map((chunk) => chunk.sourceId))]);
    const chunks: RetrievedChunk[] = recorded.map((chunk) => ({
      body: bodies.get(`${chunk.sourceId}#${chunk.chunkIndex}`) ?? "",
      sourceId: chunk.sourceId,
      sourceName: chunk.sourceName,
      score: chunk.score,
      chunkIndex: chunk.chunkIndex,
    }));
    return { chunks, mode: "none", backend: recorded[0]?.backend as KnowledgeBackendId, vectorModel: null };
  } catch (error) {
    log.warn("knowledge_last_turn_unreadable", {
      detail: error instanceof Error ? error.message.slice(0, 120) : "error",
    });
    return EMPTY_RETRIEVAL;
  }
}

/**
 * The context popover's answer for a thread, with no query: the Soul and the pinned Memories as they
 * are now, and the Sources the thread's last turn was handed. No retrieval runs, so nothing is embedded
 * and nothing is billed. The prompt is what a turn with nothing to search for is handed.
 */
export async function knowledgeContextForThread(
  tenant: TenantContext,
  threadId: string | null,
): Promise<Pick<KnowledgeInjection, "prompt" | "parts">> {
  const base = await knowledgeInjection(tenant);
  const sourcesLabel = sourcesPart(EMPTY_RETRIEVAL).label;
  const recorded = threadId ? lastTurnRetrieval(tenant, threadId) : EMPTY_RETRIEVAL;
  return {
    prompt: base.prompt,
    parts: base.parts.map((part) => (part.label === sourcesLabel ? sourcesPart(recorded) : part)),
  };
}
