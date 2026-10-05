/**
 * invites: one live code per address, bound to that address, 7 days, single use, five wrong
 * guesses (`apps/portal/migrations/0011_invites.sql`).
 *
 * This is the half that DECIDES. The flow above it (`otp/send.ts`) decides what to say, and says the
 * same thing for every refusal; the reasons returned here exist for the audit row and for the
 * tests, and never reach the person typing.
 *
 * Two properties are the point:
 *
 *   - **Bound to the address.** A redemption looks the invite up by the address that presented it,
 *     so a code can only ever be compared with the invite of the address it came with. Another
 *     tester's code, presented under your address, is a wrong guess against YOUR invite and
 *     touches theirs not at all.
 *   - **Redeeming is activating.** The invite is consumed and the `invited` member becomes
 *     `active` in the caller's one transaction, so there is no state in which a code is spent and
 *     the member is not (or the reverse). A member an operator has disabled is never brought back
 *     by an invite, and the invite is left unspent.
 */
import type { PoolClient } from "pg";
import { hashEquals, normaliseEmail, normaliseInviteCode, sha256 } from "../../crypto";
import type { Clock, PortalOps, RedeemInviteResult } from "../types";
import { isoOrNull, type Row, toInvite, toUser } from "./rows";

export const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** `invites_attempts_chk` caps the column at the same number. */
export const MAX_FAILED_INVITE_ATTEMPTS = 5;

function first(rows: Row[]): Row | null {
  return rows.length > 0 ? rows[0] : null;
}

export function invitesOps(client: PoolClient, clock: Clock): PortalOps["invites"] {
  return {
    async create(input) {
      const email = normaliseEmail(input.email);

      // One live invite per address: a lost code is replaced, never added to. Redeemed rows are
      // left alone -- they are the record that this address was let in.
      await client.query(
        `UPDATE invites SET revoked_at = now()
          WHERE tenant_id = $1 AND email = $2 AND redeemed_at IS NULL AND revoked_at IS NULL`,
        [input.tenantId, email],
      );

      const expiresAt = new Date(clock.now().getTime() + (input.ttlMs ?? DEFAULT_INVITE_TTL_MS));
      const { rows } = await client.query<Row>(
        `INSERT INTO invites (tenant_id, org_id, user_id, email, code_hash, expires_at, role)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'member'))
         RETURNING *`,
        [
          input.tenantId,
          input.orgId,
          input.userId,
          email,
          sha256(normaliseInviteCode(input.rawCode)),
          expiresAt.toISOString(),
          input.role ?? null,
        ],
      );
      return toInvite(rows[0]);
    },

    async latestForEmail(tenantId, email) {
      const { rows } = await client.query<Row>(
        `SELECT * FROM invites
          WHERE tenant_id = $1 AND email = $2 AND revoked_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1`,
        [tenantId, normaliseEmail(email)],
      );
      const row = first(rows);
      return row ? toInvite(row) : null;
    },

    async issuedSince(tenantId, email, since) {
      const { rows } = await client.query<Row>(
        `SELECT count(*)::int AS n, min(created_at) AS oldest, max(created_at) AS newest
           FROM invites
          WHERE tenant_id = $1 AND email = $2 AND created_at > $3`,
        [tenantId, normaliseEmail(email), since],
      );
      const row = rows[0];
      return Object.freeze({
        count: Number(row.n),
        oldestAt: isoOrNull(row.oldest),
        newestAt: isoOrNull(row.newest),
      });
    },

    async redeem(input): Promise<RedeemInviteResult> {
      const email = normaliseEmail(input.email);
      // Hashed before anything is read, so a refusal costs the same as a success up to this point.
      const presented = sha256(normaliseInviteCode(input.rawCode));

      // `FOR UPDATE`: two redemptions of one code, or two wrong guesses, take turns, and each sees
      // the other's count. Without it five concurrent wrong guesses could all read zero.
      const { rows } = await client.query<Row & { code_hash: Buffer }>(
        `SELECT * FROM invites
          WHERE tenant_id = $1 AND email = $2 AND revoked_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE`,
        [input.tenantId, email],
      );
      const row = rows[0];
      if (!row) {
        return { ok: false, reason: "no_invite", attemptsRemaining: 0 };
      }

      const matches = hashEquals(presented, row.code_hash);
      if (row.redeemed_at !== null) {
        return { ok: false, reason: "already_used", attemptsRemaining: 0 };
      }
      if (new Date(String(row.expires_at)) <= clock.now()) {
        return { ok: false, reason: "expired", attemptsRemaining: 0 };
      }
      const failed = Number(row.failed_attempts);
      if (failed >= MAX_FAILED_INVITE_ATTEMPTS) {
        return { ok: false, reason: "locked", attemptsRemaining: 0 };
      }
      if (!matches) {
        const bumped = await client.query<Row>(
          `UPDATE invites SET failed_attempts = failed_attempts + 1 WHERE id = $1 RETURNING failed_attempts`,
          [row.id],
        );
        const used = Number(bumped.rows[0].failed_attempts);
        return { ok: false, reason: "wrong_code", attemptsRemaining: MAX_FAILED_INVITE_ATTEMPTS - used };
      }

      // The member. `invited` becomes `active` and takes the invite's role; `active` stays exactly as
      // it is (an operator who seeded the member after inviting them loses nothing, and an invite
      // never changes the role of somebody already in); `disabled` is never undone by an invite, and
      // the code is left unspent so nothing about it changed.
      const activated = await client.query<Row>(
        `UPDATE users SET status = 'active', deactivated_at = NULL, role = $2
          WHERE id = $1 AND status = 'invited'
          RETURNING *`,
        [row.user_id, String(row.role)],
      );
      let userRow = first(activated.rows);
      if (!userRow) {
        const current = await client.query<Row>(`SELECT * FROM users WHERE id = $1`, [row.user_id]);
        userRow = first(current.rows);
        if (!userRow || String(userRow.status) !== "active") {
          return { ok: false, reason: "not_invitable", attemptsRemaining: 0 };
        }
      }

      const consumed = await client.query<Row>(
        `UPDATE invites SET redeemed_at = now() WHERE id = $1 RETURNING *`,
        [row.id],
      );
      return { ok: true, invite: toInvite(consumed.rows[0]), user: toUser(userRow) };
    },
  };
}
