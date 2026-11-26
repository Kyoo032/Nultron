/**
 * The provider's JSON Web Key Set: fetched over built-in `fetch`, cached per `jwks_uri`, and
 * refetched exactly once when a `kid` the cache does not know shows up (key rotation is the only
 * legitimate reason a signature misses; a second refetch in one verify call would be an
 * attacker-controlled JWKS DoS).
 */
import type { JsonWebKey } from "node:crypto";

const FETCH_TIMEOUT_MS = 10_000;
/** A key set is held at most this long; rotation is caught sooner by the unknown-kid refetch. */
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_KEYS = 50;

export class OidcJwksError extends Error {}

interface CacheEntry {
  /** JWK objects (RSA `n`/`e` are never mutated or logged). */
  readonly keys: ReadonlyMap<string, JsonWebKey>;
  readonly fetchedAt: number;
}

export function createJwks(
  now: () => number = Date.now,
  fetchImpl: typeof fetch = fetch,
): {
  readonly getKey: (jwksUri: string, kid: string) => Promise<JsonWebKey | null>;
  readonly reset: (jwksUri: string) => void;
} {
  const cache = new Map<string, CacheEntry>();

  const fetchSet = async (jwksUri: string): Promise<ReadonlyMap<string, JsonWebKey>> => {
    let response: Response;
    try {
      response = await fetchImpl(jwksUri, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: "application/json" },
      });
    } catch (error) {
      throw new OidcJwksError(`jwks fetch failed: ${(error as Error).message}`);
    }
    if (!response.ok) {
      throw new OidcJwksError(`jwks fetch answered ${response.status}`);
    }
    const body = (await response.json().catch(() => null)) as { keys?: unknown } | null;
    if (!Array.isArray(body?.keys) || body.keys.length === 0 || body.keys.length > MAX_KEYS) {
      throw new OidcJwksError("jwks document has no usable keys");
    }
    const keys = new Map<string, JsonWebKey>();
    for (const raw of body.keys) {
      const jwk = raw as JsonWebKey;
      // Only the shape this portal verifies against is kept: RSA for RS256.
      if (typeof jwk.kid === "string" && jwk.kty === "RSA" && typeof jwk.n === "string" && typeof jwk.e === "string") {
        keys.set(jwk.kid, jwk);
      }
    }
    cache.set(jwksUri, { keys, fetchedAt: now() });
    return keys;
  };

  const getKey = async (jwksUri: string, kid: string): Promise<JsonWebKey | null> => {
    const cached = cache.get(jwksUri);
    if (cached && now() - cached.fetchedAt >= CACHE_TTL_MS) {
      // Stale: drop it before looking, so an unknown kid below is one refetch, not two.
      cache.delete(jwksUri);
    }
    let keys = cache.get(jwksUri)?.keys;
    let key = keys?.get(kid);
    if (!key) {
      // One refetch covers rotation; the key was just not there yet when the set was cached.
      keys = await fetchSet(jwksUri);
      key = keys.get(kid);
    }
    return key ?? null;
  };

  const reset = (jwksUri: string): void => {
    cache.delete(jwksUri);
  };

  return Object.freeze({ getKey, reset });
}
