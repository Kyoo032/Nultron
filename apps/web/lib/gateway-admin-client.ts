import { apiFetch } from "./api-client";

export const GATEWAY_ADMIN_PATH = "/api/v1/company/gateway-admin";

export const GATEWAY_ADMIN_STATUSES = ["ok", "invalid", "unreachable", "unchecked"] as const;

export type GatewayAdminStatus = (typeof GATEWAY_ADMIN_STATUSES)[number];

export type GatewayAdminState = {
  configured: boolean;
  accountIdSet: boolean;
  checkedAt: string | null;
  status: GatewayAdminStatus;
};

export type GatewayAdminFailure = "forbidden" | "failed";

export type GatewayAdminResult = { ok: true; state: GatewayAdminState } | { ok: false; reason: GatewayAdminFailure };

export type GatewayAdminInput = { token: string; accountId?: number };

function recordOf(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const nested = record.body;
  return nested && typeof nested === "object" && !Array.isArray(nested) ? (nested as Record<string, unknown>) : record;
}

function statusOf(value: unknown): GatewayAdminStatus {
  return GATEWAY_ADMIN_STATUSES.find((status) => status === value) ?? "unchecked";
}

export function parseGatewayAdminState(payload: unknown): GatewayAdminState | null {
  const record = recordOf(payload);
  if (!record || typeof record.configured !== "boolean") {
    return null;
  }
  return {
    configured: record.configured,
    accountIdSet: record.accountIdSet === true,
    checkedAt: typeof record.checkedAt === "string" && record.checkedAt.trim() ? record.checkedAt : null,
    status: statusOf(record.status),
  };
}

function failed(reason: GatewayAdminFailure = "failed"): GatewayAdminResult {
  return { ok: false, reason };
}

export async function readGatewayAdmin(): Promise<GatewayAdminResult> {
  let res: Response;
  try {
    res = await apiFetch(GATEWAY_ADMIN_PATH);
  } catch {
    return failed();
  }
  if (res.status === 403) {
    return failed("forbidden");
  }
  if (!res.ok) {
    return failed();
  }
  const state = parseGatewayAdminState(await res.json().catch(() => null));
  return state ? { ok: true, state } : failed();
}

async function writeThenReport(send: () => Promise<Response>): Promise<GatewayAdminResult> {
  let res: Response;
  try {
    res = await send();
  } catch {
    return failed();
  }
  if (res.status === 403) {
    return failed("forbidden");
  }
  if (!res.ok) {
    return failed();
  }
  const state = parseGatewayAdminState(await res.json().catch(() => null));
  return state ? { ok: true, state } : readGatewayAdmin();
}

export function saveGatewayAdmin(input: GatewayAdminInput): Promise<GatewayAdminResult> {
  const body = {
    token: input.token,
    ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
  };
  return writeThenReport(() =>
    apiFetch(GATEWAY_ADMIN_PATH, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export function removeGatewayAdmin(): Promise<GatewayAdminResult> {
  return writeThenReport(() => apiFetch(GATEWAY_ADMIN_PATH, { method: "DELETE" }));
}
