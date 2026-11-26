/**
 * `verify-id-token.ts`: the whole negative matrix an ID token must survive (AC-8b.2), plus the
 * two claims that have to be true before a verified token means anything here.
 *
 * Real RSA keys are generated in-process (`node:crypto`), so the signature check is the real one.
 */
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { OidcDiscovery } from "./discovery";
import { oidcProviders, type OidcProvider } from "./providers";

const STUB_DOC: OidcDiscovery = {
  issuer: "https://accounts.google.com",
  authorizationEndpoint: "https://idp.test/authorize",
  tokenEndpoint: "https://idp.test/token",
  jwksUri: "https://idp.test/jwks",
};
import { verifyIdToken } from "./verify-id-token";

const GOOGLE = oidcProviders({
  google: { clientId: "test-client", clientSecret: "test-secret" },
  microsoft: null,
}).get("google") as OidcProvider;
const NOW = 1_800_000_000;
const NONCE = "test-nonce";
const NONCE_HASH = createHash("sha256").update(NONCE, "utf8").digest();

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { jwk: publicKey.export({ format: "jwk" }) as JsonWebKey, privateKey };
}

interface TokenOptions {
  readonly header?: Record<string, unknown>;
  readonly claims?: Record<string, unknown>;
  readonly signingKey?: ReturnType<typeof keyPair>["privateKey"];
}

function makeToken(options: TokenOptions = {}): string {
  const header = { alg: "RS256", kid: "kid-1", typ: "JWT", ...options.header };
  const claims = {
    iss: "https://accounts.google.com",
    aud: "test-client",
    sub: "subject-1",
    email: "person@pilot.test",
    email_verified: true,
    nonce: NONCE,
    iat: NOW - 60,
    exp: NOW + 600,
    ...options.claims,
  };
  const input = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(
    JSON.stringify(claims),
  ).toString("base64url")}`;
  const signature = cryptoSign("RSA-SHA256", Buffer.from(input, "ascii"), options.signingKey as never);
  return `${input}.${signature.toString("base64url")}`;
}

function input(overrides: Partial<Parameters<typeof verifyIdToken>[1]> = {}) {
  return {
    provider: GOOGLE,
    expectedNonceHash: NONCE_HASH,
    expectedAudience: "test-client",
    nowSeconds: NOW,
    ...overrides,
  };
}

async function check(
  token: string,
  keys: ReadonlyMap<string, JsonWebKey>,
  overrides?: Parameters<typeof input>[0],
) {
  return verifyIdToken(token, input(overrides), async (kid) => keys.get(kid) ?? null);
}

describe("verifyIdToken", () => {
  it("accepts a well-formed token and hands back its claims", async () => {
    const pair = keyPair();
    const token = makeToken({ signingKey: pair.privateKey });
    const result = await check(token, new Map([["kid-1", { ...pair.jwk, kid: "kid-1" }]]));
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.claims.sub).toBe("subject-1");
    }
  });

  it("refuses garbage before any key lookup", async () => {
    let lookedUp = false;
    const result = await verifyIdToken("not-a-jwt", input(), async () => {
      lookedUp = true;
      return null;
    });
    expect(result).toEqual({ ok: false, reason: "malformed" });
    expect(lookedUp).toBe(false);
  });

  it("refuses alg:none and HS* before any key lookup", async () => {
    for (const alg of ["none", "HS256", "HS384", "HS512"]) {
      let lookedUp = false;
      const pair = keyPair();
      const token = makeToken({ header: { alg }, signingKey: pair.privateKey });
      const result = await verifyIdToken(token, input(), async () => {
        lookedUp = true;
        return pair.jwk;
      });
      expect(result).toEqual({ ok: false, reason: "alg_refused" });
      expect(lookedUp).toBe(false);
    }
  });

  it("refuses an unknown kid and a bad signature", async () => {
    const pair = keyPair();
    const token = makeToken({ signingKey: pair.privateKey });
    expect(await check(token, new Map())).toEqual({ ok: false, reason: "unknown_kid" });

    const other = keyPair();
    const forged = makeToken({ signingKey: other.privateKey });
    expect(await check(forged, new Map([["kid-1", { ...pair.jwk, kid: "kid-1" }]]))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("refuses a wrong issuer, audience, expired, ancient and wrong-nonce token", async () => {
    const pair = keyPair();
    const keys = new Map([["kid-1", { ...pair.jwk, kid: "kid-1" }]]);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ iss: "https://evil.example" }, "iss"],
      [{ aud: "somebody-else" }, "aud"],
      [{ exp: NOW - 600 }, "exp"],
      [{ iat: NOW - 200_000 }, "iat"],
      [{ nonce: "other-nonce" }, "nonce"],
    ];
    for (const [claims, reason] of cases) {
      const token = makeToken({ signingKey: pair.privateKey, claims });
      expect(await check(token, keys)).toEqual({ ok: false, reason });
    }
  });

  it("refuses a token with no subject or an email Google did not verify", async () => {
    const pair = keyPair();
    const keys = new Map([["kid-1", { ...pair.jwk, kid: "kid-1" }]]);
    const noSub = makeToken({ signingKey: pair.privateKey, claims: { sub: undefined } });
    expect(await check(noSub, keys)).toEqual({ ok: false, reason: "claims" });

    // A verified signature still means nothing without `email_verified` (provider-level gate).
    const unverified = makeToken({
      signingKey: pair.privateKey,
      claims: { email_verified: false },
    });
    const result = await check(unverified, keys);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(GOOGLE.emailFromClaims(result.claims, STUB_DOC)).toBeNull();
    }
  });
});
