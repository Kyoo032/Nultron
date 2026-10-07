import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CURRENT_SCRYPT,
  MAX_CONCURRENT_DERIVATIONS,
  MAX_VERIFY_MEMORY_BYTES,
  checkPasswordAgainstAccount,
  checkPasswordShape,
  createPasswordHasher,
  generateInitialPassword,
  isValidUsername,
  memoryFor,
  normaliseUsername,
  type PasswordHash,
} from "./index";

// Obviously fake values. Nothing here is, or looks like, a real credential.
const FAKE = "fake-password-for-tests-only";

describe("the scrypt parameters", () => {
  it("are 2^15, 8, 1 with a 32-byte key, which is 32 MiB", () => {
    expect(CURRENT_SCRYPT).toEqual({ n: 32768, r: 8, p: 1, keyLength: 32 });
    expect(memoryFor(CURRENT_SCRYPT)).toBe(32 * 1024 * 1024);
  });
});

describe("hashing", () => {
  const hasher = createPasswordHasher();

  it("verifies the password it hashed and refuses another", async () => {
    const stored = await hasher.hash(FAKE);
    expect(await hasher.verify(FAKE, stored)).toBe(true);
    expect(await hasher.verify(`${FAKE}x`, stored)).toBe(false);
    expect(await hasher.verify("", stored)).toBe(false);
  }, 30_000);

  it("uses a fresh random salt each time, so equal passwords hash differently", async () => {
    const [a, b] = await Promise.all([hasher.hash(FAKE), hasher.hash(FAKE)]);
    expect(a.salt.length).toBe(16);
    expect(a.salt.equals(b.salt)).toBe(false);
    expect(a.hash.equals(b.hash)).toBe(false);
  }, 30_000);

  it("stores the parameters it used beside the hash", async () => {
    const stored = await hasher.hash(FAKE);
    expect(stored.params).toEqual(CURRENT_SCRYPT);
    expect(stored.hash.length).toBe(CURRENT_SCRYPT.keyLength);
  });

  it("checks a hash under the parameters it was made with, and asks for a re-hash", async () => {
    const cheaper = createPasswordHasher({ params: { n: 2 ** 14, r: 8, p: 1, keyLength: 32 } });
    const old = await cheaper.hash(FAKE);
    expect(old.params.n).toBe(2 ** 14);
    // The current hasher still accepts it, which is what lets the cost be raised without a flag day.
    expect(await hasher.verify(FAKE, old)).toBe(true);
    expect(hasher.needsRehash(old)).toBe(true);
    expect(hasher.needsRehash(await hasher.hash(FAKE))).toBe(false);
  }, 30_000);

  it("treats the same text in two Unicode forms as one password", async () => {
    const composed = "café-fake-password";
    const decomposed = "café-fake-password";
    const stored = await hasher.hash(composed);
    expect(await hasher.verify(decomposed, stored)).toBe(true);
  }, 30_000);

  it("refuses, without throwing, a stored hash whose parameters it cannot or must not run", async () => {
    const real = await hasher.hash(FAKE);
    const hostile: PasswordHash = {
      hash: real.hash,
      salt: real.salt,
      params: { n: 2 ** 20, r: 32, p: 16, keyLength: 32 },
    };
    expect(memoryFor(hostile.params)).toBeGreaterThan(MAX_VERIFY_MEMORY_BYTES);
    expect(await hasher.verify(FAKE, hostile)).toBe(false);

    const wrongLength: PasswordHash = { ...real, hash: randomBytes(20) };
    expect(await hasher.verify(FAKE, wrongLength)).toBe(false);
    const notPowerOfTwo: PasswordHash = { ...real, params: { ...real.params, n: 30000 } };
    expect(await hasher.verify(FAKE, notPowerOfTwo)).toBe(false);
  }, 60_000);

  it("runs the dummy derivation for a nonexistent account without a result to leak", async () => {
    await expect(hasher.verifyDummy(FAKE)).resolves.toBeUndefined();
  }, 30_000);
});

describe("the derivation gate", () => {
  it("is eight, and that is the number of sign-in steps that may be deriving at once", () => {
    expect(MAX_CONCURRENT_DERIVATIONS).toBe(8);
  });

  it("admits eight at a time and refuses the ninth until one lets go", () => {
    const hasher = createPasswordHasher();
    const permits = Array.from({ length: MAX_CONCURRENT_DERIVATIONS }, () => hasher.admit());
    expect(permits.every((permit) => permit !== null)).toBe(true);
    expect(hasher.admit()).toBeNull();
    expect(hasher.admit()).toBeNull();

    permits[3]?.release();
    const again = hasher.admit();
    expect(again).not.toBeNull();
    expect(hasher.admit()).toBeNull();
    again?.release();
    for (const permit of permits) {
      permit?.release();
    }
    expect(hasher.admit()).not.toBeNull();
  });

  it("frees a slot once however often it is released, so a double release cannot lift the cap", () => {
    const hasher = createPasswordHasher({ maxInFlight: 2 });
    const first = hasher.admit();
    const second = hasher.admit();
    expect(hasher.admit()).toBeNull();
    first?.release();
    first?.release();
    first?.release();
    expect(hasher.admit()).not.toBeNull();
    // Still full again: the extra releases did not make a third slot.
    expect(hasher.admit()).toBeNull();
    second?.release();
  });

  it("is a gate per hasher, and the derivations themselves do not need a permit to run", async () => {
    const one = createPasswordHasher({ maxInFlight: 1 });
    const other = createPasswordHasher({ maxInFlight: 1 });
    const held = one.admit();
    expect(one.admit()).toBeNull();
    expect(other.admit()).not.toBeNull();
    // The operator's command hashes without one: the gate is the sign-in's, not the hasher's.
    await expect(one.hash(FAKE)).resolves.toBeDefined();
    held?.release();
  }, 30_000);
});

describe("the password policy", () => {
  it("wants 12 to 200 characters, counted as code points", () => {
    expect(checkPasswordShape("a".repeat(11))).toBe("too_short");
    expect(checkPasswordShape("a".repeat(12))).toBeNull();
    expect(checkPasswordShape("a".repeat(200))).toBeNull();
    expect(checkPasswordShape("a".repeat(201))).toBe("too_long");
    // Twelve emoji are twelve characters, though twenty-four UTF-16 units.
    expect(checkPasswordShape("\u{1F600}".repeat(12))).toBeNull();
    expect(checkPasswordShape("\u{1F600}".repeat(11))).toBe("too_short");
  });

  it("refuses a control character, such as the newline of a careless paste", () => {
    expect(checkPasswordShape("a".repeat(12) + String.fromCharCode(10))).toBe("control_characters");
    expect(checkPasswordShape(`${"a".repeat(6)}${String.fromCharCode(0)}${"b".repeat(6)}`)).toBe("control_characters");
    expect(checkPasswordShape(`${"a".repeat(6)} ${"b".repeat(6)}`)).toBeNull();
  });

  it("refuses the person's own username or e-mail, whatever the case", () => {
    const account = { username: "fake.person.name", email: "fake.person@example.test" };
    expect(checkPasswordAgainstAccount("FAKE.PERSON.NAME", account)).toBe("same_as_username");
    expect(checkPasswordAgainstAccount("Fake.Person@Example.Test", account)).toBe("same_as_email");
    expect(checkPasswordAgainstAccount("a different long password", account)).toBeNull();
  });

  it("refuses the password being replaced", () => {
    const account = { username: "fake.person.name", email: "fake.person@example.test", current: FAKE };
    expect(checkPasswordAgainstAccount(FAKE, account)).toBe("same_as_current");
    expect(checkPasswordAgainstAccount(`${FAKE}-2`, account)).toBeNull();
  });
});

describe("usernames", () => {
  it("are 3 to 32 of a-z 0-9 . _ -, starting with a letter or digit, and never hold an @", () => {
    for (const good of ["abc", "a.b-c_d", "0day", "x".repeat(32)]) {
      expect(isValidUsername(good), good).toBe(true);
    }
    for (const bad of ["ab", "x".repeat(33), ".abc", "-abc", "a@b.test", "has space", "UPPER", "café", ""]) {
      expect(isValidUsername(bad), bad).toBe(false);
    }
  });

  it("are compared in lower case with the edges trimmed", () => {
    expect(normaliseUsername("  Fake.Person  ")).toBe("fake.person");
  });
});

describe("the generated initial password", () => {
  it("is 24 characters in five dashed groups from an alphabet with no look-alikes", () => {
    for (let index = 0; index < 50; index += 1) {
      const password = generateInitialPassword();
      expect(password).toMatch(/^[A-HJ-NP-Za-km-np-z2-9]{4}(-[A-HJ-NP-Za-km-np-z2-9]{4}){4}$/);
      expect(password).toHaveLength(24);
      expect(checkPasswordShape(password)).toBeNull();
    }
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateInitialPassword()));
    expect(seen.size).toBe(200);
  });
});
