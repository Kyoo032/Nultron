import { ApiError, reportAuditEvent } from "@agentforge/core";
import { sql } from "@agentforge/db";
import type { HostRequest, HostResult } from "../types";
import { jsonError, jsonOk } from "../errors";
import { getTenant } from "../tenant";
import { listAuditEvents } from "../audit/store";
import { verifyAuditChain } from "../audit/verify";
import { exportAuditEvents } from "../audit/export";

/**
 * The Activity Log endpoints (F2). Role is enforced in the router's gate (`audit` = `canAudit`,
 * owner or auditor — an admin does not audit, matching the seat design). Every read and export is
 * itself an audit event, because who looked at the log is part of the log (R2.2).
 */

const MAX_PAGE = 500;

function readInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ApiError("invalid_request", `${name} must be a number`, 400);
  }
  return parsed;
}

function auditActor(request: HostRequest, tenantId: string) {
  return {
    tenantId,
    actorKind: "user" as const,
    actorId: request.session?.userId ?? null,
  };
}

export async function handleGetAuditEvents(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    const filter = {
      tenantId: tenant.tenantId,
      from: readInt(request.query.from, "from"),
      to: readInt(request.query.to, "to"),
      actor: request.query.actor,
      agent: request.query.agent,
      event: request.query.event,
      outcome: request.query.outcome,
      cursor: readInt(request.query.cursor, "cursor"),
      limit: Math.min(readInt(request.query.limit, "limit") ?? 50, MAX_PAGE),
    };
    const rows = listAuditEvents(sql, filter);
    reportAuditEvent({
      ...auditActor(request, tenant.tenantId),
      event: "audit.read",
      targetKind: "audit_events",
      outcome: "ok",
      itemCount: rows.length,
    });
    return jsonOk({
      events: rows,
      nextCursor: rows.length === filter.limit ? (rows[rows.length - 1]?.seq ?? null) : null,
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function handlePostAuditVerify(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    const result = verifyAuditChain(sql, tenant.tenantId);
    reportAuditEvent({
      ...auditActor(request, tenant.tenantId),
      event: "audit.read",
      targetKind: "audit_chain",
      outcome: result.ok ? "ok" : "failed",
    });
    return jsonOk(result);
  } catch (error) {
    return jsonError(error);
  }
}

export async function handleGetAuditExport(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    const format = request.query.format === "jsonl" ? "jsonl" : request.query.format === "csv" ? "csv" : null;
    if (!format) {
      throw new ApiError("invalid_request", "format must be csv or jsonl", 400);
    }
    const exported = exportAuditEvents(
      sql,
      {
        tenantId: tenant.tenantId,
        from: readInt(request.query.from, "from"),
        to: readInt(request.query.to, "to"),
        actor: request.query.actor,
        agent: request.query.agent,
        event: request.query.event,
        outcome: request.query.outcome,
      },
      format,
    );
    reportAuditEvent({
      ...auditActor(request, tenant.tenantId),
      event: "audit.export",
      targetKind: "audit_events",
      outcome: "ok",
      itemCount: exported.manifest.rows,
      refHash: exported.manifest.fileSha256,
    });
    return {
      type: "bytes",
      status: 200,
      bytes: new TextEncoder().encode(exported.content),
      contentType: format === "csv" ? "text/csv" : "application/x-ndjson",
      filename: `audit-export.${format}`,
      // The manifest rides on the file it proves: SHA-256 of exactly these bytes (AC-2.5).
      headers: { "x-audit-manifest-sha256": exported.manifest.fileSha256 },
    };
  } catch (error) {
    return jsonError(error);
  }
}
