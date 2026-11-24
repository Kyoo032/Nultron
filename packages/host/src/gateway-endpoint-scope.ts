/**
 * Per-request / per-run operator-assigned API gateway endpoint in AsyncLocalStorage.
 *
 * Only Nultron admins can assign a per-user gateway endpoint (via the portal CLI). The portal
 * delivers it in `/auth/token` (`gateway_endpoint`), the host stores it on `auth_sessions` and
 * binds it for the duration of each authenticated request, WebSocket voice session, or detached
 * run. Importing this module installs the reader into `@agentforge/core` so every call to
 * `resolvedGatewayBaseUrl()` automatically targets the signed-in user's assigned endpoint.
 *
 * When unset (or off server mode), the store yields `null` and `@agentforge/core` falls back to
 * `gatewayUrlOverride() ?? PINNED_GATEWAY_BASE_URL`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { normalizeAssignedGatewayEndpoint, registerAssignedGatewayEndpointReader } from "@agentforge/core";

const storage = new AsyncLocalStorage<string | null>();

registerAssignedGatewayEndpointReader(() => storage.getStore() ?? null);

export function currentAssignedGatewayEndpoint(): string | null {
  return normalizeAssignedGatewayEndpoint(storage.getStore() ?? null);
}

export function withAssignedGatewayEndpoint<T>(endpoint: string | null | undefined, fn: () => T): T {
  const normalized = normalizeAssignedGatewayEndpoint(endpoint ?? null);
  return storage.run(normalized, fn);
}

/** Short deterministic slot suffix for isolating per-endpoint gate verdicts and model caches. */
export function assignedEndpointSlotTag(endpoint: string): string {
  return createHash("sha256").update(endpoint, "utf8").digest("hex").slice(0, 16);
}
