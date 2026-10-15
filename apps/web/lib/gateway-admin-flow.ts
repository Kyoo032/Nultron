import { t } from "./i18n";
import {
  readGatewayAdmin,
  removeGatewayAdmin,
  saveGatewayAdmin,
  type GatewayAdminFailure,
  type GatewayAdminInput,
  type GatewayAdminResult,
  type GatewayAdminState,
  type GatewayAdminStatus,
} from "./gateway-admin-client";

export type GatewayAdminClient = {
  read: () => Promise<GatewayAdminResult>;
  save: (input: GatewayAdminInput) => Promise<GatewayAdminResult>;
  remove: () => Promise<GatewayAdminResult>;
};

export const LIVE_GATEWAY_ADMIN: GatewayAdminClient = {
  read: readGatewayAdmin,
  save: saveGatewayAdmin,
  remove: removeGatewayAdmin,
};

export type WriteOutcome = { ok: true; state: GatewayAdminState; message: string } | { ok: false; error: string };

const STATUS_KEYS: Record<GatewayAdminStatus, string> = {
  ok: "settings.gatewayAdmin.status.ok",
  invalid: "settings.gatewayAdmin.status.invalid",
  unreachable: "settings.gatewayAdmin.status.unreachable",
  unchecked: "settings.gatewayAdmin.status.unchecked",
};

export function statusKey(state: GatewayAdminState): string {
  return state.configured ? STATUS_KEYS[state.status] : "settings.gatewayAdmin.status.notSet";
}

export type AccountIdResult = { ok: true; accountId?: number } | { ok: false };

export function accountIdFrom(text: string): AccountIdResult {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: true };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false };
  }
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? { ok: true, accountId: value } : { ok: false };
}

function failureText(reason: GatewayAdminFailure, fallbackKey: string): string {
  return t(reason === "forbidden" ? "settings.gatewayAdmin.forbidden" : fallbackKey);
}

export async function runSave(
  input: { token: string; accountIdText: string },
  client: GatewayAdminClient = LIVE_GATEWAY_ADMIN,
): Promise<WriteOutcome> {
  const token = input.token.trim();
  if (token === "") {
    return { ok: false, error: t("settings.gatewayAdmin.tokenRequired") };
  }
  const accountId = accountIdFrom(input.accountIdText);
  if (!accountId.ok) {
    return { ok: false, error: t("settings.gatewayAdmin.accountIdInvalid") };
  }
  const result = await client.save(
    accountId.accountId === undefined ? { token } : { token, accountId: accountId.accountId },
  );
  return result.ok
    ? { ok: true, state: result.state, message: t("settings.gatewayAdmin.saved") }
    : { ok: false, error: failureText(result.reason, "settings.gatewayAdmin.failed") };
}

export async function runRemove(client: GatewayAdminClient = LIVE_GATEWAY_ADMIN): Promise<WriteOutcome> {
  const result = await client.remove();
  return result.ok
    ? { ok: true, state: result.state, message: t("settings.gatewayAdmin.removed") }
    : { ok: false, error: failureText(result.reason, "settings.gatewayAdmin.removeFailed") };
}
