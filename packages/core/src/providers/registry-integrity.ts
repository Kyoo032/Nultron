import { createHash } from "node:crypto";
import {
  PROVIDER_ENDPOINTS,
  PROVIDER_REGISTRY_SHA256,
  canonicalRegistryText,
  type ProviderEndpoints,
} from "./registry";

/** SHA-256 (hex) of a registry table's canonical text. */
export function providerRegistryDigest(endpoints: Readonly<Record<string, ProviderEndpoints>>): string {
  return createHash("sha256").update(canonicalRegistryText(endpoints), "utf8").digest("hex");
}

/**
 * Boot check for Node (host / tests), the sibling of `assertPinnedGatewayIntegrity`. A patched build
 * that swapped a provider host fails loudly here instead of posting a tenant's key to somebody else's
 * server. `endpoints` is a seam for the test that proves the check bites; callers pass nothing.
 *
 * Keep this file off the renderer graph: `node:crypto` is not available in the Vite client.
 */
export function assertProviderRegistryIntegrity(
  endpoints: Readonly<Record<string, ProviderEndpoints>> = PROVIDER_ENDPOINTS,
): void {
  const actual = providerRegistryDigest(endpoints);
  if (actual !== PROVIDER_REGISTRY_SHA256) {
    throw new Error(
      `Provider registry integrity check failed: expected sha256 ${PROVIDER_REGISTRY_SHA256}, got ${actual}. This build has been tampered with.`,
    );
  }
}
