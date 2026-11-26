/**
 * F1: sealed persistence for `data_sources` (migration 0027).
 *
 * Config and credentials seal under `HKDF(wrapKey, "data-source-v1")` — a purpose key of its own
 * (the `auth-session-refresh-v1` pattern), so a leak of another purpose's key opens nothing here.
 * A response never contains a secret: `secret_sealed` stays in the DB, `secret_last4` is the most
 * a reader sees, and `table_allowlist` seals too — which tables an operator opened is itself
 * information a member's read does not need.
 */
import { hkdfSync } from "node:crypto";
import { randomUUID } from "node:crypto";
import { sql } from "@agentforge/db";
import { getLocalVaultKey } from "@agentforge/db/vault-key";
import { ApiError, openPayload, sealPayload } from "@agentforge/core";
import { z } from "zod";

const SEALING_INFO = "data-source-v1";

export function dataSourceSealingKey(): Buffer {
  return Buffer.from(hkdfSync("sha256", getLocalVaultKey(), Buffer.alloc(0), SEALING_INFO, 32));
}

export const SOURCE_KINDS = ["s3", "azure_blob", "postgres", "mysql"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

const hostPort = { host: z.string().min(1).max(253), port: z.number().int().min(1).max(65535) };

/** The non-secret half, per kind. Everything else a POST sends is rejected (`.strict()`). */
export const sourceConfigInput = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("s3"),
      endpoint: z.string().url().max(2048),
      region: z.string().min(1).max(64),
      bucket: z.string().min(1).max(255),
      prefix: z.string().max(1024).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("postgres"),
      database: z.string().min(1).max(255),
      user: z.string().min(1).max(255),
      ...hostPort,
    })
    .strict(),
  z
    .object({
      kind: z.literal("mysql"),
      database: z.string().min(1).max(255),
      user: z.string().min(1).max(255),
      ...hostPort,
    })
    .strict(),
  z.object({ kind: z.literal("azure_blob") }).strict(),
]);
export type SourceConfigInput = z.infer<typeof sourceConfigInput>;

/** The secret half per kind; `secret_last4` is derived from it at write time. */
export const secretInput = z
  .object({
    kind: z.enum(SOURCE_KINDS),
    // s3 needs both parts of the key pair; the SQL kinds take a password. One field keeps the
    // stored shape flat — s3 sends `accessKeyId:secretAccessKey` joined by the caller's input.
    secret: z.string().min(1).max(4096).optional(),
    s3AccessKeyId: z.string().min(1).max(512).optional(),
    s3SecretAccessKey: z.string().min(1).max(2048).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "s3" && (!value.s3AccessKeyId || !value.s3SecretAccessKey)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "s3 requires s3AccessKeyId and s3SecretAccessKey" });
    }
    if ((value.kind === "postgres" || value.kind === "mysql") && !value.secret) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a password is required" });
    }
  });
export type SourceSecretInput = z.infer<typeof secretInput>;

export function secretLast4(input: SourceSecretInput): string | null {
  const raw = input.kind === "s3" ? input.s3SecretAccessKey : input.secret;
  // A tail is only a hint when it shows strictly less than the whole secret — a secret of four
  // characters or fewer would otherwise be returned in full. "••••" says "stored, not shown".
  if (!raw) {
    return null;
  }
  return raw.length > 4 ? raw.slice(-4) : "••••";
}

export type DataSourceRow = {
  id: string;
  tenant_id: string;
  kind: SourceKind;
  name: string;
  config_sealed: string;
  secret_sealed: string;
  secret_last4: string | null;
  status: "active" | "disabled";
  table_allowlist_sealed: string | null;
  last_sync_at: number | null;
  last_sync_result: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
};

type Stored = Omit<DataSourceRow, "kind" | "status"> & { kind: string; status: string };

function decode(row: Stored): DataSourceRow {
  return { ...row, kind: row.kind as SourceKind, status: row.status as "active" | "disabled" };
}

export function getDataSource(tenantId: string, id: string): DataSourceRow {
  const row = sql.prepare("SELECT * FROM data_sources WHERE id = ? AND tenant_id = ?").get(id, tenantId) as
    | Stored
    | undefined;
  if (!row) {
    throw new ApiError("not_found", "Data source not found", 404);
  }
  return decode(row);
}

export function listDataSources(tenantId: string): DataSourceRow[] {
  const rows = sql
    .prepare("SELECT * FROM data_sources WHERE tenant_id = ? ORDER BY created_at")
    .all(tenantId) as Stored[];
  return rows.map(decode);
}

/** Sealed halves of a row; never log or return what `open*` gives back outside the connector. */
export function openSourceConfig<T>(row: DataSourceRow): T {
  return openPayload<T>(JSON.parse(row.config_sealed), dataSourceSealingKey());
}
export function openSourceSecret<T>(row: DataSourceRow): T {
  return openPayload<T>(JSON.parse(row.secret_sealed), dataSourceSealingKey());
}
export function openTableAllowlist(row: DataSourceRow): string[] {
  if (!row.table_allowlist_sealed) {
    return [];
  }
  return openPayload<string[]>(JSON.parse(row.table_allowlist_sealed), dataSourceSealingKey());
}

export function insertDataSource(input: {
  tenantId: string;
  kind: SourceKind;
  name: string;
  config: unknown;
  secret: unknown;
  secretLast4: string | null;
  tableAllowlist: string[] | null;
  createdBy: string | null;
}): DataSourceRow {
  const key = dataSourceSealingKey();
  const id = `ds-${randomUUID()}`;
  const now = Date.now();
  sql
    .prepare(
      `INSERT INTO data_sources
     (id, tenant_id, kind, name, config_sealed, secret_sealed, secret_last4, status,
      table_allowlist_sealed, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.tenantId,
      input.kind,
      input.name,
      JSON.stringify(sealPayload(input.config, key)),
      JSON.stringify(sealPayload(input.secret, key)),
      input.secretLast4,
      input.tableAllowlist ? JSON.stringify(sealPayload(input.tableAllowlist, key)) : null,
      input.createdBy,
      now,
      now,
    );
  return getDataSource(input.tenantId, id);
}

export function markSourceStatus(tenantId: string, id: string, status: "active" | "disabled"): void {
  sql
    .prepare("UPDATE data_sources SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?")
    .run(status, Date.now(), id, tenantId);
}

export function recordSourceSync(tenantId: string, id: string, result: "ok" | "failed"): void {
  sql
    .prepare(
      "UPDATE data_sources SET last_sync_at = ?, last_sync_result = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
    )
    .run(Date.now(), result, Date.now(), id, tenantId);
}

export function insertSyncRun(input: { tenantId: string; dataSourceId: string; startedAt: number }): string {
  const id = `dsrun-${randomUUID()}`;
  sql
    .prepare("INSERT INTO data_source_sync_runs (id, tenant_id, data_source_id, started_at) VALUES (?, ?, ?, ?)")
    .run(id, input.tenantId, input.dataSourceId, input.startedAt);
  return id;
}

export function finishSyncRun(id: string, filesOk: number, filesFailed: number, errorCode: string | null): void {
  sql
    .prepare(
      "UPDATE data_source_sync_runs SET finished_at = ?, files_ok = ?, files_failed = ?, error_code = ? WHERE id = ?",
    )
    .run(Date.now(), filesOk, filesFailed, errorCode, id);
}

export function deleteSourceCredentials(tenantId: string, id: string): void {
  const row = getDataSource(tenantId, id);
  const key = dataSourceSealingKey();
  sql
    .prepare(
      "UPDATE data_sources SET secret_sealed = ?, secret_last4 = NULL, status = 'disabled', updated_at = ? WHERE id = ?",
    )
    .run(JSON.stringify(sealPayload({ removed: true }, key)), Date.now(), row.id);
}

/** What the API returns — the fields a member may see. `secret_sealed` never leaves. */
export function publicSource(row: DataSourceRow) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    hasCredentials: row.secret_last4 !== null,
    secretLast4: row.secret_last4,
    lastSyncAt: row.last_sync_at,
    lastSyncResult: row.last_sync_result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
