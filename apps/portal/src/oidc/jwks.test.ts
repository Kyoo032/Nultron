/**
 * `jwks.ts`: the cache, the exactly-one-refetch on an unknown `kid` (rotation), and what a
 * malformed answer does to a signature check.
 */
import { generateKeyPairSync } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createJwks, OidcJwksError } from "./jwks";

const JWKS_URI = "https://idp.test/keys";

function rsaJwk(kid: string): JsonWebKey {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { ...(publicKey.export({ format: "jwk" }) as JsonWebKey), kid };
}

function jwksBody(keys: readonly JsonWebKey[]): Response {
  return new Response(JSON.stringify({ keys }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function countingFetch(answers: Response[]): typeof fetch {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    const next = answers.shift();
    if (!next) {
      return new Response("gone", { status: 404 });
    }
    return next.clone();
  }) as typeof fetch;
  return Object.assign(impl, { calls });
}

describe("createJwks", () => {
  it("caches a set for its TTL and refetches after it", async () => {
    const first = rsaJwk("k1");
    const second = rsaJwk("k2");
    let now = 1_000;
    const fetchImpl = countingFetch([jwksBody([first]), jwksBody([second])]);
    const jwks = createJwks(() => now, fetchImpl);

    expect(await jwks.getKey(JWKS_URI, "k1")).toMatchObject({ kid: "k1" });
    expect(await jwks.getKey(JWKS_URI, "k1")).toMatchObject({ kid: "k1" });
    expect((fetchImpl as unknown as { calls: string[] }).calls).toHaveLength(1);

    now += 31 * 60 * 1000; // past the 30-minute TTL
    expect(await jwks.getKey(JWKS_URI, "k2")).toMatchObject({ kid: "k2" });
    expect((fetchImpl as unknown as { calls: string[] }).calls).toHaveLength(2);
  });

  it("refetches exactly once for an unknown kid, then refuses without a third call", async () => {
    const rotated = rsaJwk("new-kid");
    const fetchImpl = countingFetch([jwksBody([rsaJwk("old-kid")]), jwksBody([rotated]), jwksBody([rotated])]);
    const jwks = createJwks(() => 5_000, fetchImpl);

    // Warm the cache on the old set.
    expect(await jwks.getKey(JWKS_URI, "old-kid")).not.toBeNull();
    // Rotation: the unknown kid refetches the set once and finds it.
    expect(await jwks.getKey(JWKS_URI, "new-kid")).toMatchObject({ kid: "new-kid" });
    // A kid still unknown after its one refetch is refused; each call refetches at most once.
    expect(await jwks.getKey(JWKS_URI, "nobody")).toBeNull();
    expect((fetchImpl as unknown as { calls: string[] }).calls).toHaveLength(3);
  });

  it("drops keys with no kid or no RSA material", async () => {
    const good = rsaJwk("good");
    const set = jwksBody([good, { kty: "EC", kid: "ec", crv: "P-256" }, { kty: "RSA", n: "x" }]);
    const fetchImpl = countingFetch([set, set]);
    const jwks = createJwks(() => 7_000, fetchImpl);

    expect(await jwks.getKey(JWKS_URI, "good")).not.toBeNull();
    expect(await jwks.getKey(JWKS_URI, "ec")).toBeNull();
    expect((fetchImpl as unknown as { calls: string[] }).calls).toHaveLength(2); // one refetch, cached
  });

  it("raises on a non-200 and on a document with no usable keys", async () => {
    const jwks = createJwks(() => 9_000, countingFetch([new Response("nope", { status: 500 })]));
    await expect(jwks.getKey(JWKS_URI, "k")).rejects.toBeInstanceOf(OidcJwksError);

    const empty = createJwks(() => 9_000, countingFetch([jwksBody([])]));
    await expect(empty.getKey(JWKS_URI, "k")).rejects.toBeInstanceOf(OidcJwksError);
  });
});
