import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  wrappingKeyFromSecret,
  encryptJson,
  decryptJson,
  isEnvelope,
  sealPayload,
  openPayload,
  openPayloadWithKeys,
  type EncryptedEnvelope,
} from "./envelope";

describe("wrappingKeyFromSecret", () => {
  it("returns a 32-byte Buffer", () => {
    const key = wrappingKeyFromSecret("my-secret");
    expect(key).toBeInstanceOf(Buffer);
    expect(key.byteLength).toBe(32);
  });

  it("is deterministic — same input, same key", () => {
    const a = wrappingKeyFromSecret("stable-secret");
    const b = wrappingKeyFromSecret("stable-secret");
    expect(a.equals(b)).toBe(true);
  });

  it("different secrets produce different keys", () => {
    const a = wrappingKeyFromSecret("secret-a");
    const b = wrappingKeyFromSecret("secret-b");
    expect(a.equals(b)).toBe(false);
  });
});

describe("encryptJson / decryptJson", () => {
  const key = wrappingKeyFromSecret("test-key");

  it("round-trips a plain object", () => {
    const value = { hello: 1, nested: { arr: [1, 2, 3] } };
    const envelope = encryptJson(value, key);
    const result = decryptJson<typeof value>(envelope, key);
    expect(result).toEqual(value);
  });

  it("produces an envelope with the correct shape", () => {
    const envelope = encryptJson({ x: 1 }, key);
    expect(envelope.v).toBe(1);
    expect(envelope.alg).toBe("aes-256-gcm");
    expect(typeof envelope.n).toBe("string");
    expect(typeof envelope.ct).toBe("string");
    expect(typeof envelope.tag).toBe("string");
  });

  it("n is 16 chars (12-byte IV as base64)", () => {
    const envelope = encryptJson({ x: 1 }, key);
    const ivBytes = Buffer.from(envelope.n, "base64");
    expect(ivBytes.byteLength).toBe(12);
  });

  it("throws on tampered ciphertext", () => {
    const envelope = encryptJson({ secret: "value" }, key);
    const tampered: EncryptedEnvelope = { ...envelope, ct: "AAAA" + envelope.ct.slice(4) };
    expect(() => decryptJson(tampered, key)).toThrow();
  });

  it("throws on tampered auth tag", () => {
    const envelope = encryptJson({ secret: "value" }, key);
    const flipped = envelope.tag.split("").reverse().join("");
    const tampered: EncryptedEnvelope = { ...envelope, tag: flipped };
    expect(() => decryptJson(tampered, key)).toThrow();
  });

  it("throws when wrong key is used", () => {
    const wrongKey = wrappingKeyFromSecret("wrong-key");
    const envelope = encryptJson({ data: "sensitive" }, key);
    expect(() => decryptJson(envelope, wrongKey)).toThrow();
  });

  it("each encryption produces a unique nonce (fresh IV)", () => {
    const value = { x: 1 };
    const a = encryptJson(value, key);
    const b = encryptJson(value, key);
    expect(a.n).not.toBe(b.n);
  });
});

describe("isEnvelope", () => {
  const key = wrappingKeyFromSecret("test-key");

  it("returns true for a valid envelope", () => {
    const env = encryptJson({ a: 1 }, key);
    expect(isEnvelope(env)).toBe(true);
  });

  it("returns false for plain objects", () => {
    expect(isEnvelope({ hello: 1 })).toBe(false);
    expect(isEnvelope(null)).toBe(false);
    expect(isEnvelope("string")).toBe(false);
    expect(isEnvelope(42)).toBe(false);
    expect(isEnvelope(undefined)).toBe(false);
  });

  it("returns false for objects missing required fields", () => {
    expect(isEnvelope({ v: 1 })).toBe(false);
    expect(isEnvelope({ v: 1, alg: "aes-256-gcm" })).toBe(false);
    expect(isEnvelope({ v: 2, alg: "aes-256-gcm", n: "x", ct: "y", tag: "z" })).toBe(false);
  });
});

describe("sealPayload / openPayload", () => {
  const key = wrappingKeyFromSecret("seal-key");

  it("round-trips through seal/open", () => {
    const value = { prompt: "Hello world", model: "gpt-4o" };
    const sealed = sealPayload(value, key);
    expect(isEnvelope(sealed)).toBe(true);
    const opened = openPayload<typeof value>(sealed, key);
    expect(opened).toEqual(value);
  });

  it("openPayload reads plaintext value as backward-compat", () => {
    const plaintext = { hello: 1 };
    const result = openPayload<typeof plaintext>(plaintext, key);
    expect(result).toEqual(plaintext);
  });

  it("openPayload handles a primitive plaintext string", () => {
    const result = openPayload<string>("plain text", key);
    expect(result).toBe("plain text");
  });

  it("keeps exact v:1 envelope shape without kid when options are omitted", () => {
    const sealed = sealPayload({ ok: true }, key);
    expect(Object.keys(sealed).sort()).toEqual(["alg", "ct", "n", "tag", "v"]);
    expect("kid" in sealed).toBe(false);
  });

  it("opens a legacy v:1 envelope constructed without aad or kid", () => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify({ legacy: 42 }), "utf8")), cipher.final()]);
    const legacy: EncryptedEnvelope = {
      v: 1,
      alg: "aes-256-gcm",
      n: iv.toString("base64"),
      ct: ct.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
    expect(isEnvelope(legacy)).toBe(true);
    expect(openPayload<{ legacy: number }>(legacy, key)).toEqual({ legacy: 42 });
  });

  it("binds GCM AAD and rejects missing or mismatched AAD", () => {
    const sealed = sealPayload({ secret: "bound" }, key, { aad: "tenant:t1:threads" });
    expect(openPayload<{ secret: string }>(sealed, key, { aad: "tenant:t1:threads" })).toEqual({ secret: "bound" });
    expect(() => openPayload(sealed, key)).toThrow();
    expect(() => openPayload(sealed, key, { aad: "tenant:t2:threads" })).toThrow();
  });

  it("records optional kid and validates kid type in isEnvelope", () => {
    const sealed = sealPayload({ v: "k" }, key, { kid: "key-2026-11" });
    expect(sealed.kid).toBe("key-2026-11");
    expect(isEnvelope(sealed)).toBe(true);
    expect(isEnvelope({ ...sealed, kid: 123 })).toBe(false);
    expect(openPayload<{ v: string }>(sealed, key)).toEqual({ v: "k" });
  });
});

describe("openPayloadWithKeys", () => {
  const k1 = wrappingKeyFromSecret("rotation-key-1");
  const k2 = wrappingKeyFromSecret("rotation-key-2");
  const k3 = wrappingKeyFromSecret("rotation-key-3");

  it("opens envelopes sealed with any key in the candidate list", () => {
    const sealedOld = sealPayload({ msg: "old" }, k1);
    const sealedNew = sealPayload({ msg: "new" }, k2);

    expect(openPayloadWithKeys<{ msg: string }>(sealedOld, [k2, k1])).toEqual({ msg: "old" });
    expect(openPayloadWithKeys<{ msg: string }>(sealedNew, [k2, k1])).toEqual({ msg: "new" });
  });

  it("prefers matching kid from keyRing before trying other keys", () => {
    const sealed = sealPayload({ msg: "ring" }, k2, { kid: "k2", aad: "scope:inbox" });
    // Even with wrong/decoy key under a different kid listed first, matching kid selects k2 first
    const opened = openPayloadWithKeys<{ msg: string }>(sealed, [k1], {
      aad: "scope:inbox",
      keyRing: [
        { kid: "k1", key: k1 },
        { kid: "k2", key: k2 },
      ],
    });
    expect(opened).toEqual({ msg: "ring" });
  });

  it("prefers matching kid from KeyRingEntry[] passed directly in keys", () => {
    const sealed = sealPayload({ msg: "direct-ring" }, k2, { kid: "k2" });
    // Also falls back to other candidates if matching kid key does not decrypt
    const opened = openPayloadWithKeys<{ msg: string }>(sealed, [
      { kid: "k1", key: k1 },
      { kid: "k2", key: k2 },
    ]);
    expect(opened).toEqual({ msg: "direct-ring" });

    const mislabeled = sealPayload({ msg: "fallback" }, k3, { kid: "k2" });
    expect(
      openPayloadWithKeys<{ msg: string }>(mislabeled, [
        { kid: "k1", key: k1 },
        { kid: "k2", key: k2 },
        k3,
      ]),
    ).toEqual({ msg: "fallback" });
  });

  it("passes through legacy plaintext and throws when no key matches or list is empty", () => {
    expect(openPayloadWithKeys("legacy-text", [])).toBe("legacy-text");
    const sealed = sealPayload({ msg: "locked" }, k1, { aad: "ctx" });
    expect(() => openPayloadWithKeys(sealed, [k2, k3], { aad: "ctx" })).toThrow();
    expect(() => openPayloadWithKeys(sealed, [k1], { aad: "wrong-ctx" })).toThrow();
    expect(() => openPayloadWithKeys(sealed, [])).toThrow();
  });
});
