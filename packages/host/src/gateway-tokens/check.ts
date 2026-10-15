import { pinnedGatewayOrigin } from "@agentforge/core";
import { log } from "../log";
import type { GatewayAdminStatus } from "./admin-record";

export const GATEWAY_ADMIN_CHECK_TIMEOUT_MS = 5_000;

export const GATEWAY_TOKEN_LIST_PATH = "/api/token/";

export type GatewayAdminCheckInput = {
  readonly token: string;
  readonly accountId: number | null;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
};

export function gatewayAdminCheckUrl(): string {
  const url = new URL(GATEWAY_TOKEN_LIST_PATH, pinnedGatewayOrigin());
  url.searchParams.set("p", "1");
  url.searchParams.set("page_size", "1");
  return url.toString();
}

export function gatewayAdminHeaders(token: string, accountId: number | null): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    ...(accountId !== null ? { "New-Api-User": String(accountId) } : {}),
  };
}

async function successFlag(response: Response): Promise<boolean | null> {
  try {
    const body = (await response.json()) as { success?: unknown };
    return typeof body?.success === "boolean" ? body.success : null;
  } catch {
    return null;
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    return;
  }
}

export async function checkGatewayManagementToken(
  input: GatewayAdminCheckInput,
): Promise<Exclude<GatewayAdminStatus, "unchecked">> {
  const fetchFn = input.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(gatewayAdminCheckUrl(), {
      headers: gatewayAdminHeaders(input.token, input.accountId),
      redirect: "manual",
      signal: AbortSignal.timeout(input.timeoutMs ?? GATEWAY_ADMIN_CHECK_TIMEOUT_MS),
    });
  } catch {
    log.warn("gateway_admin_check", { status: "unreachable" });
    return "unreachable";
  }
  if (response.status >= 300 && response.status < 400) {
    await discardBody(response);
    log.warn("gateway_admin_check", { status: "unreachable", httpStatus: response.status });
    return "unreachable";
  }
  if (response.status === 401 || response.status === 403) {
    await discardBody(response);
    log.info("gateway_admin_check", { status: "invalid", httpStatus: response.status });
    return "invalid";
  }
  if (response.status !== 200) {
    await discardBody(response);
    log.warn("gateway_admin_check", { status: "unreachable", httpStatus: response.status });
    return "unreachable";
  }
  const success = await successFlag(response);
  const status = success === true ? "ok" : success === false ? "invalid" : "unreachable";
  log.info("gateway_admin_check", { status });
  return status;
}
