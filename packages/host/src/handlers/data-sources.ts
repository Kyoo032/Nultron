/**
 * F1: the data-source desk API. The role split rides `routeGate` (`ADMINISTER_ROUTES`):
 * GET is `read` — a member sees the list, never a secret — and every mutation is `administer`
 * (owner/admin only; member and auditor are refused before they reach here). Every handler
 * reports `data_source.add` / `data_source.change` / `data_source.access` — actor, agent, source,
 * outcome, counts; never content, never a credential.
 */
import { ApiError, reportAuditEvent } from "@agentforge/core";
import { z } from "zod";
import { jsonError, jsonOk } from "../errors";
import { getTenant } from "../tenant";
import type { HostRequest, HostResult } from "../types";
import {
  deleteSourceCredentials,
  getDataSource,
  insertDataSource,
  listDataSources,
  markSourceStatus,
  publicSource,
  secretLast4,
  sourceConfigInput,
  secretInput,
} from "../data-sources/store";
import { testDataSourceConnection } from "../data-sources/test-connection";
import { syncDataSource } from "../data-sources/sync";

const createInput = z
  .object({
    name: z.string().min(1).max(200),
    kind: z.enum(["s3", "azure_blob", "postgres", "mysql"]),
    tableAllowlist: z.array(z.string().min(1).max(255)).max(200).optional(),
  })
  .passthrough();

const CONFIG_FIELDS: Record<string, readonly string[]> = {
  s3: ["kind", "endpoint", "region", "bucket", "prefix"],
  postgres: ["kind", "database", "user", "host", "port"],
  mysql: ["kind", "database", "user", "host", "port"],
  azure_blob: ["kind"],
};
const SECRET_FIELDS: Record<string, readonly string[]> = {
  s3: ["kind", "s3AccessKeyId", "s3SecretAccessKey"],
  postgres: ["kind", "secret"],
  mysql: ["kind", "secret"],
  azure_blob: ["kind"],
};

/** One POST body carries config and secret halves; each strict schema sees only its own keys. */
function subset(body: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter((key) => key in body).map((key) => [key, body[key]]));
}

function auditActor(request: HostRequest, tenantId: string) {
  return { tenantId, actorKind: "user" as const, actorId: request.session?.userId ?? null };
}

export async function handleGetDataSources(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    return jsonOk({ dataSources: listDataSources(tenant.tenantId).map(publicSource) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function handlePostDataSources(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    const body = createInput.parse(request.body ?? {});
    const raw = body as unknown as Record<string, unknown>;
    const config = sourceConfigInput.parse(subset(raw, CONFIG_FIELDS[body.kind]));
    if (config.kind === "mysql") {
      // Held behind Rizky's mysql2 decision (S5): the shape validates, the driver does not ship.
      throw new ApiError("driver_missing", "MySQL is waiting on the mysql2 decision", 501);
    }
    if (config.kind === "azure_blob") {
      throw new ApiError("driver_missing", "Azure Blob is the W3 part of this work", 501);
    }
    const secret = secretInput.parse(subset(raw, SECRET_FIELDS[config.kind]));
    const row = insertDataSource({
      tenantId: tenant.tenantId,
      kind: config.kind,
      name: body.name,
      config,
      secret,
      secretLast4: secretLast4(secret),
      tableAllowlist: body.tableAllowlist ?? null,
      createdBy: request.session?.userId ?? null,
    });
    reportAuditEvent({
      ...auditActor(request, tenant.tenantId),
      event: "data_source.add",
      targetKind: "data_source",
      targetId: row.id,
      outcome: "ok",
      rule: row.kind,
    });
    return jsonOk({ dataSource: publicSource(row) }, 201);
  } catch (error) {
    return jsonError(error);
  }
}

export async function handlePostDataSourceTest(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    const row = getDataSource(tenant.tenantId, request.params.id ?? "");
    try {
      await testDataSourceConnection(row);
    } catch (error) {
      reportAuditEvent({
        ...auditActor(request, tenant.tenantId),
        event: "data_source.access",
        targetKind: "data_source",
        targetId: row.id,
        outcome: "failed",
        rule: error instanceof ApiError ? error.code : "source_test_failed",
      });
      throw error;
    }
    reportAuditEvent({
      ...auditActor(request, tenant.tenantId),
      event: "data_source.access",
      targetKind: "data_source",
      targetId: row.id,
      outcome: "ok",
      rule: "test_connection",
    });
    return jsonOk({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}

export async function handlePostDataSourceSync(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    const row = getDataSource(tenant.tenantId, request.params.id ?? "");
    const result = await syncDataSource(tenant, row, auditActor(request, tenant.tenantId));
    return jsonOk(result);
  } catch (error) {
    return jsonError(error);
  }
}

export async function handlePostDataSourceDisable(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    const row = getDataSource(tenant.tenantId, request.params.id ?? "");
    markSourceStatus(tenant.tenantId, row.id, "disabled");
    reportAuditEvent({
      ...auditActor(request, tenant.tenantId),
      event: "data_source.change",
      targetKind: "data_source",
      targetId: row.id,
      outcome: "ok",
      rule: "disabled",
    });
    return jsonOk({ dataSource: publicSource(getDataSource(tenant.tenantId, row.id)) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function handleDeleteDataSourceCredentials(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    const row = getDataSource(tenant.tenantId, request.params.id ?? "");
    deleteSourceCredentials(tenant.tenantId, row.id);
    reportAuditEvent({
      ...auditActor(request, tenant.tenantId),
      event: "data_source.change",
      targetKind: "data_source",
      targetId: row.id,
      outcome: "ok",
      rule: "credentials_removed",
    });
    return jsonOk({ dataSource: publicSource(getDataSource(tenant.tenantId, row.id)) });
  } catch (error) {
    return jsonError(error);
  }
}
