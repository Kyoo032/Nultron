import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrappingKeyFromSecret } from "@agentforge/core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  getLocalVaultKey,
  hasKeyLikeVariety,
  MASTER_KEY_FILE,
  MASTER_KEY_FILE_UNUSABLE,
  MIN_DISTINCT_KEY_BYTES,
  MIN_VAULT_KEY_BYTES,
  SERVER_VAULT_KEY_NOT_RANDOM,
  SERVER_VAULT_KEY_TOO_WEAK,
  sqliteFilePath,
  vaultKeyEntropyBytes,
} from "./vault-key";

const original = process.env.DATABASE_URL;

const tempDirs: string[] = [];

/** A throwaway data dir per test, injected through `env` so `process.env` is never touched. */
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentforge-vault-key-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  if (original === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = original;
  }
});

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("sqliteFilePath", () => {
  it("rejects leftover Postgres URLs", () => {
    process.env.DATABASE_URL = "postgres://agentforge:agentforge@127.0.0.1:5432/agentforge";
    expect(() => sqliteFilePath()).toThrow(/Postgres is not supported|no longer the product database/i);
  });

  it("reads file: URLs", () => {
    process.env.DATABASE_URL = "file:/tmp/agentforge-test.sqlite";
    expect(sqliteFilePath()).toBe("/tmp/agentforge-test.sqlite");
  });
});

describe("vaultKeyEntropyBytes", () => {
  it("measures the two formats this code has always accepted", () => {
    expect(vaultKeyEntropyBytes("a".repeat(64))).toBe(32);
    expect(vaultKeyEntropyBytes(Buffer.alloc(32, 7).toString("base64"))).toBe(32);
    expect(vaultKeyEntropyBytes(Buffer.alloc(48, 7).toString("base64url"))).toBe(48);
  });

  it("measures anything else as no entropy at all", () => {
    expect(vaultKeyEntropyBytes("")).toBe(0);
    expect(vaultKeyEntropyBytes("   ")).toBe(0);
    expect(vaultKeyEntropyBytes("correct horse battery staple")).toBe(0);
    expect(vaultKeyEntropyBytes("a".repeat(30))).toBeLessThan(MIN_VAULT_KEY_BYTES);
  });

  it("measures what `openssl rand` actually produces, in each of the three encodings", () => {
    const key = randomBytes(32);
    expect(vaultKeyEntropyBytes(key.toString("hex"))).toBe(32);
    expect(vaultKeyEntropyBytes(key.toString("hex").toUpperCase())).toBe(32);
    expect(vaultKeyEntropyBytes(key.toString("base64"))).toBe(32);
    expect(vaultKeyEntropyBytes(key.toString("base64url"))).toBe(32);
    expect(vaultKeyEntropyBytes(randomBytes(48).toString("base64"))).toBe(48);
  });

  it("measures a short key honestly, so 31 bytes cannot pass for 32", () => {
    const short = randomBytes(31);
    expect(vaultKeyEntropyBytes(short.toString("hex"))).toBe(31);
    expect(vaultKeyEntropyBytes(short.toString("base64"))).toBe(31);
    expect(vaultKeyEntropyBytes(short.toString("base64url"))).toBe(31);
  });

  it("refuses a passphrase that is not a canonical encoding of anything", () => {
    // The hole this closes: `Buffer.from(x, "base64")` will decode almost any string, so a typed
    // passphrase used to measure as "32 bytes of entropy" purely because of its length.
    for (const passphrase of [
      "ThisIsMyPassphraseForTheAgentForgeVaultKey1",
      "correcthorsebatterystaplecorrecthorsebatter",
      "MySuperSecretPassphraseThatIsNotAKeyAtAll12",
      "hunter2hunter2hunter2hunter2hunter2hunter2h",
      "correct horse battery staple correct horse!!",
    ]) {
      expect(passphrase.length).toBeGreaterThanOrEqual(43);
      expect(vaultKeyEntropyBytes(passphrase)).toBe(0);
    }
  });

  it("refuses base64 with trailing bits no encoder would have left set", () => {
    const canonical = randomBytes(32).toString("base64");
    expect(vaultKeyEntropyBytes(canonical)).toBe(32);
    // Same length, same alphabet, but the last character carries bits the decoder throws away.
    const mangled = `${canonical.slice(0, 42)}B=`;
    expect(vaultKeyEntropyBytes(mangled)).toBe(0);
  });

  it("refuses hex with an odd digit, which is not hex at all", () => {
    expect(vaultKeyEntropyBytes("a".repeat(65))).toBe(0);
  });

  it("reads a hex-shaped string as hex, so 44 hex digits is 22 bytes and far too few", () => {
    expect(vaultKeyEntropyBytes("a".repeat(44))).toBe(22);
    expect(vaultKeyEntropyBytes("a".repeat(44))).toBeLessThan(MIN_VAULT_KEY_BYTES);
  });

  it("KNOWN LIMIT: a passphrase that is canonical base64 of 32 bytes cannot be told from a key", () => {
    // Nothing syntactic separates these from a generator's output — they *are* valid encodings of
    // 32 and 33 random-looking bytes. Everything malformed is refused above; closing this last case
    // would mean hex only, at the cost of the base64 a secrets manager hands out.
    expect(vaultKeyEntropyBytes("ThisIsMyPassphraseForTheAgentForgeVaultKey0")).toBe(32);
    expect(vaultKeyEntropyBytes("ThisIsMyPassphraseForTheAgentForgeVaultKey01")).toBe(33);
  });
});

describe("getLocalVaultKey in server mode", () => {
  const HEX_KEY = "b".repeat(64);

  function serverEnv(patch: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    return { AGENTFORGE_SERVER: "1", AGENTFORGE_DATA_DIR: dataDir(), ...patch };
  }

  it("refuses to invent a .master-key file and names the variable to set", () => {
    const dir = dataDir();
    expect(() => getLocalVaultKey(serverEnv())).toThrow(/AGENTFORGE_SECRETS_KEY/);
    expect(existsSync(join(dir, ".master-key"))).toBe(false);
  });

  it("refuses a key with less than 32 bytes of entropy, and writes no file", () => {
    const dir = dataDir();
    expect(() => getLocalVaultKey(serverEnv({ AGENTFORGE_SECRETS_KEY: "hunter2" }))).toThrow(/32 bytes/);
    expect(() => getLocalVaultKey(serverEnv({ AGENTFORGE_SECRETS_KEY: "a".repeat(40) }))).toThrow(/32 bytes/);
    expect(existsSync(join(dir, ".master-key"))).toBe(false);
  });

  it("refuses a passphrase, however long, with the too-weak message", () => {
    const dir = dataDir();
    for (const passphrase of [
      "correct horse battery staple correct horse!!",
      "ThisIsMyPassphraseForTheAgentForgeVaultKey1",
      "hunter2hunter2hunter2hunter2hunter2hunter2h",
    ]) {
      expect(() => getLocalVaultKey(serverEnv({ AGENTFORGE_SECRETS_KEY: passphrase }))).toThrow(
        SERVER_VAULT_KEY_TOO_WEAK,
      );
    }
    expect(existsSync(join(dir, ".master-key"))).toBe(false);
  });

  it("refuses a real but short key in either encoding", () => {
    const short = randomBytes(31);
    for (const encoded of [short.toString("hex"), short.toString("base64"), short.toString("base64url")]) {
      expect(() => getLocalVaultKey(serverEnv({ AGENTFORGE_SECRETS_KEY: encoded }))).toThrow(SERVER_VAULT_KEY_TOO_WEAK);
    }
  });

  it("accepts what a secrets manager hands out: hex, base64 and base64url", () => {
    const key = randomBytes(32);
    for (const encoded of [key.toString("hex"), key.toString("base64"), key.toString("base64url")]) {
      expect(getLocalVaultKey(serverEnv({ AGENTFORGE_SECRETS_KEY: encoded }))).toEqual(wrappingKeyFromSecret(encoded));
    }
  });

  it("uses a long enough env key exactly as it always has, in hex or base64", () => {
    const dir = dataDir();
    const hex = randomBytes(32).toString("hex");
    expect(getLocalVaultKey(serverEnv({ AGENTFORGE_SECRETS_KEY: hex }))).toEqual(wrappingKeyFromSecret(hex));
    const b64 = randomBytes(32).toString("base64");
    expect(getLocalVaultKey(serverEnv({ AGENTFORGE_SECRETS_KEY: ` ${b64} ` }))).toEqual(wrappingKeyFromSecret(b64));
    expect(existsSync(join(dir, ".master-key"))).toBe(false);
  });

  /**
   * The length check measures the ENCODING, so a typed pattern of the right length used to pass it.
   * `wrappingKeyFromSecret` is an unsalted SHA-256, so a guessable input is a guessable AES key for
   * every envelope on the install — which is the whole point of demanding a generated one.
   */
  it("refuses a key that is the right length but plainly a typed pattern", () => {
    const dir = dataDir();
    for (const pattern of [
      HEX_KEY, // "bbbb…" — one distinct byte
      "0".repeat(64),
      "deadbeef".repeat(8), // four distinct bytes, repeated
      "0123".repeat(16),
      Buffer.alloc(32, 9).toString("base64"),
      Buffer.alloc(32, 0).toString("base64"),
    ]) {
      expect(vaultKeyEntropyBytes(pattern), pattern).toBeGreaterThanOrEqual(MIN_VAULT_KEY_BYTES);
      expect(() => getLocalVaultKey(serverEnv({ AGENTFORGE_SECRETS_KEY: pattern })), pattern).toThrow(
        SERVER_VAULT_KEY_NOT_RANDOM,
      );
    }
    expect(existsSync(join(dir, ".master-key"))).toBe(false);
  });

  it("never refuses a real generated key as a pattern", () => {
    // 32 uniform bytes hold ~31 distinct values; the floor is 12, so this can only fail if the
    // check is wrong. A hundred draws would catch a threshold set anywhere near the distribution.
    for (let i = 0; i < 100; i += 1) {
      const key = randomBytes(32);
      expect(hasKeyLikeVariety(key)).toBe(true);
      expect(() => getLocalVaultKey(serverEnv({ AGENTFORGE_SECRETS_KEY: key.toString("hex") }))).not.toThrow();
    }
  });
});

describe("hasKeyLikeVariety", () => {
  it("counts distinct byte values, not length", () => {
    expect(hasKeyLikeVariety(Buffer.alloc(32, 1))).toBe(false);
    expect(hasKeyLikeVariety(Buffer.from(Array.from({ length: 32 }, (_, i) => i % 4)))).toBe(false);
    expect(hasKeyLikeVariety(Buffer.from(Array.from({ length: 32 }, (_, i) => i % MIN_DISTINCT_KEY_BYTES)))).toBe(true);
    expect(hasKeyLikeVariety(Buffer.alloc(0))).toBe(false);
  });

  it("sits well below what a generated key carries", () => {
    expect(MIN_DISTINCT_KEY_BYTES).toBeLessThan(20);
    expect(new Set(randomBytes(32)).size).toBeGreaterThan(MIN_DISTINCT_KEY_BYTES);
  });
});

describe("getLocalVaultKey outside server mode", () => {
  it("still creates and reuses the .master-key file", () => {
    const dir = dataDir();
    const env = { AGENTFORGE_DATA_DIR: dir };
    const first = getLocalVaultKey(env);
    expect(existsSync(join(dir, ".master-key"))).toBe(true);
    expect(first).toHaveLength(32);
    expect(getLocalVaultKey(env)).toEqual(first);
  });

  it("derives the wrap key from a passphrase in AGENTFORGE_SECRETS_KEY on a desk exactly as before, and writes no file", () => {
    const dir = dataDir();
    for (const passphrase of [
      "hunter2",
      "correct horse battery staple correct horse!!",
      "phase3-seal-regression-key",
    ]) {
      const env = { AGENTFORGE_DATA_DIR: dir, AGENTFORGE_SECRETS_KEY: passphrase };
      expect(getLocalVaultKey(env), passphrase).toEqual(wrappingKeyFromSecret(passphrase));
    }
    expect(existsSync(join(dir, MASTER_KEY_FILE))).toBe(false);
  });

  it("derives the wrap key from a real but short key on a desk, in either encoding", () => {
    const short = randomBytes(31);
    for (const encoded of [short.toString("hex"), short.toString("base64"), short.toString("base64url")]) {
      const env = { AGENTFORGE_DATA_DIR: dataDir(), AGENTFORGE_SECRETS_KEY: encoded };
      expect(getLocalVaultKey(env)).toEqual(wrappingKeyFromSecret(encoded));
    }
  });

  it("accepts a generated key on a desk in hex, base64 and base64url, and writes no .master-key", () => {
    const key = randomBytes(32);
    for (const encoded of [key.toString("hex"), key.toString("base64"), key.toString("base64url")]) {
      const dir = dataDir();
      const env = { AGENTFORGE_DATA_DIR: dir, AGENTFORGE_SECRETS_KEY: ` ${encoded} ` };
      expect(getLocalVaultKey(env)).toEqual(wrappingKeyFromSecret(encoded));
      expect(existsSync(join(dir, MASTER_KEY_FILE))).toBe(false);
    }
  });

  it("treats a blank AGENTFORGE_SECRETS_KEY as unset and falls back to .master-key", () => {
    for (const blank of ["", "   "]) {
      const dir = dataDir();
      const key = getLocalVaultKey({ AGENTFORGE_DATA_DIR: dir, AGENTFORGE_SECRETS_KEY: blank });
      expect(key).toHaveLength(32);
      expect(existsSync(join(dir, MASTER_KEY_FILE))).toBe(true);
    }
  });

  it("accepts what looks like a key without judging how random it is, which is how the desk fixtures work", () => {
    const patterns = ["d".repeat(64), "0".repeat(64), "password".repeat(8)];
    for (const pattern of patterns) {
      const env = { AGENTFORGE_DATA_DIR: dataDir(), AGENTFORGE_SECRETS_KEY: pattern };
      expect(getLocalVaultKey(env), pattern).toEqual(wrappingKeyFromSecret(pattern));
      expect(() => getLocalVaultKey({ ...env, AGENTFORGE_SERVER: "1" }), pattern).toThrow(SERVER_VAULT_KEY_NOT_RANDOM);
    }
  });

  it("accepts a typed passphrase of 44 base64-alphabet characters, because it is a canonical encoding of 33 bytes", () => {
    const passphrases = [
      "correcthorsebatterystaplecorrecthorsebattery",
      "MyCompanyNultronDeskPasswordForTheOffice2026",
    ];
    for (const passphrase of passphrases) {
      expect(passphrase).toHaveLength(44);
      expect(vaultKeyEntropyBytes(passphrase), passphrase).toBe(33);
      const env = { AGENTFORGE_DATA_DIR: dataDir(), AGENTFORGE_SECRETS_KEY: passphrase };
      expect(getLocalVaultKey(env), passphrase).toEqual(wrappingKeyFromSecret(passphrase));
      expect(getLocalVaultKey({ ...env, AGENTFORGE_SERVER: "1" }), passphrase).toEqual(
        wrappingKeyFromSecret(passphrase),
      );
    }
  });

  /**
   * Only the file's EXISTENCE used to be checked. An empty one made `wrappingKeyFromSecret("")` the
   * wrap key — `SHA-256("")`, a fixed value anyone can compute — and every envelope written after
   * that was sealed with it, silently.
   */
  it("refuses an empty, blank or truncated .master-key instead of deriving a known key", () => {
    for (const contents of ["", "   ", "\n", "abcd", "a".repeat(63), "not a key at all"]) {
      const dir = dataDir();
      writeFileSync(join(dir, MASTER_KEY_FILE), contents, "utf8");
      expect(() => getLocalVaultKey({ AGENTFORGE_DATA_DIR: dir }), JSON.stringify(contents)).toThrow(
        MASTER_KEY_FILE_UNUSABLE,
      );
    }
  });

  it("never derives the SHA-256 of the empty string as a wrapping key", () => {
    const dir = dataDir();
    writeFileSync(join(dir, MASTER_KEY_FILE), "", "utf8");
    const wellKnown = wrappingKeyFromSecret("");
    expect(wellKnown.toString("hex")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(() => getLocalVaultKey({ AGENTFORGE_DATA_DIR: dir })).toThrow();
  });

  it("accepts a .master-key the app itself wrote, and reads it back unchanged", () => {
    const dir = dataDir();
    const written = randomBytes(32).toString("hex");
    writeFileSync(join(dir, MASTER_KEY_FILE), `${written}\n`, "utf8");
    expect(getLocalVaultKey({ AGENTFORGE_DATA_DIR: dir })).toEqual(wrappingKeyFromSecret(written));
  });
});

describe("warnWeakDeskVaultKey", () => {
  const absent = join(tmpdir(), "agentforge-vault-key-never-created");

  async function freshModule() {
    vi.resetModules();
    return import("./vault-key");
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns for a passphrase and a short key, names the variable and the generator, and never prints the value", async () => {
    for (const weak of ["hunter2", randomBytes(31).toString("hex"), randomBytes(31).toString("base64")]) {
      const { warnWeakDeskVaultKey, DESK_VAULT_KEY_WEAK_WARNING } = await freshModule();
      const lines: string[] = [];
      warnWeakDeskVaultKey({ AGENTFORGE_DATA_DIR: absent, AGENTFORGE_SECRETS_KEY: weak }, (line) => lines.push(line));
      expect(lines, weak).toEqual([DESK_VAULT_KEY_WEAK_WARNING]);
      expect(lines[0]).toContain("AGENTFORGE_SECRETS_KEY");
      expect(lines[0]).toContain("guessable");
      expect(lines[0]).toContain("openssl rand -hex 32");
      expect(lines[0]).toContain("cannot open data sealed under the old one");
      expect(lines[0]).not.toContain(weak);
    }
  });

  it("warns once per process however many times it is asked", async () => {
    const { warnWeakDeskVaultKey } = await freshModule();
    const lines: string[] = [];
    const env = { AGENTFORGE_DATA_DIR: absent, AGENTFORGE_SECRETS_KEY: "hunter2" };
    for (let i = 0; i < 5; i += 1) {
      warnWeakDeskVaultKey(env, (line) => lines.push(line));
    }
    expect(lines).toHaveLength(1);
  });

  it("is silent for a usable key, an unset variable and a blank one", async () => {
    const { warnWeakDeskVaultKey } = await freshModule();
    const usable = randomBytes(32).toString("hex");
    const lines: string[] = [];
    for (const value of [usable, ` ${usable} `, undefined, "", "   "]) {
      warnWeakDeskVaultKey({ AGENTFORGE_DATA_DIR: absent, AGENTFORGE_SECRETS_KEY: value }, (line) => lines.push(line));
    }
    expect(lines).toEqual([]);
  });

  it("reads the environment only: no data dir, no .master-key", async () => {
    const { warnWeakDeskVaultKey } = await freshModule();
    warnWeakDeskVaultKey({ AGENTFORGE_DATA_DIR: absent, AGENTFORGE_SECRETS_KEY: "hunter2" }, () => {});
    expect(existsSync(absent)).toBe(false);
  });

  it("stays silent in server mode, where getLocalVaultKey refuses the key instead", async () => {
    const { warnWeakDeskVaultKey, getLocalVaultKey: derive, SERVER_VAULT_KEY_TOO_WEAK: refusal } = await freshModule();
    const lines: string[] = [];
    const env = { AGENTFORGE_SERVER: "1", AGENTFORGE_SECRETS_KEY: "hunter2" };
    warnWeakDeskVaultKey(env, (line) => lines.push(line));
    expect(lines).toEqual([]);
    expect(() => derive(env)).toThrow(refusal);
  });

  it("is what getLocalVaultKey logs on a desk, once, through console.warn", async () => {
    const { getLocalVaultKey: derive } = await freshModule();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = { AGENTFORGE_DATA_DIR: dataDir(), AGENTFORGE_SECRETS_KEY: "hunter2" };
    derive(env);
    derive(env);
    derive(env);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("hunter2");
  });

  it("does not warn when getLocalVaultKey derives a usable desk key", async () => {
    const { getLocalVaultKey: derive } = await freshModule();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    derive({ AGENTFORGE_DATA_DIR: dataDir(), AGENTFORGE_SECRETS_KEY: randomBytes(32).toString("hex") });
    derive({ AGENTFORGE_DATA_DIR: dataDir() });
    expect(warn).not.toHaveBeenCalled();
  });
});
