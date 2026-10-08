/**
 * Hashing and checking a password: `scrypt` from `node:crypto`, and nothing else.
 *
 * No new dependency and no native module: scrypt ships with Node, runs on the libuv thread pool (so
 * the event loop is never blocked by a comparison), and is a memory-hard function that OWASP's
 * password storage guidance lists as an accepted choice.
 *
 * **The cost parameters are stored beside every hash** (`user_credentials.scrypt_n/r/p`, and the key
 * length is the hash's own), which is what makes raising them later an edit to `CURRENT_SCRYPT` and
 * not a migration of every row: a hash made under other parameters is checked under the parameters it
 * was made with, and `needsRehash` tells the caller to write a fresh one once the password has been
 * proved (`flows/password-sign-in.ts`).
 *
 * N = 2^15, r = 8, p = 1 is 32 MiB and about 100 to 150 ms on one core of a modern machine
 * (`docs/internal/portal/device-code-login.md`, "Password sign-in", records the measurement). The
 * point of the cost is the attacker's: a stolen table has to pay it once per guess per account.
 *
 * A password is normalised to NFKC before it is hashed, so the same string typed on two keyboards (a
 * composed and a decomposed accent) is one password. This module does it, so no caller can forget.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export interface ScryptParams {
  /** CPU/memory cost: a power of two. */
  readonly n: number;
  readonly r: number;
  readonly p: number;
  /** Bytes of derived key, which is the length of the stored hash. */
  readonly keyLength: number;
}

/** What every new or re-hashed password is made with. */
export const CURRENT_SCRYPT: ScryptParams = Object.freeze({ n: 2 ** 15, r: 8, p: 1, keyLength: 32 });

export const SALT_BYTES = 16;

/**
 * The most sign-in steps that may be inside a derivation at once.
 *
 * A derivation is 32 MiB and 100 to 150 ms on libuv's thread pool, and that pool (four threads by
 * default) is shared with every DNS lookup and file read the process makes. A post to the sign-in
 * costs one derivation whether the person exists or not, and it costs it before anybody has proved
 * anything, so the sign-in's own rate limits (per source, per identifier) are not enough on their
 * own: a few hundred sources can ask at the same moment. This is the ceiling under them: at most
 * eight steps hold a permit, so at most eight derivations (and 256 MiB) are ever in flight for the
 * sign-in, whoever is asking. A ninth is told to come back (`503`) and has been charged nothing.
 */
export const MAX_CONCURRENT_DERIVATIONS = 8;

/** One sign-in step's place among those eight. `release` is safe to call more than once. */
export interface DerivationPermit {
  release(): void;
}

/**
 * The most memory a stored parameter set may ask a verification for. The database's own CHECKs allow
 * N up to 2^20, and a row written by hand with a huge N would otherwise make every sign-in against it
 * allocate gigabytes. Past this the hash simply does not verify.
 */
export const MAX_VERIFY_MEMORY_BYTES = 256 * 1024 * 1024;

/** A hash and everything needed to check a password against it later. */
export interface PasswordHash {
  readonly hash: Buffer;
  readonly salt: Buffer;
  readonly params: ScryptParams;
}

export interface PasswordHasher {
  /** A fresh random salt every time, and the current parameters. */
  hash(password: string): Promise<PasswordHash>;
  /** Constant-time against the stored hash, under the parameters that hash was made with. */
  verify(password: string, stored: PasswordHash): Promise<boolean>;
  /**
   * The same derivation a real `verify` does, against nothing. For an account that does not exist, is
   * disabled or is locked, so that all of them take as long as a wrong password does and the sign-in
   * is not an oracle for which accounts exist.
   */
  verifyDummy(password: string): Promise<void>;
  /** True when the stored parameters are not the current ones. */
  needsRehash(stored: PasswordHash): boolean;
  /**
   * A place among the at most `MAX_CONCURRENT_DERIVATIONS` sign-in steps that may be deriving, or
   * `null` when they are all taken. The sign-in takes one BEFORE it counts an attempt against anybody
   * and holds it until its last derivation is done, so a refusal for want of one costs the person
   * nothing and says nothing about any account; real and dummy comparisons are held to it alike.
   * `hash`, `verify` and `verifyDummy` do not take one themselves: the operator's own command, which
   * is not a sign-in and runs in its own process, hashes without it.
   */
  admit(): DerivationPermit | null;
}

export function memoryFor(params: ScryptParams): number {
  return 128 * params.n * params.r;
}

export function paramsEqual(a: ScryptParams, b: ScryptParams): boolean {
  return a.n === b.n && a.r === b.r && a.p === b.p && a.keyLength === b.keyLength;
}

/** What `crypto.scrypt` will accept, so a bad row is a refusal here and not an exception later. */
function paramsUsable(params: ScryptParams): boolean {
  return (
    Number.isInteger(params.n) &&
    params.n >= 2 &&
    (params.n & (params.n - 1)) === 0 &&
    Number.isInteger(params.r) &&
    params.r >= 1 &&
    Number.isInteger(params.p) &&
    params.p >= 1 &&
    Number.isInteger(params.keyLength) &&
    params.keyLength >= 16 &&
    memoryFor(params) <= MAX_VERIFY_MEMORY_BYTES
  );
}

export function normalisePassword(password: string): string {
  return password.normalize("NFKC");
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(normalisePassword(password), "utf8"),
      salt,
      params.keyLength,
      // `maxmem` is checked against 128 * N * r by Node, so it has to be above that to run at all.
      { N: params.n, r: params.r, p: params.p, maxmem: memoryFor(params) * 2 + 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

export interface PasswordHasherOptions {
  /** Test seam only: a suite that is not about cost may not pay it. Production never passes this. */
  readonly params?: ScryptParams;
  /** Test seam only: `MAX_CONCURRENT_DERIVATIONS` unless a suite is about the gate. */
  readonly maxInFlight?: number;
}

export function createPasswordHasher(options: PasswordHasherOptions = {}): PasswordHasher {
  const current = options.params ?? CURRENT_SCRYPT;
  const maxInFlight = Math.max(1, Math.floor(options.maxInFlight ?? MAX_CONCURRENT_DERIVATIONS));
  let permitsHeld = 0;
  // Fixed for the life of the process, so the dummy derivation costs exactly what a real one does.
  const dummySalt = randomBytes(SALT_BYTES);
  const dummyTarget = randomBytes(current.keyLength);

  return Object.freeze({
    admit(): DerivationPermit | null {
      if (permitsHeld >= maxInFlight) {
        return null;
      }
      permitsHeld += 1;
      let released = false;
      return Object.freeze({
        release(): void {
          if (!released) {
            released = true;
            permitsHeld -= 1;
          }
        },
      });
    },

    async hash(password: string): Promise<PasswordHash> {
      const salt = randomBytes(SALT_BYTES);
      const hash = await derive(password, salt, current);
      return Object.freeze({ hash, salt, params: current });
    },

    async verify(password: string, stored: PasswordHash): Promise<boolean> {
      if (!paramsUsable(stored.params) || stored.hash.length !== stored.params.keyLength) {
        // Not a hash this process can check. Pay the same cost a real comparison would, and refuse.
        await derive(password, dummySalt, current);
        return false;
      }
      const derived = await derive(password, stored.salt, stored.params);
      return derived.length === stored.hash.length && timingSafeEqual(derived, stored.hash);
    },

    async verifyDummy(password: string): Promise<void> {
      const derived = await derive(password, dummySalt, current);
      // Compared and discarded, so the work cannot be optimised away and the shape matches `verify`.
      timingSafeEqual(derived, dummyTarget);
    },

    needsRehash(stored: PasswordHash): boolean {
      return !paramsEqual(stored.params, current);
    },
  });
}
