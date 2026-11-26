/**
 * F1: sync an S3 source's objects into the knowledge base, one file at a time.
 *
 * Each object flows list → `getS3Object` (already capped at `AGENTFORGE_DATA_SYNC_MAX_BYTES`,
 * floor 25 MB) → `extractText` (the upload reader) → `indexKnowledgeSource` with origin `data_source`, so a removed
 * connector's cards die in the same orphan sweep as a removed thread's. Only counts and an error
 * code land in `data_source_sync_runs` — never a filename, never content (migration 0027's note).
 */
import { ApiError, maskPii, reportAuditEvent, type TenantContext } from "@agentforge/core";
import { indexKnowledgeSource, injectionRule } from "../knowledge";
import { extractText } from "../knowledge-extract";
import type { DataSourceRow } from "./store";
import { getS3Object, listS3Objects } from "./s3";
import { finishSyncRun, insertSyncRun, recordSourceSync } from "./store";
import { FILE_EXTRACT_MAX_BYTES } from "../file-extract/limits";

export type SyncResult = { runId: string; filesOk: number; filesFailed: number };

function extOf(key: string): string {
  const dot = key.lastIndexOf(".");
  return dot >= 0 ? key.slice(dot + 1).toLowerCase() : "";
}

/**
 * One manual sync, object-by-object: the 25 MB cap per file and the one-at-a-time loop are what
 * keep RSS inside the desk's headroom — no listing of thousands, no parallel reads. Parsing the
 * stream through the isolated F7a parser is a follow-up once it lands (section F1's own order).
 */
export async function syncDataSource(
  tenant: TenantContext,
  row: DataSourceRow,
  actor: { actorKind: "user" | "system"; actorId?: string | null },
): Promise<SyncResult> {
  if (row.kind !== "s3") {
    throw new ApiError("invalid_request", "Only s3 sources sync in W1", 400);
  }
  if (row.status !== "active") {
    throw new ApiError("invalid_request", "Data source is disabled", 400);
  }
  const runId = insertSyncRun({ tenantId: tenant.tenantId, dataSourceId: row.id, startedAt: Date.now() });
  let ok = 0;
  let failed = 0;
  let errorCode: string | null = null;
  try {
    const objects = await listS3Objects(row);
    for (const object of objects) {
      try {
        if (object.size > FILE_EXTRACT_MAX_BYTES) {
          failed += 1;
          errorCode = errorCode ?? "file_too_large";
          continue;
        }
        const buffer = await getS3Object(row, object.key);
        // The same reader a manual upload goes through (`extractText`, not the narrower document-only
        // `extractFile`): a bucket mostly holds plain text, markdown and JSON, which only it reads.
        const text = await extractText(object.key.split("/").pop() ?? object.key, "", buffer);
        // The same gates a manual upload passes: injection scan first, PII masked into the index.
        const rule = injectionRule(tenant, object.key, text);
        if (rule) {
          failed += 1;
          errorCode = errorCode ?? "injection_blocked";
          continue;
        }
        const indexed = await indexKnowledgeSource(tenant, {
          id: `data-source/${row.id}/${object.key}`,
          name: object.key,
          type: extOf(object.key) || "file",
          text: maskPii(text),
          // One origin per object: the unique origin index folds same-origin writes, so a
          // shared `row.id` origin would keep only the last synced file searchable.
          origin: { kind: "data_source", id: `${row.id}/${object.key}` },
        });
        // An empty file indexes nothing but returns a failed source rather than throwing —
        // count it the same as a refused read, else the run reports it as synced.
        if (indexed.status !== "Indexed") {
          failed += 1;
          errorCode = errorCode ?? "file_empty";
          continue;
        }
        ok += 1;
      } catch {
        failed += 1;
        errorCode = errorCode ?? "file_extract_failed";
      }
    }
  } catch (error) {
    errorCode = errorCode ?? (error instanceof ApiError ? error.code : "sync_failed");
  }
  finishSyncRun(runId, ok, failed, errorCode);
  const outcome = failed === 0 && !errorCode ? "ok" : "failed";
  recordSourceSync(tenant.tenantId, row.id, outcome === "ok" ? "ok" : "failed");
  // Counts only — the row already holds nothing but numbers.
  reportAuditEvent({
    tenantId: tenant.tenantId,
    event: "data_source.access",
    actorKind: actor.actorKind,
    actorId: actor.actorId ?? null,
    targetKind: "data_source",
    targetId: row.id,
    outcome,
    itemCount: ok,
    rule: errorCode,
  });
  return { runId, filesOk: ok, filesFailed: failed };
}
