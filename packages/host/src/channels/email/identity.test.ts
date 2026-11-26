import { describe, expect, it } from "vitest";
import { matchAllowlist, normalizeAllowlistPattern, patternMatches, senderAddressOf } from "./identity";

describe("senderAddressOf", () => {
  it("extracts the address from display-name and bare forms", () => {
    expect(senderAddressOf("Jane Doe <Jane@Example.COM>")).toBe("jane@example.com");
    expect(senderAddressOf("<jane@example.com>")).toBe("jane@example.com");
    expect(senderAddressOf("jane@example.com")).toBe("jane@example.com");
    expect(senderAddressOf("not an address")).toBeNull();
    expect(senderAddressOf(undefined)).toBeNull();
  });
});

describe("normalizeAllowlistPattern", () => {
  it("accepts full addresses and domains only", () => {
    expect(normalizeAllowlistPattern("Person@X.com")).toBe("person@x.com");
    expect(normalizeAllowlistPattern("@x.com")).toBe("@x.com");
    expect(normalizeAllowlistPattern("*@x.com")).toBe("@x.com");
    expect(normalizeAllowlistPattern("x.com")).toBe("");
    expect(normalizeAllowlistPattern("*")).toBe("");
    expect(normalizeAllowlistPattern(42)).toBe("");
  });
});

describe("patternMatches", () => {
  it("matches an exact address or any address on a domain", () => {
    expect(patternMatches("person@x.com", "person@x.com")).toBe(true);
    expect(patternMatches("person@x.com", "other@x.com")).toBe(false);
    expect(patternMatches("@x.com", "anyone@x.com")).toBe(true);
    expect(patternMatches("@x.com", "anyone@y.com")).toBe(false);
    // A domain pattern does not match a subdomain or a bare-domain address.
    expect(patternMatches("@x.com", "a@sub.x.com")).toBe(false);
    expect(patternMatches("@x.com", "x.com@x.com")).toBe(true); // local part is "x.com" — an address, fine
    expect(patternMatches("@x.com", "@x.com")).toBe(false);
  });
});

describe("matchAllowlist", () => {
  it("returns the first admitting row or null", () => {
    const entries = [
      { id: "1", channelId: "c", pattern: "@x.com", userId: null },
      { id: "2", channelId: "c", pattern: "exact@y.com", userId: "u2" },
    ];
    expect(matchAllowlist(entries, "a@x.com")?.id).toBe("1");
    expect(matchAllowlist(entries, "exact@y.com")?.userId).toBe("u2");
    expect(matchAllowlist(entries, "nobody@z.com")).toBeNull();
  });
});
