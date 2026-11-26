/**
 * Per-request / per-run operator-assigned API gateway endpoint in AsyncLocalStorage.
 *
 * Only Nultron admins can assign a per-user gateway endpoint (via the portal CLI). The portal
 * delivers it in `/auth/token` (`gateway_endpoint`, plus the write-only `gateway_key` bearer key
 * for DFIND-155), the host stores it on `auth_sessions` — endpoint MAC'd, key sealed (migration
 * 0025) — and binds both for the duration of each authenticated request, WebSocket voice session,
 * or detached run. Importing this module installs the readers into `@agentforge/core` so every
 * call to `resolvedGatewayBaseUrl()` and `resolveProviderKeys()` automatically targets the
 * signed-in user's assigned endpoint and key.
 *
 * When unset (or off server mode), the store yields `null` and `@agentforge/core` falls back to
 * `gatewayUrlOverride() ?? PINNED_GATEWAY_BASE_URL` and the tenant/env key resolution.
 *
 * Endpoint and key are bound TOGETHER in one store: a key can never outlive the endpoint it was
 * issued for, and re-binding an endpoint without its key yields `null` — a needs_key, never a
 * leak of the previous scope's key onto a different host.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  normalizeAssignedGatewayEndpoint,
  registerAssignedGatewayEndpointReader,
  registerAssignedGatewayKeyReader,
} from "@agentforge/core";

type AssignedGatewayScope = {
  readonly endpoint: string | null;
  readonly key: string | null;
};

const storage = new AsyncLocalStorage<AssignedGatewayScope>();

registerAssignedGatewayEndpointReader(() => storage.getStore()?.endpoint ?? null);
registerAssignedGatewayKeyReader(() => storage.getStore()?.key ?? null);

export function currentAssignedGatewayEndpoint(): string | null {
  return normalizeAssignedGatewayEndpoint(storage.getStore()?.endpoint ?? null);
}

/** The bearer key bound beside `currentAssignedGatewayEndpoint()`, or null for none. */
export function currentAssignedGatewayKey(): string | null {
  return storage.getStore()?.key ?? null;
}

export function withAssignedGatewayEndpoint<T>(
  endpoint: string | null | undefined,
  fn: () => T,
  key: string | null = null,
): T {
  const normalized = normalizeAssignedGatewayEndpoint(endpoint ?? null);
  return storage.run({ endpoint: normalized, key: normalized ? key : null }, fn);
}

/** Short deterministic slot suffix for isolating per-endpoint gate verdicts and model caches. */
export function assignedEndpointSlotTag(endpoint: string): string {
  return createHash("sha256").update(endpoint, "utf8").digest("hex").slice(0, 16);
}
