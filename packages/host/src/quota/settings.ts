import { sql } from "@agentforge/db";
import { appendAudit } from "./audit";
import { assertMicros, QuotaStoreError, requireScope, runImmediate, type QuotaScope } from "./common";
import { chargeOpenHoldsOf } from "./hold-ledger";

export type QuotaSettings = {
  enabled: boolean;
  enabledAt: number | null;
  enabledBy: string | null;
  companyCapMicros: number | null;
  version: number;
};

type SettingsRow = {
  enabled: number;
  enabled_at: number | null;
  enabled_by: string | null;
  company_cap_micros: number | null;
  version: number;
};

const DISABLED: QuotaSettings = {
  enabled: false,
  enabledAt: null,
  enabledBy: null,
  companyCapMicros: null,
  version: 0,
};

function readSettings(scope: QuotaScope): QuotaSettings {
  const row = sql
    .prepare(
      `SELECT enabled, enabled_at, enabled_by, company_cap_micros, version FROM company_quota_settings
        WHERE organization_id = ? AND tenant_id = ?`,
    )
    .get(scope.organizationId, scope.tenantId) as SettingsRow | undefined;
  if (!row) {
    return DISABLED;
  }
  return {
    enabled: row.enabled === 1,
    enabledAt: row.enabled_at,
    enabledBy: row.enabled_by,
    companyCapMicros: row.company_cap_micros,
    version: row.version,
  };
}

export function getQuotaSettings(scope: QuotaScope): QuotaSettings {
  requireScope(scope);
  return readSettings(scope);
}

export function isQuotaEnabled(scope: QuotaScope): boolean {
  return getQuotaSettings(scope).enabled;
}

function hasLiveDefault(scope: QuotaScope): boolean {
  const row = sql
    .prepare(
      `SELECT 1 AS ok FROM quota_allocations
        WHERE organization_id = ? AND tenant_id = ? AND status = 'active' AND limit_micros > 0
          AND scope_kind IN ('everyone', 'admins') LIMIT 1`,
    )
    .get(scope.organizationId, scope.tenantId);
  return row !== undefined;
}

export function setQuotaEnabled(
  scope: QuotaScope,
  actorUserId: string,
  enabled: boolean,
  now = Date.now(),
): QuotaSettings {
  return runImmediate(() => {
    requireScope(scope);
    const before = readSettings(scope);
    if (before.enabled === enabled) {
      return before;
    }
    if (enabled && !hasLiveDefault(scope)) {
      throw new QuotaStoreError("quota_needs_default");
    }
    sql
      .prepare(
        `INSERT INTO company_quota_settings (organization_id, tenant_id, enabled, enabled_at, enabled_by, version)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT (organization_id) DO UPDATE SET enabled = excluded.enabled, enabled_at = excluded.enabled_at,
           enabled_by = excluded.enabled_by, version = company_quota_settings.version + 1
         WHERE company_quota_settings.tenant_id = excluded.tenant_id`,
      )
      .run(scope.organizationId, scope.tenantId, enabled ? 1 : 0, now, actorUserId);
    let charged = 0;
    if (!enabled) {
      charged = chargeOpenHoldsOf(scope, now);
    }
    appendAudit(
      scope,
      actorUserId,
      enabled ? "quota.enable" : "quota.disable",
      null,
      {
        version: before.version + 1,
        chargedOpenHoldMicros: charged,
      },
      now,
    );
    return readSettings(scope);
  });
}

export function setCompanyCap(
  scope: QuotaScope,
  actorUserId: string,
  capMicros: number | null,
  now = Date.now(),
): QuotaSettings {
  const cap = capMicros === null ? null : assertMicros(capMicros, "companyCapMicros");
  return runImmediate(() => {
    requireScope(scope);
    const before = readSettings(scope);
    if (cap !== null) {
      const row = sql
        .prepare(
          `SELECT COALESCE(SUM(limit_micros), 0) AS total FROM quota_allocations
            WHERE organization_id = ? AND tenant_id = ? AND status <> 'archived'`,
        )
        .get(scope.organizationId, scope.tenantId) as { total: number };
      if (row.total > cap) {
        throw new QuotaStoreError("exceeds_company_cap", "live allocations already total more than the cap");
      }
    }
    sql
      .prepare(
        `INSERT INTO company_quota_settings (organization_id, tenant_id, enabled, company_cap_micros, version)
         VALUES (?, ?, 0, ?, 1)
         ON CONFLICT (organization_id) DO UPDATE SET company_cap_micros = excluded.company_cap_micros,
           version = company_quota_settings.version + 1
         WHERE company_quota_settings.tenant_id = excluded.tenant_id`,
      )
      .run(scope.organizationId, scope.tenantId, cap);
    appendAudit(
      scope,
      actorUserId,
      "quota.cap",
      null,
      { beforeMicros: before.companyCapMicros, afterMicros: cap },
      now,
    );
    return readSettings(scope);
  });
}
