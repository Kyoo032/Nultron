/**
 * OIDC discovery over the built-in `fetch` (S5: no new library). The document is fetched once per
 * provider and cached; a cache miss or an expired entry refetches, and a fetch that fails when a
 * stale document is in hand serves the stale one rather than denying sign-ins over a transient
 * outage.
 */
import { isLoopbackHost } from "../security/cookies";

export interface OidcDiscovery {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

interface CacheEntry {
  readonly document: OidcDiscovery;
  readonly fetchedAt: number;
}

export class OidcDiscoveryError extends Error {}

/**
 * `now` and `fetchImpl` are the test seams; production callers use the defaults.
 */
export function createDiscovery(
  now: () => number = Date.now,
  fetchImpl: typeof fetch = fetch,
): { readonly get: (discoveryUrl: string) => Promise<OidcDiscovery> } {
  const cache = new Map<string, CacheEntry>();

  const get = async (discoveryUrl: string): Promise<OidcDiscovery> => {
    const cached = cache.get(discoveryUrl);
    if (cached && now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.document;
    }
    try {
      const document = await fetchDiscovery(discoveryUrl, fetchImpl);
      cache.set(discoveryUrl, { document, fetchedAt: now() });
      return document;
    } catch (error) {
      if (cached) {
        return cached.document;
      }
      throw error;
    }
  };

  return Object.freeze({ get });
}

async function fetchDiscovery(url: string, fetchImpl: typeof fetch): Promise<OidcDiscovery> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch (error) {
    throw new OidcDiscoveryError(`discovery fetch failed: ${(error as Error).message}`);
  }
  if (!response.ok) {
    throw new OidcDiscoveryError(`discovery fetch answered ${response.status}`);
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const issuer = str(body?.issuer);
  const authorizationEndpoint = str(body?.authorization_endpoint);
  const tokenEndpoint = str(body?.token_endpoint);
  const jwksUri = str(body?.jwks_uri);
  if (!issuer || !authorizationEndpoint || !tokenEndpoint || !jwksUri) {
    throw new OidcDiscoveryError("discovery document is missing required fields");
  }
  // An endpoint that is not https is not followed: the redirect off the portal would carry the
  // round-trip secrets in cleartext. Loopback http is left for the test seam's stub IdP -- the
  // check is on the hostname, not the prefix, so `http://127.0.0.1.evil.example` does not pass.
  for (const [name, endpoint] of [
    ["authorization_endpoint", authorizationEndpoint],
    ["token_endpoint", tokenEndpoint],
    ["jwks_uri", jwksUri],
  ] as const) {
    const parsed = URL.parse(endpoint);
    if (
      !parsed ||
      (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)))
    ) {
      throw new OidcDiscoveryError(`${name} must be https`);
    }
  }
  return { issuer, authorizationEndpoint, tokenEndpoint, jwksUri };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
