import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPiiVault } from "./pii-vault";

function flipChar(segment: string): string {
  const first = segment[0] === "A" ? "B" : "A";
  return `${first}${segment.slice(1)}`;
}

describe("createPiiVault", () => {
  const key = randomBytes(32);

  it("replaces PII with deterministic numbered tokens and round-trips cleanly", () => {
    const vault = createPiiVault({ key, aad: { tenantId: "tenant-1", runId: "run-1" } });
    const original =
      "Kirim ke Rina Wijaya di rina@example.com, CC alex@example.com dan rina@example.com, NIK 3273010101900001, HP 081234567890.";

    const { masked, sealedMap, count } = vault.mask(original);
    expect(count).toBe(6);
    expect(masked).toBe(
      "Kirim ke [name#1] di [email#1], CC [email#2] dan [email#1], NIK [nik#1], HP [phone#1].",
    );
    expect(masked).not.toContain("Rina Wijaya");
    expect(masked).not.toContain("rina@example.com");
    expect(masked).not.toContain("3273010101900001");
    expect(sealedMap).not.toContain("Rina Wijaya");
    expect(sealedMap).not.toContain("rina@example.com");

    expect(vault.unmask(masked, sealedMap)).toBe(original);
  });

  it("keeps deterministic token assignments across calls in a session", () => {
    const vault = createPiiVault({ key, aad: "session-1" });
    const first = vault.mask("Contact Alex Rivera at alex@example.com");
    const second = vault.mask("Forward to alex@example.com and bob@example.com");

    expect(first.masked).toBe("Contact [name#1] at [email#1]");
    expect(second.masked).toBe("Forward to [email#1] and [email#2]");

    const rehydrated = vault.unmask("Sent [name#1] ([email#1]) and [email#2]", second.sealedMap);
    expect(rehydrated).toBe("Sent Alex Rivera (alex@example.com) and bob@example.com");
  });

  it("does not double-expand tokens when an original value contains token-like text", () => {
    const vault = createPiiVault({ key });
    const text = "Email [email#2]@example.com and bob@example.com";
    const { masked, sealedMap } = vault.mask(text);
    expect(vault.unmask(masked, sealedMap)).toBe(text);
    expect(vault.unmask("Unknown [email#99] and [email]", sealedMap)).toBe("Unknown [email#99] and [email]");
  });

  it("handles clean text with count 0 and still enforces key/AAD authentication", () => {
    const vault = createPiiVault({ key, aad: { tenantId: "t1", runId: "r1" } });
    const otherAadVault = createPiiVault({ key, aad: { tenantId: "t2", runId: "r1" } });
    const clean = "Revenue grew 14% in Q1 2026.";
    const res = vault.mask(clean);
    expect(res.count).toBe(0);
    expect(res.masked).toBe(clean);
    expect(vault.unmask(res.masked, res.sealedMap)).toBe(clean);
    expect(() => otherAadVault.unmask(res.masked, res.sealedMap)).toThrow();
  });

  it("rejects tampered ciphertext, tag, iv, or malformed sealedMap", () => {
    const vault = createPiiVault({ key, aad: { tenantId: "t1", runId: "r1" } });
    const { masked, sealedMap } = vault.mask("Contact alex@example.com");
    const [v = "", iv = "", ct = "", tag = ""] = sealedMap.split(".");

    expect(() => vault.unmask(masked, `${v}.${flipChar(iv)}.${ct}.${tag}`)).toThrow();
    expect(() => vault.unmask(masked, `${v}.${iv}.${flipChar(ct)}.${tag}`)).toThrow();
    expect(() => vault.unmask(masked, `${v}.${iv}.${ct}.${flipChar(tag)}`)).toThrow();
    expect(() => vault.unmask(masked, "v2.aa.bb.cc")).toThrow();
    expect(() => vault.unmask(masked, "not-a-sealed-map")).toThrow();
  });

  it("rejects wrong AAD (cross-tenant or cross-run ciphertext swap)", () => {
    const tenantARun1 = createPiiVault({ key, aad: { tenantId: "tenant-a", runId: "run-1" } });
    const tenantBRun1 = createPiiVault({ key, aad: { tenantId: "tenant-b", runId: "run-1" } });
    const tenantARun2 = createPiiVault({ key, aad: { tenantId: "tenant-a", runId: "run-2" } });
    const noAad = createPiiVault({ key });

    const { masked, sealedMap } = tenantARun1.mask("Contact alex@example.com");
    expect(() => tenantBRun1.unmask(masked, sealedMap)).toThrow();
    expect(() => tenantARun2.unmask(masked, sealedMap)).toThrow();
    expect(() => noAad.unmask(masked, sealedMap)).toThrow();
  });

  it("rejects wrong key", () => {
    const vaultA = createPiiVault({ key: "secret-key-alpha", aad: { tenantId: "t1", runId: "r1" } });
    const vaultB = createPiiVault({ key: "secret-key-bravo", aad: { tenantId: "t1", runId: "r1" } });

    const { masked, sealedMap } = vaultA.mask("Contact alex@example.com");
    expect(() => vaultB.unmask(masked, sealedMap)).toThrow();
  });

  it("rejects empty key", () => {
    expect(() => createPiiVault({ key: "" })).toThrow();
    expect(() => createPiiVault({ key: new Uint8Array(0) })).toThrow();
  });
});
