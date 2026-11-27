/**
 * F5a — `api_jobs` (`0029_agent_api_keys.sql`): an async run started by a service key,
 * whose `result_sealed` is the run's answer sealed with the desk vault key (AES-256-GCM,
 * same envelope as settings/messages — spec S1). Only the key's tenant ever sees the
 * unsealed result, and only while the row lives.
 *
 * The run executes in this process (single-process SQLite architecture); the row is the
 * queue. `awaiting_approval` exists in the status enum for F3; a key-started run never
 * transitions to it today because a service identity cannot approve actions.
 */
import { ApiError, openPayload, sealPayload } from "@agentforge/core";
import { getLocalVaultKey } from "@agentforge/db/vault-key";
import { sql } from "@agentforge/db";

export const API_JOB_STATUSES = ["queued", "running", "awaiting_approval", "done", "failed"] as const;
export type ApiJobStatus = (typeof API_JOB_STATUSES)[number];

export type ApiJobRow = {
  id: string;
  tenant_id: string;
  key_id: string;
  agent_id: string;
  status: ApiJobStatus;
  result_sealed: string | null;
  created_at: number;
  updated_at: number;
};

export type ApiJobSummary = {
  id: string;
  agentId: string;
  status: ApiJobStatus;
  createdAt: number;
  updatedAt: number;
  result?: { text: string };
};

export function createApiJob(tenantId: string, keyId: string, agentId: string): ApiJobRow {
  const now = Date.now();
  const row: ApiJobRow = {
    id: crypto.randomUUID(),
    tenant_id: tenantId,
    key_id: keyId,
    agent_id: agentId,
    status: "queued",
    result_sealed: null,
    created_at: now,
    updated_at: now,
  };
  sql
    .prepare(
      `INSERT INTO api_jobs (id, tenant_id, key_id, agent_id, status, result_sealed, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', NULL, ?, ?)`,
    )
    .run(row.id, row.tenant_id, row.key_id, row.agent_id, row.created_at, row.updated_at);
  return row;
}

export function setApiJobStatus(id: string, status: ApiJobStatus, sqlite: typeof sql = sql): void {
  sqlite.prepare("UPDATE api_jobs SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), id);
}

export function sealApiJobResult(id: string, text: string, sqlite: typeof sql = sql): void {
  sqlite
    .prepare("UPDATE api_jobs SET status = 'done', result_sealed = ?, updated_at = ? WHERE id = ?")
    .run(sealPayload({ text }, getLocalVaultKey()), Date.now(), id);
}

export function failApiJob(id: string, message: string, sqlite: typeof sql = sql): void {
  sqlite
    .prepare("UPDATE api_jobs SET status = 'failed', result_sealed = ?, updated_at = ? WHERE id = ?")
    .run(sealPayload({ error: message }, getLocalVaultKey()), Date.now(), id);
}

/** Scoped to the tenant AND the key that created it: another key of the same desk cannot read it. */
export function getApiJob(tenantId: string, keyId: string, jobId: string): ApiJobSummary {
  const row = sql
    .prepare("SELECT * FROM api_jobs WHERE id = ? AND tenant_id = ? AND key_id = ?")
    .get(jobId, tenantId, keyId) as ApiJobRow | undefined;
  if (!row) {
    throw new ApiError("not_found", "Job not found", 404);
  }
  const out: ApiJobSummary = {
    id: row.id,
    agentId: row.agent_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.status === "done" && row.result_sealed) {
    const payload = openPayload<{ text: string }>(row.result_sealed, getLocalVaultKey());
    out.result = { text: payload.text };
  } else if (row.status === "failed" && row.result_sealed) {
    const payload = openPayload<{ error: string }>(row.result_sealed, getLocalVaultKey());
    out.result = { text: payload.error };
  }
  return out;
}
