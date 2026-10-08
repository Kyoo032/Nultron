/**
 * user_credentials: one scrypt credential per person, and the lockout that guards it
 * (`apps/portal/migrations/0012_password_signin.sql`).
 *
 * This is the half that DECIDES whether an attempt may be made at all. What is said to the person is
 * `flows/password-sign-in.ts`'s, and it says the same thing for every refusal.
 *
 * Three properties are the point:
 *
 *   - **An attempt is counted before the password is compared.** `reserveAttempt` takes the row,
 *     decides whether the account is locked, increments the counter, locks the account when that was
 *     the last attempt allowed, and only then hands the hash to the caller -- all in one short
 *     transaction, with no hashing inside it (a scrypt comparison is ~100 ms, and a transaction that
 *     held a pooled connection that long would let eight guesses stall the whole portal). Because the
 *     count comes first, fifty guesses fired in parallel get five comparisons between them, and the
 *     rest meet a lock. A success then clears the counter (`recordSuccess`).
 *   - **Time is the injected clock's.** Lockout expiry is computed from `now` passed in, never from
 *     the database's `now()`, so a suite moves it with a fake clock and the 15 minutes are a TypeScript
 *     number that is tested rather than a SQL interval that is not.
 *   - **The hash does not leave except to the verifier.** Every other read maps `toCredential`, which
 *     has no field for it.
 *
 * **The lock is not quite a wall (`0013_password_grace.sql`).** A lock that refuses everybody is a free
 * way to keep a named person out. So while an account is locked, a caller that asks for them
 * (`graceAttempts`) may still take up to `PASSWORD_GRACE_ATTEMPTS` more attempts, counted in the same
 * row by the same statement-order rule: charged before the comparison, under `FOR UPDATE`. Who asks is
 * the flow's decision, from an in-process record of which source addresses have failed against which
 * person; this file only keeps the count, and the count is what bounds the guesses:
 *
 *     comparisons per account per window  <=  PASSWORD_MAX_FAILED_ATTEMPTS + PASSWORD_GRACE_ATTEMPTS  =  8
 *
 * whoever asks, from however many addresses, through however many processes, across any restart.
 */
import type { PoolClient } from "pg";
import type { PasswordHash } from "../../password/hash";
import type { PortalOps } from "../types";
import { type Row, freeze, isoOrNull, toCredential, toUser } from "./rows";

/** `user_credentials_attempts_chk` bounds the counter to the same number. */
export const PASSWORD_MAX_FAILED_ATTEMPTS = 5;
export const PASSWORD_LOCK_MS = 15 * 60 * 1000;
/** `user_credentials_grace_attempts_chk` bounds the slots to the same number. */
export const PASSWORD_GRACE_ATTEMPTS = 3;

/** The credential's non-secret columns, aliased so a join with `users` has no ambiguous names. */
const JOINED_COLUMNS = `c.user_id AS c_user_id, c.tenant_id AS c_tenant_id, c.username AS c_username,
  c.must_change AS c_must_change, c.failed_attempts AS c_failed_attempts, c.locked_until AS c_locked_until,
  c.password_changed_at AS c_password_changed_at, c.last_sign_in_at AS c_last_sign_in_at,
  c.created_at AS c_created_at, c.updated_at AS c_updated_at`;

const OWN_COLUMNS = `user_id, tenant_id, username, must_change, failed_attempts, locked_until,
  password_changed_at, last_sign_in_at, created_at, updated_at`;

function first(rows: Row[]): Row | null {
  return rows.length > 0 ? rows[0] : null;
}

/** A hash read back from a row. Not frozen: a `Buffer` cannot be, and the caller only reads it. */
function secretFrom(row: Row): PasswordHash {
  const hash = row.password_hash as Buffer;
  return Object.freeze({
    hash,
    salt: row.password_salt as Buffer,
    params: Object.freeze({
      n: Number(row.scrypt_n),
      r: Number(row.scrypt_r),
      p: Number(row.scrypt_p),
      keyLength: hash.length,
    }),
  });
}

export function credentialsOps(client: PoolClient): PortalOps["credentials"] {
  return {
    async create(input) {
      const { rows } = await client.query<Row>(
        `INSERT INTO user_credentials (user_id, tenant_id, username, password_hash, password_salt,
                                       scrypt_n, scrypt_r, scrypt_p, must_change,
                                       password_changed_at, created_at, updated_at)
         SELECT u.id, u.tenant_id, $2::citext, $3::bytea, $4::bytea,
                $5::integer, $6::integer, $7::integer, $8::boolean,
                $9::timestamptz, $9::timestamptz, $9::timestamptz
           FROM users u WHERE u.id = $1
         ON CONFLICT DO NOTHING
         RETURNING ${OWN_COLUMNS}`,
        [
          input.userId,
          input.username,
          input.secret.hash,
          input.secret.salt,
          input.secret.params.n,
          input.secret.params.r,
          input.secret.params.p,
          input.mustChange ?? true,
          input.now,
        ],
      );
      const row = first(rows);
      return row ? toCredential(row) : null;
    },

    async findByUserId(userId) {
      const { rows } = await client.query<Row>(`SELECT ${OWN_COLUMNS} FROM user_credentials WHERE user_id = $1`, [
        userId,
      ]);
      const row = first(rows);
      return row ? toCredential(row) : null;
    },

    async findAccount(tenantId, identifier) {
      // An address holds an `@` and a username cannot, so which column is never a guess.
      const column = identifier.includes("@") ? "u.email" : "c.username";
      const { rows } = await client.query<Row>(
        `SELECT u.*, ${JOINED_COLUMNS}
           FROM users u JOIN user_credentials c ON c.user_id = u.id
          WHERE u.tenant_id = $1 AND ${column} = $2
          LIMIT 1`,
        [tenantId, identifier],
      );
      const row = first(rows);
      return row ? freeze({ user: toUser(row), credential: toCredential(row, "c_") }) : null;
    },

    async listPeople(tenantId, orgId) {
      const { rows } = await client.query<Row>(
        `SELECT u.*, ${JOINED_COLUMNS}
           FROM users u LEFT JOIN user_credentials c ON c.user_id = u.id
          WHERE u.tenant_id = $1 AND u.org_id = $2
          ORDER BY u.created_at ASC, u.email ASC`,
        [tenantId, orgId],
      );
      return Object.freeze(
        rows.map((row) =>
          freeze({ user: toUser(row), credential: row.c_user_id === null ? null : toCredential(row, "c_") }),
        ),
      );
    },

    async reserveAttempt(input) {
      // The row is held for the length of this transaction, which has no hashing in it: two attempts
      // on one account take turns, and each sees the other's count.
      const { rows } = await client.query<Row>(`SELECT * FROM user_credentials WHERE user_id = $1 FOR UPDATE`, [
        input.userId,
      ]);
      const row = first(rows);
      if (!row) {
        return { kind: "none" };
      }

      const lockedIso = isoOrNull(row.locked_until);
      const lockedUntil = lockedIso === null ? null : new Date(lockedIso);
      if (lockedUntil !== null && lockedUntil > input.now) {
        // Locked. A caller that asked for the slots may still take one, while any are left; every
        // other caller, and one that finds them spent, is refused and counts nothing.
        const slots = Math.min(Math.max(0, Math.floor(input.graceAttempts ?? 0)), PASSWORD_GRACE_ATTEMPTS);
        const spent = Number(row.grace_attempts);
        if (spent >= slots) {
          return { kind: "locked", until: lockedUntil.toISOString() };
        }
        await client.query(
          `UPDATE user_credentials SET grace_attempts = $2::smallint, updated_at = $3::timestamptz
            WHERE user_id = $1`,
          [input.userId, spent + 1, input.now],
        );
        return {
          kind: "reserved",
          attemptsUsed: Number(row.failed_attempts),
          lockedNow: false,
          graceUsed: spent + 1,
          secret: secretFrom(row),
        };
      }
      // A lock that has run out starts a fresh window: the count the lock was made of is spent, and
      // so are the slots that were taken under it.
      const before = lockedUntil === null ? Number(row.failed_attempts) : 0;
      const used = Math.min(before + 1, input.maxAttempts);
      const lockedNow = used >= input.maxAttempts;
      await client.query(
        `UPDATE user_credentials
            SET failed_attempts = $2::integer,
                grace_attempts = 0,
                locked_until = $3::timestamptz,
                updated_at = $4::timestamptz
          WHERE user_id = $1`,
        [input.userId, used, lockedNow ? new Date(input.now.getTime() + input.lockMs) : null, input.now],
      );
      return { kind: "reserved", attemptsUsed: used, lockedNow, graceUsed: 0, secret: secretFrom(row) };
    },

    async recordSuccess(input) {
      // Both writes are guarded by the hash that was proved. A reset that landed while the password
      // was being compared changed it, and then this changes nothing: not the hash (the old password
      // would come back), and not the counters (the new password's count would be wiped).
      if (input.rehash) {
        const { rows } = await client.query<Row>(
          `UPDATE user_credentials
              SET failed_attempts = 0, grace_attempts = 0, locked_until = NULL,
                  last_sign_in_at = $2::timestamptz, updated_at = $2::timestamptz,
                  password_hash = $3::bytea, password_salt = $4::bytea,
                  scrypt_n = $5::integer, scrypt_r = $6::integer, scrypt_p = $7::integer
            WHERE user_id = $1 AND password_hash = $8::bytea
            RETURNING user_id`,
          [
            input.userId,
            input.now,
            input.rehash.hash,
            input.rehash.salt,
            input.rehash.params.n,
            input.rehash.params.r,
            input.rehash.params.p,
            input.expectHash,
          ],
        );
        return rows.length > 0;
      }
      const { rows } = await client.query<Row>(
        `UPDATE user_credentials
            SET failed_attempts = 0, grace_attempts = 0, locked_until = NULL,
                last_sign_in_at = $2::timestamptz, updated_at = $2::timestamptz
          WHERE user_id = $1 AND password_hash = $3::bytea
          RETURNING user_id`,
        [input.userId, input.now, input.expectHash],
      );
      return rows.length > 0;
    },

    async clearAttempts(userId) {
      await client.query(
        `UPDATE user_credentials SET failed_attempts = 0, grace_attempts = 0, locked_until = NULL
          WHERE user_id = $1`,
        [userId],
      );
    },

    async setPassword(input) {
      const { rows } = await client.query<Row>(
        `UPDATE user_credentials
            SET password_hash = $2::bytea, password_salt = $3::bytea,
                scrypt_n = $4::integer, scrypt_r = $5::integer, scrypt_p = $6::integer,
                must_change = $7::boolean,
                failed_attempts = 0, grace_attempts = 0, locked_until = NULL,
                password_changed_at = $8::timestamptz, updated_at = $8::timestamptz
          WHERE user_id = $1 AND ($9::bytea IS NULL OR password_hash = $9::bytea)
          RETURNING user_id`,
        [
          input.userId,
          input.secret.hash,
          input.secret.salt,
          input.secret.params.n,
          input.secret.params.r,
          input.secret.params.p,
          input.mustChange,
          input.now,
          input.expectHash ?? null,
        ],
      );
      return rows.length > 0;
    },
  };
}
