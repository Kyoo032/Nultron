/**
 * F5a — desk API keys (migration `0029_agent_api_keys.sql`).
 *
 * A key is `nk_live_<48 hex>`: the raw value is shown to its creator exactly once
 * (`createApiKey` returns it; nothing else ever does). At rest the desk keeps only
 * `sha256(raw)` as a 32-byte BLOB, the display prefix (`nk_live_<8>`) and `last4`, the
 * same hash-only convention as the portal's `api_keys` table
 * (`docs/internal/portal/migrations/0002_core_tables.sql`) — but stored in the desk's own
 * SQLite so it works per desk on Lighthouse.
 *
 * Verification looks the row up by `key_prefix`, then compares the stored hash to the
 * candidate's hash with `timingSafeEqual`. Lookup-by-hash would work as well, but the
 * prefix is what the list screen shows, so a prefix that does not exist is a 401 and a
 * prefix that does is one constant-time compare — never an early-out that leaks which
 * part of a key was right.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "@agentforge/db";
import { ApiError } from "@agentforge/core";

export const API_KEY_PREFIX = "nk_live_";
const KEY_RANDOM_BYTES = 24;
export const API_KEY_NAME_MAX = 80;

export type ApiKeyRow = {
  id: string;
  tenant_id: string;
  /** The desk the key was minted on; NULL reads as the tenant's home desk. */
  workspace_id: string | null;
  name: string;
  key_prefix: string;
  key_hash: Buffer;
  last4: string;
  allowed_agents: string;
  rate_limit_rpm: number | null;
  status: "active" | "revoked";
  expires_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
  created_by: string | null;
  created_at: number;
};

/** The public shape the session routes and the OpenAPI doc describe. Never the hash. */
export type ApiKeySummary = {
  id: string;
  name: string;
  prefix: string;
  last4: string;
  allowedAgents: string[];
  rateLimitRpm: number | null;
  status: "active" | "revoked";
  expiresAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
};

export function keyHash(raw: string): Buffer {
  return createHash("sha256").update(raw, "utf8").digest();
}

function mintRaw(): { raw: string; prefix: string; last4: string } {
  const random = randomBytes(KEY_RANDOM_BYTES).toString("hex");
  return {
    raw: `${API_KEY_PREFIX}${random}`,
    prefix: `${API_KEY_PREFIX}${random.slice(0, 8)}`,
    last4: random.slice(-4),
  };
}

/** `allowed_agents` is a JSON array; `["*"]` means every agent on the desk. */
export function parseAllowedAgents(stored: string): string[] {
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function allowsAgent(row: ApiKeyRow, agentId: string): boolean {
  const allowed = parseAllowedAgents(row.allowed_agents);
  return allowed.includes("*") || allowed.includes(agentId);
}

function summary(row: ApiKeyRow): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    prefix: row.key_prefix,
    last4: row.last4,
    allowedAgents: parseAllowedAgents(row.allowed_agents),
    rateLimitRpm: row.rate_limit_rpm,
    status: row.status,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

export type CreateApiKeyInput = {
  tenantId: string;
  /** The desk the key acts on; defaults to the tenant's home desk at resolve time. */
  workspaceId?: string | null;
  name: string;
  /** `["*"]` or an explicit agent-id list. Anything else is refused by the session route. */
  allowedAgents: string[];
  rateLimitRpm?: number | null;
  expiresAt?: number | null;
  createdBy?: string | null;
  now?: number;
};

export function createApiKey(
  input: CreateApiKeyInput,
  sqlite: typeof sql = sql,
): { key: string; apiKey: ApiKeySummary } {
  const name = input.name.trim().slice(0, API_KEY_NAME_MAX).trim();
  if (!name) {
    throw new ApiError("invalid_request", "name is required", 400);
  }
  if (!Array.isArray(input.allowedAgents) || input.allowedAgents.length === 0) {
    throw new ApiError("invalid_request", "allowedAgents must name at least one agent, or '*'", 400);
  }
  if (input.rateLimitRpm !== undefined && input.rateLimitRpm !== null && !(input.rateLimitRpm > 0)) {
    throw new ApiError("invalid_request", "rateLimitRpm must be a positive integer", 400);
  }
  const minted = mintRaw();
  const now = input.now ?? Date.now();
  const row: ApiKeyRow = {
    id: crypto.randomUUID(),
    tenant_id: input.tenantId,
    workspace_id: input.workspaceId ?? null,
    name,
    key_prefix: minted.prefix,
    key_hash: keyHash(minted.raw),
    last4: minted.last4,
    allowed_agents: JSON.stringify(input.allowedAgents),
    rate_limit_rpm: input.rateLimitRpm ?? null,
    status: "active",
    expires_at: input.expiresAt ?? null,
    revoked_at: null,
    last_used_at: null,
    created_by: input.createdBy ?? null,
    created_at: now,
  };
  try {
    sqlite
      .prepare(
        `INSERT INTO agent_api_keys
         (id, tenant_id, workspace_id, name, key_prefix, key_hash, last4, allowed_agents, rate_limit_rpm,
          status, expires_at, revoked_at, last_used_at, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL, ?, ?)`,
      )
      .run(
        row.id,
        row.tenant_id,
        row.workspace_id,
        row.name,
        row.key_prefix,
        row.key_hash,
        row.last4,
        row.allowed_agents,
        row.rate_limit_rpm,
        row.expires_at,
        row.created_by,
        row.created_at,
      );
  } catch (error) {
    // A colliding prefix or hash is a UNIQUE violation; ask for a new draw rather than guess.
    if (error instanceof Error && /UNIQUE/i.test(error.message)) {
      return createApiKey(input, sqlite);
    }
    throw error;
  }
  return { key: minted.raw, apiKey: summary(row) };
}

function getRow(sqlite: typeof sql, prefix: string): ApiKeyRow | null {
  const row = sqlite.prepare("SELECT * FROM agent_api_keys WHERE key_prefix = ?").get(prefix) as ApiKeyRow | undefined;
  return row ?? null;
}

/**
 * Resolve `Authorization: Bearer <raw>` to its row, or throw the ApiError the caller's
 * refusal names (`invalid_api_key` 401 for absent/malformed/revoked/expired alike — a
 * caller learns only that the credential did not work).
 */
export function resolveApiKey(raw: string | null | undefined, now = Date.now(), sqlite: typeof sql = sql): ApiKeyRow {
  const value = raw?.trim() ?? "";
  if (!value.startsWith(API_KEY_PREFIX)) {
    throw new ApiError("invalid_api_key", "Invalid API key", 401);
  }
  const row = getRow(sqlite, value.slice(0, API_KEY_PREFIX.length + 8));
  const candidate = keyHash(value);
  if (!row || row.key_hash.length !== candidate.length || !timingSafeEqual(row.key_hash, candidate)) {
    throw new ApiError("invalid_api_key", "Invalid API key", 401);
  }
  if (row.status !== "active") {
    throw new ApiError("invalid_api_key", "Invalid API key", 401);
  }
  if (row.expires_at !== null && now >= row.expires_at) {
    throw new ApiError("invalid_api_key", "Invalid API key", 401);
  }
  return row;
}

/** Cheap, side-effect-free stamp; rate of calls to it is bounded by the key's own limiter. */
export function touchApiKey(id: string, now = Date.now(), sqlite: typeof sql = sql): void {
  sqlite.prepare("UPDATE agent_api_keys SET last_used_at = ? WHERE id = ?").run(now, id);
}

/**
 * `tenant_id` is the partner, not the company: two organisations under one partner share it.
 * Every administrative read/mutation therefore also requires the key's desk to belong to the
 * caller's organisation — otherwise an admin in one company could list, revoke or rotate the
 * neighbouring company's keys (and rotation would hand over the jobs/threads lineage).
 * A NULL `workspace_id` predates desk recording and stays tenant-scoped (local mode has one org).
 */
const ORG_SCOPE_SQL = `(workspace_id IS NULL OR workspace_id IN
  (SELECT id FROM workspaces WHERE organization_id = ?))`;

export function listApiKeys(tenantId: string, organizationId: string, sqlite: typeof sql = sql): ApiKeySummary[] {
  const rows = sqlite
    .prepare(`SELECT * FROM agent_api_keys WHERE tenant_id = ? AND ${ORG_SCOPE_SQL} ORDER BY created_at DESC`)
    .all(tenantId, organizationId) as ApiKeyRow[];
  return rows.map(summary);
}

export function revokeApiKey(
  tenantId: string,
  id: string,
  organizationId: string,
  now = Date.now(),
  sqlite: typeof sql = sql,
): void {
  const result = sqlite
    .prepare(
      `UPDATE agent_api_keys SET status = 'revoked', revoked_at = ?
        WHERE tenant_id = ? AND id = ? AND status = 'active' AND ${ORG_SCOPE_SQL}`,
    )
    .run(now, tenantId, id, organizationId);
  if (!result || result.changes === 0) {
    throw new ApiError("not_found", "API key not found", 404);
  }
}

/**
 * Mint the replacement and retire the old row in one transaction: a rotated key is never
 * a moment when neither works, and never a moment when both do.
 */
export function rotateApiKey(
  tenantId: string,
  id: string,
  input: { createdBy?: string | null; now?: number; organizationId: string },
  sqlite: typeof sql = sql,
): { key: string; apiKey: ApiKeySummary } {
  const row = sqlite
    .prepare(`SELECT * FROM agent_api_keys WHERE tenant_id = ? AND id = ? AND ${ORG_SCOPE_SQL}`)
    .get(tenantId, id, input.organizationId) as ApiKeyRow | undefined;
  if (row?.status !== "active") {
    throw new ApiError("not_found", "API key not found", 404);
  }
  const now = input.now ?? Date.now();
  const minted = mintRaw();
  const newId = crypto.randomUUID();
  const replacement: ApiKeyRow = {
    ...row,
    id: newId,
    key_prefix: minted.prefix,
    key_hash: keyHash(minted.raw),
    last4: minted.last4,
    status: "active",
    revoked_at: null,
    last_used_at: null,
    created_by: input.createdBy ?? row.created_by,
    created_at: now,
  };
  const tx = sqlite.transaction.bind(sqlite) as (fn: () => void) => () => void;
  const apply = () => {
    sqlite
      .prepare(
        `INSERT INTO agent_api_keys
         (id, tenant_id, workspace_id, name, key_prefix, key_hash, last4, allowed_agents, rate_limit_rpm,
          status, expires_at, revoked_at, last_used_at, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL, ?, ?)`,
      )
      .run(
        replacement.id,
        replacement.tenant_id,
        replacement.workspace_id,
        replacement.name,
        replacement.key_prefix,
        replacement.key_hash,
        replacement.last4,
        replacement.allowed_agents,
        replacement.rate_limit_rpm,
        replacement.expires_at,
        replacement.created_by,
        replacement.created_at,
      );
    sqlite.prepare("UPDATE agent_api_keys SET status = 'revoked', revoked_at = ? WHERE id = ?").run(now, row.id);
    // A rotated key continues the old one's lineage: its jobs and threads move to the
    // replacement id. Without this neither key could read history minted before rotation.
    sqlite.prepare("UPDATE api_jobs SET key_id = ? WHERE key_id = ?").run(newId, row.id);
    sqlite.prepare("UPDATE threads SET user_id = ? WHERE user_id = ?").run(`apikey-${newId}`, `apikey-${row.id}`);
  };
  if (tx) {
    tx(apply)();
  } else {
    apply();
  }
  return { key: minted.raw, apiKey: summary(replacement) };
}
