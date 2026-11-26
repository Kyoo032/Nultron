/**
 * The PKCE round-trip material of an OIDC sign-in, per RFC 7636.
 *
 * `mintPkce` makes the three random values a `start` step needs: `state` and `nonce` (the raw
 * values placed in the authorize URL and expected back from the provider) and `codeVerifier`
 * (the secret the `callback` proves it owns the round trip). `codeChallenge` is the S256
 * transform the provider sees; `verifierMatches` re-checks the same transform at the end.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface PkceMaterial {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly codeChallenge: string;
}

const BASE64URL_ALPHA = /^[A-Za-z0-9_-]{43,128}$/;

export function mintPkce(): PkceMaterial {
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  return { state, nonce, codeVerifier, codeChallenge: s256(codeVerifier) };
}

export function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** A PKCE verifier is 43-128 characters of the unreserved alphabet (RFC 7636 §4.1). */
export function verifierWellFormed(verifier: string): boolean {
  return BASE64URL_ALPHA.test(verifier);
}

export function verifierMatches(verifier: string, challenge: string): boolean {
  if (!verifierWellFormed(verifier)) {
    return false;
  }
  const a = Buffer.from(s256(verifier), "utf8");
  const b = Buffer.from(challenge, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
