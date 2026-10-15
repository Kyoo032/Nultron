import { ApiError, canAdminister, isServerMode, type TenantContext } from "@agentforge/core";
import type { HostRequest, HostResult } from "../types";
import { jsonError, jsonOk } from "../errors";
import { getTenant } from "../tenant";
import {
  isValidGatewayAdminToken,
  gatewayAdminPayload,
  parseGatewayAdminAccountId,
  type GatewayAdminRecord,
} from "../gateway-tokens/admin-record";
import { checkGatewayManagementToken } from "../gateway-tokens/check";
import { clearCompanyGatewayAdmin, loadCompanyGatewayAdmin, saveCompanyGatewayAdmin } from "../settings-store";

export type CompanyGatewayAdminDeps = {
  readonly isServerMode?: () => boolean;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
};

const FORBIDDEN_CODE = "gateway_admin_forbidden";

function serverModeOn(deps: CompanyGatewayAdminDeps): boolean {
  return deps.isServerMode ? deps.isServerMode() : isServerMode();
}

function notFound(): ApiError {
  return new ApiError("not_found", "Not found", 404);
}

function assertCanRead(tenant: TenantContext): void {
  if (!canAdminister(tenant.role)) {
    throw new ApiError(FORBIDDEN_CODE, "Only an owner or admin can see the gateway management token's status.", 403);
  }
}

function assertCanWrite(tenant: TenantContext): void {
  if (tenant.role !== "owner") {
    throw new ApiError(FORBIDDEN_CODE, "Only the company's owner can set or clear the gateway management token.", 403);
  }
}

function readAccountId(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = parseGatewayAdminAccountId(value);
  if (parsed === null) {
    throw new ApiError("invalid_request", "The account id is a positive whole number, or left empty.", 400);
  }
  return parsed;
}

function readToken(value: unknown): string {
  if (!isValidGatewayAdminToken(value)) {
    throw new ApiError(
      "invalid_request",
      "The management token is one unbroken string of up to 512 printable characters.",
      400,
    );
  }
  return value;
}

export async function handleGetCompanyGatewayAdmin(
  request: HostRequest,
  deps: CompanyGatewayAdminDeps = {},
): Promise<HostResult> {
  try {
    if (!serverModeOn(deps)) {
      throw notFound();
    }
    const tenant = await getTenant(request);
    assertCanRead(tenant);
    return jsonOk(gatewayAdminPayload(loadCompanyGatewayAdmin(tenant)));
  } catch (error) {
    return jsonError(error);
  }
}

export async function handlePutCompanyGatewayAdmin(
  request: HostRequest,
  deps: CompanyGatewayAdminDeps = {},
): Promise<HostResult> {
  try {
    if (!serverModeOn(deps)) {
      throw notFound();
    }
    const tenant = await getTenant(request);
    assertCanWrite(tenant);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const token = readToken(body.token);
    const accountId = readAccountId(body.accountId);
    const now = deps.now ?? Date.now;

    saveCompanyGatewayAdmin(tenant, { token, accountId, checkedAt: null, status: "unchecked" });
    const status = await checkGatewayManagementToken({ token, accountId, fetchFn: deps.fetch });
    const stored: GatewayAdminRecord = saveCompanyGatewayAdmin(tenant, {
      token,
      accountId,
      checkedAt: now(),
      status,
    });
    return jsonOk(gatewayAdminPayload(stored));
  } catch (error) {
    return jsonError(error);
  }
}

export async function handleDeleteCompanyGatewayAdmin(
  request: HostRequest,
  deps: CompanyGatewayAdminDeps = {},
): Promise<HostResult> {
  try {
    if (!serverModeOn(deps)) {
      throw notFound();
    }
    const tenant = await getTenant(request);
    assertCanWrite(tenant);
    clearCompanyGatewayAdmin(tenant);
    return jsonOk(gatewayAdminPayload(null));
  } catch (error) {
    return jsonError(error);
  }
}
