export const GATEWAY_ADMIN_STATUSES = ["ok", "invalid", "unreachable", "unchecked"] as const;
export type GatewayAdminStatus = (typeof GATEWAY_ADMIN_STATUSES)[number];

export const GATEWAY_ADMIN_TOKEN_MAX_LENGTH = 512;

const TOKEN_SHAPE = /^[\x21-\x7e]+$/;

export type GatewayAdminRecord = {
  readonly token: string;
  readonly accountId: number | null;
  readonly checkedAt: number | null;
  readonly status: GatewayAdminStatus;
};

export type GatewayAdminPayload = {
  readonly configured: boolean;
  readonly accountIdSet: boolean;
  readonly checkedAt: number | null;
  readonly status: GatewayAdminStatus;
};

export function isValidGatewayAdminToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= GATEWAY_ADMIN_TOKEN_MAX_LENGTH &&
    TOKEN_SHAPE.test(value)
  );
}

export function parseGatewayAdminAccountId(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const numeric = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof numeric === "number" && Number.isSafeInteger(numeric) && numeric > 0) {
    return numeric;
  }
  return null;
}

export function parseGatewayAdminRecord(value: unknown): GatewayAdminRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (!isValidGatewayAdminToken(record.token)) {
    return null;
  }
  const accountId = record.accountId === null ? null : parseGatewayAdminAccountId(record.accountId);
  if (record.accountId !== null && record.accountId !== undefined && accountId === null) {
    return null;
  }
  const checkedAt =
    typeof record.checkedAt === "number" && Number.isFinite(record.checkedAt) && record.checkedAt >= 0
      ? record.checkedAt
      : null;
  const status = (GATEWAY_ADMIN_STATUSES as readonly string[]).includes(record.status as string)
    ? (record.status as GatewayAdminStatus)
    : "unchecked";
  return { token: record.token, accountId, checkedAt, status };
}

export function gatewayAdminPayload(record: GatewayAdminRecord | null): GatewayAdminPayload {
  if (!record) {
    return { configured: false, accountIdSet: false, checkedAt: null, status: "unchecked" };
  }
  return {
    configured: true,
    accountIdSet: record.accountId !== null,
    checkedAt: record.checkedAt,
    status: record.status,
  };
}
