import { sql } from "@agentforge/db";

export type QuotaScope = { tenantId: string; organizationId: string };

export const MICROS_MAX = 1_000_000_000_000;

export const STORE_ERROR_CODES = [
  "not_found",
  "version_conflict",
  "invalid_input",
  "quota_needs_default",
  "exceeds_company_cap",
  "duplicate",
  "subject_invalid",
  "archived",
] as const;

export type QuotaStoreErrorCode = (typeof STORE_ERROR_CODES)[number];

export class QuotaStoreError extends Error {
  readonly code: QuotaStoreErrorCode;

  constructor(code: QuotaStoreErrorCode, message?: string) {
    super(message ?? code);
    this.name = "QuotaStoreError";
    this.code = code;
  }
}

export function requireScope(scope: QuotaScope): void {
  const row = sql
    .prepare("SELECT 1 AS ok FROM organizations WHERE id = ? AND tenant_id = ?")
    .get(scope.organizationId, scope.tenantId);
  if (!row) {
    throw new QuotaStoreError("not_found", "organization");
  }
}

export function assertMicros(value: unknown, name: string, min = 0): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > MICROS_MAX) {
    throw new QuotaStoreError("invalid_input", `${name} must be an integer between ${min} and ${MICROS_MAX}`);
  }
  return value;
}

export function runImmediate<T>(work: () => T): T {
  return sql.transaction(work).immediate();
}

export function isBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "SQLITE_BUSY" || code === "SQLITE_BUSY_SNAPSHOT" || code === "SQLITE_LOCKED";
}

export function monthStart(at: number): number {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

export function periodStartFor(periodKind: string, at: number): number {
  return periodKind === "monthly" ? monthStart(at) : 0;
}

export function chargeMicros(raw: number): number {
  if (!Number.isFinite(raw) || raw < 0) {
    throw new QuotaStoreError("invalid_input", "charge must be a non-negative number of micros");
  }
  return Math.min(MICROS_MAX, Math.max(1, Math.ceil(raw)));
}

export function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT") && /UNIQUE/.test(String(error));
}
