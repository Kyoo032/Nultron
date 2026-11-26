/**
 * The ID-token verifier, in the idiom of `src/jwt/sign.ts`'s `verifyAccessToken`: parse the three
 * segments, decide the algorithm BEFORE any key is touched (so `alg:none` and the HS* family can
 * never reach a key lookup), verify RS256 over the signing input with `node:crypto`, then run the
 * claims checks -- iss, aud, exp, iat, nonce.
 *
 * The key is a JWK turned into a `KeyObject` by `createPublicKey({ key: jwk, format: "jwk" })`,
 * exactly the interface the spec freezes; there is no `jose` and no `openid-client`.
 */
import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import type { JsonWebKey, KeyObject } from "node:crypto";
import type { OidcProvider } from "./providers";

const CLOCK_SKEW_SECONDS = 120;
/** A bound on how far in the past an `iat` may sit: the round trip is minutes, not days. */
const MAX_IAT_AGE_SECONDS = 24 * 3600;
const MAX_SEGMENT_LENGTH = 8192;
const MAX_CLAIMS_BYTES = 16_384;

export type IdTokenFailure =
  | "malformed"
  | "alg_refused"
  | "unknown_kid"
  | "bad_signature"
  | "iss"
  | "aud"
  | "exp"
  | "iat"
  | "nonce"
  | "claims";

export type IdTokenResult =
  | { readonly ok: true; readonly claims: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly reason: IdTokenFailure };

export interface VerifyIdTokenInput {
  readonly provider: OidcProvider;
  readonly expectedNonceHash: Buffer;
  readonly expectedAudience: string;
  readonly nowSeconds: number;
}

function b64url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length > MAX_SEGMENT_LENGTH * 2) {
    return null;
  }
  return Buffer.from(value, "base64url");
}

function json(b64: string): Record<string, unknown> | null {
  const bytes = b64url(b64);
  if (!bytes || bytes.length > MAX_CLAIMS_BYTES) {
    return null;
  }
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function verifyIdToken(
  token: string,
  input: VerifyIdTokenInput,
  keyForKid: (kid: string) => Promise<JsonWebKey | null>,
): Promise<IdTokenResult> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0 || part.length > MAX_SEGMENT_LENGTH)) {
    return { ok: false, reason: "malformed" };
  }
  const header = json(parts[0]);
  const claims = json(parts[1]);
  const signature = b64url(parts[2]);
  if (!header || !claims || !signature) {
    return { ok: false, reason: "malformed" };
  }

  // The algorithm decision comes first. `alg` absent, `none`, or anything outside the single
  // allowed value is refused before `kid` is even read, so there is no confusion path and no
  // HS-vs-RS downgrade: an HMAC against the public key would verify nowhere because the key is
  // fetched as an RSA JWK, and the header is bound into the check anyway.
  if (header.alg !== "RS256") {
    return { ok: false, reason: "alg_refused" };
  }
  const kid = header.kid;
  if (typeof kid !== "string" || kid.length === 0 || kid.length > 256) {
    return { ok: false, reason: "unknown_kid" };
  }
  const jwk = await keyForKid(kid);
  if (!jwk) {
    return { ok: false, reason: "unknown_kid" };
  }

  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    return { ok: false, reason: "unknown_kid" };
  }
  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, "ascii");
  const verified = cryptoVerify("RSA-SHA256", signingInput, publicKey, signature);
  if (!verified) {
    return { ok: false, reason: "bad_signature" };
  }

  // Signature first, claims second: an unauthenticated token's claims are attacker prose and are
  // read only after the signature says they are the provider's.
  const iss = claims.iss;
  if (typeof iss !== "string" || !input.provider.issuerOk(iss, claims)) {
    return { ok: false, reason: "iss" };
  }
  const aud = claims.aud;
  const audOk =
    typeof aud === "string"
      ? aud === input.expectedAudience
      : Array.isArray(aud) && aud.includes(input.expectedAudience);
  if (!audOk) {
    return { ok: false, reason: "aud" };
  }
  const exp = claims.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp + CLOCK_SKEW_SECONDS <= input.nowSeconds) {
    return { ok: false, reason: "exp" };
  }
  const iat = claims.iat;
  if (
    typeof iat !== "number" ||
    !Number.isFinite(iat) ||
    iat - CLOCK_SKEW_SECONDS > input.nowSeconds ||
    input.nowSeconds - iat > MAX_IAT_AGE_SECONDS
  ) {
    return { ok: false, reason: "iat" };
  }
  const nonce = claims.nonce;
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 512) {
    return { ok: false, reason: "nonce" };
  }
  const nonceHash = createHash("sha256").update(nonce, "utf8").digest();
  if (nonceHash.length !== input.expectedNonceHash.length || !timingSafeEqual(nonceHash, input.expectedNonceHash)) {
    return { ok: false, reason: "nonce" };
  }
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    return { ok: false, reason: "claims" };
  }
  return { ok: true, claims };
}
