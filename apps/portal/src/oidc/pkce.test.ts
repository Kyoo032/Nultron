/**
 * `pkce.ts`: the randoms a `start` mints and the S256 the callback must have sent (RFC 7636).
 */
import { describe, expect, it } from "vitest";
import { mintPkce, s256, verifierMatches, verifierWellFormed } from "./pkce";

describe("mintPkce", () => {
  it("mints three independent base64url values", () => {
    const material = mintPkce();
    for (const value of [material.state, material.nonce, material.codeVerifier]) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url, unpadded
    }
    const again = mintPkce();
    expect(again.state).not.toBe(material.state);
    expect(again.nonce).not.toBe(material.nonce);
    expect(again.codeVerifier).not.toBe(material.codeVerifier);
    expect(again.codeChallenge).not.toBe(material.codeChallenge);
  });
});

describe("s256", () => {
  it("reproduces the RFC 7636 appendix B challenge", () => {
    expect(s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("verifierWellFormed", () => {
  it("accepts 43 unreserved characters and refuses anything else", () => {
    const { codeVerifier: verifier } = mintPkce();
    expect(verifierWellFormed(verifier)).toBe(true);
    expect(verifierWellFormed(verifier.slice(1))).toBe(false); // 42 chars, under the 43 minimum
    expect(verifierWellFormed(`${verifier}${verifier}${verifier}`)).toBe(false); // over 128
    expect(verifierWellFormed(`${verifier.slice(0, 42)}=`)).toBe(false); // padding char
    expect(verifierWellFormed("")).toBe(false);
  });
});

describe("verifierMatches", () => {
  it("accepts only the verifier whose S256 is the challenge", () => {
    const { codeVerifier: verifier, codeChallenge: challenge } = mintPkce();
    expect(verifierMatches(verifier, challenge)).toBe(true);
    expect(verifierMatches(mintPkce().codeVerifier, challenge)).toBe(false);
    expect(verifierMatches("short", challenge)).toBe(false);
  });
});
