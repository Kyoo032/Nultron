import { ApiError, canAdminister, isServerMode, pinnedGatewayOrigin, type TenantContext } from "@agentforge/core";
import { sql } from "@agentforge/db";
import { loadCompanyGatewayAdmin } from "../settings-store";
import type { GatewayAdminRecord } from "./admin-record";
import { GATEWAY_ADMIN_CHECK_TIMEOUT_MS, gatewayAdminHeaders } from "./check";

export const GATEWAY_TOKEN_BATCH_LIMIT = 100;
export const GATEWAY_TOKEN_NAME_MAX_LENGTH = 100;

const TOKEN_PATH = "/api/token/";
const TOKEN_BATCH_PATH = "/api/token/batch";
const TOKEN_USAGE_PATH = "/api/usage/token/";

export type GatewayTokenFields = {
  readonly name: string;
  readonly remainQuota: number;
  readonly unlimitedQuota: boolean;
  readonly expiredTime: number;
  readonly modelLimits?: string;
  readonly allowIps?: string;
};

export type GatewayTokenAdapterDeps = {
  readonly fetch?: typeof fetch;
  readonly isServerMode?: () => boolean;
  readonly now?: () => number;
};

export type GatewayTokenAdapter = {
  createToken(fields: GatewayTokenFields): Promise<{ id: string; name: string }>;
  updateToken(id: string | number, fields: GatewayTokenFields): Promise<{ id: string }>;
  deleteTokens(ids: ReadonlyArray<string | number>): Promise<{ deleted: string[] }>;
  tokenUsage(id: string | number): Promise<{ id: string; usage: unknown }>;
};

function invalid(message: string): ApiError {
  return new ApiError("invalid_request", message, 400);
}

function normalizeGatewayId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^[1-9]\d{0,15}$/.test(value)) {
    return value;
  }
  return null;
}

function requireGatewayId(value: unknown): string {
  const id = normalizeGatewayId(value);
  if (id === null) {
    throw invalid("A gateway token id is a positive whole number.");
  }
  return id;
}

function requireGatewayIds(values: ReadonlyArray<unknown>): string[] {
  if (values.length === 0) {
    throw invalid("Pick at least one gateway token.");
  }
  if (values.length > GATEWAY_TOKEN_BATCH_LIMIT) {
    throw invalid(`At most ${GATEWAY_TOKEN_BATCH_LIMIT} gateway tokens can change in one request.`);
  }
  return [...new Set(values.map(requireGatewayId))];
}

function validateFields(fields: GatewayTokenFields): GatewayTokenFields {
  const name = typeof fields.name === "string" ? fields.name.trim() : "";
  if (name.length === 0 || name.length > GATEWAY_TOKEN_NAME_MAX_LENGTH) {
    throw invalid(`A gateway token needs a name of up to ${GATEWAY_TOKEN_NAME_MAX_LENGTH} characters.`);
  }
  if (!Number.isSafeInteger(fields.remainQuota) || fields.remainQuota < -1) {
    throw invalid("remainQuota is a whole number, -1 for unlimited.");
  }
  if (typeof fields.unlimitedQuota !== "boolean") {
    throw invalid("unlimitedQuota is true or false.");
  }
  if (!Number.isSafeInteger(fields.expiredTime) || (fields.expiredTime !== -1 && fields.expiredTime <= 0)) {
    throw invalid("expiredTime is a Unix time in seconds, or -1 for no expiry.");
  }
  if (fields.modelLimits !== undefined && typeof fields.modelLimits !== "string") {
    throw invalid("modelLimits is a string.");
  }
  if (fields.allowIps !== undefined && typeof fields.allowIps !== "string") {
    throw invalid("allowIps is a string.");
  }
  return { ...fields, name };
}

function toWire(fields: GatewayTokenFields): Record<string, unknown> {
  const modelLimits = fields.modelLimits?.trim() ?? "";
  return {
    name: fields.name,
    remain_quota: fields.remainQuota,
    unlimited_quota: fields.unlimitedQuota,
    expired_time: fields.expiredTime,
    model_limits_enabled: modelLimits.length > 0,
    model_limits: modelLimits,
    allow_ips: fields.allowIps?.trim() ?? "",
  };
}

function manageable(tenant: TenantContext, deps: GatewayTokenAdapterDeps): GatewayAdminRecord {
  const serverMode = deps.isServerMode ? deps.isServerMode() : isServerMode();
  if (!serverMode) {
    throw new ApiError("not_found", "Not found", 404);
  }
  if (!canAdminister(tenant.role)) {
    throw new ApiError(
      "gateway_admin_forbidden",
      "Only an owner or admin can manage the company's gateway tokens.",
      403,
    );
  }
  const record = loadCompanyGatewayAdmin(tenant);
  if (!record) {
    throw new ApiError("gateway_admin_not_configured", "No gateway management token is saved for this company.", 409);
  }
  return record;
}

function assertManaged(tenant: TenantContext, ids: readonly string[]): void {
  const placeholders = ids.map(() => "?").join(", ");
  const rows = sql
    .prepare(
      `SELECT gateway_token_id AS id FROM gateway_managed_tokens WHERE organization_id = ? AND gateway_token_id IN (${placeholders})`,
    )
    .all(tenant.organizationId, ...ids) as Array<{ id: string }>;
  const found = new Set(rows.map((row) => row.id));
  if (ids.some((id) => !found.has(id))) {
    throw new ApiError(
      "gateway_token_not_managed",
      "One or more tokens were not created through this platform, so they are not changed from here.",
      404,
    );
  }
}

async function callGateway(
  record: GatewayAdminRecord,
  method: "GET" | "POST" | "PUT",
  path: string,
  body: Record<string, unknown> | undefined,
  fetchFn: typeof fetch,
): Promise<unknown> {
  const headers: Record<string, string> = gatewayAdminHeaders(record.token, record.accountId);
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  let response: Response;
  try {
    response = await fetchFn(new URL(path, pinnedGatewayOrigin()).toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(GATEWAY_ADMIN_CHECK_TIMEOUT_MS),
    });
  } catch {
    throw new ApiError("gateway_unreachable", "The gateway did not answer. Try again.", 502);
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new ApiError("gateway_redirect_refused", "The gateway answered with a redirect, which is not followed.", 502);
  }
  const json = (await response.json().catch(() => null)) as { success?: unknown } | null;
  if (!response.ok || json?.success !== true) {
    const status = response.status === 401 || response.status === 403 ? 403 : 502;
    throw new ApiError("gateway_rejected", `The gateway refused the request (${response.status}).`, status);
  }
  return json;
}

export function gatewayTokenAdapter(tenant: TenantContext, deps: GatewayTokenAdapterDeps = {}): GatewayTokenAdapter {
  const now = deps.now ?? Date.now;
  const fetchFn = (): typeof fetch => deps.fetch ?? fetch;

  return {
    async createToken(input) {
      const record = manageable(tenant, deps);
      const fields = validateFields(input);
      const response = (await callGateway(record, "POST", TOKEN_PATH, toWire(fields), fetchFn())) as {
        data?: { id?: unknown };
      };
      const id = normalizeGatewayId(response.data?.id);
      if (id === null) {
        throw new ApiError(
          "gateway_token_unconfirmed",
          "The gateway did not confirm the new token's id, so nothing was recorded.",
          502,
        );
      }
      sql
        .prepare(
          "INSERT INTO gateway_managed_tokens (organization_id, gateway_token_id, name, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(tenant.organizationId, id, fields.name, now());
      return { id, name: fields.name };
    },

    async updateToken(rawId, input) {
      const record = manageable(tenant, deps);
      const id = requireGatewayId(rawId);
      const fields = validateFields(input);
      assertManaged(tenant, [id]);
      await callGateway(record, "PUT", TOKEN_PATH, { id: Number(id), ...toWire(fields) }, fetchFn());
      sql
        .prepare("UPDATE gateway_managed_tokens SET name = ? WHERE organization_id = ? AND gateway_token_id = ?")
        .run(fields.name, tenant.organizationId, id);
      return { id };
    },

    async deleteTokens(rawIds) {
      const record = manageable(tenant, deps);
      const ids = requireGatewayIds(rawIds);
      assertManaged(tenant, ids);
      await callGateway(record, "POST", TOKEN_BATCH_PATH, { ids: ids.map(Number) }, fetchFn());
      sql.transaction((done: readonly string[]) => {
        const remove = sql.prepare(
          "DELETE FROM gateway_managed_tokens WHERE organization_id = ? AND gateway_token_id = ?",
        );
        for (const id of done) {
          remove.run(tenant.organizationId, id);
        }
      })(ids);
      return { deleted: ids };
    },

    async tokenUsage(rawId) {
      const record = manageable(tenant, deps);
      const id = requireGatewayId(rawId);
      assertManaged(tenant, [id]);
      const response = (await callGateway(
        record,
        "GET",
        `${TOKEN_USAGE_PATH}?token_id=${id}`,
        undefined,
        fetchFn(),
      )) as { data?: unknown };
      return { id, usage: response.data ?? null };
    },
  };
}
