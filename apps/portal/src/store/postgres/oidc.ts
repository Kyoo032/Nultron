/**
 * The OIDC tables of `migrations/0017_oidc_identities.sql`, inside the door's tenant scope. The
 * resolver that gets the callback into a scope lives in `resolvers.ts`; everything here assumes
 * `app.tenant_id` is already set.
 */
import type { PoolClient } from "pg";
import type { PortalOps } from "../types";

export function oidcOps(client: PoolClient): PortalOps["oidc"] {
  return {
    async findUserByIdentity(tenantId, issuer, subject) {
      const { rows } = await client.query<{ user_id: string }>(
        `SELECT user_id FROM user_oidc_identities
         WHERE tenant_id = $1 AND issuer = $2 AND subject = $3`,
        [tenantId, issuer, subject],
      );
      return rows.length > 0 ? rows[0].user_id : null;
    },

    async bindIdentity(input) {
      // A raced first sign-in keeps whichever binding landed first; (tenant_id, issuer, subject)
      // is the key, so the same identity can bind a seat per tenant.
      await client.query(
        `INSERT INTO user_oidc_identities (user_id, tenant_id, issuer, subject)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, issuer, subject) DO NOTHING`,
        [input.userId, input.tenantId, input.issuer, input.subject],
      );
    },

    async createState(input) {
      // Expired rows of this tenant die with the next state it writes: the table cannot grow on
      // abandoned round trips alone.
      await client.query(`DELETE FROM oidc_login_states WHERE tenant_id = $1 AND expires_at <= now()`, [
        input.tenantId,
      ]);
      await client.query(
        `INSERT INTO oidc_login_states
           (state_hash, tenant_id, nonce_hash, code_verifier_sealed, provider, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [input.stateHash, input.tenantId, input.nonceHash, input.sealed, input.provider, input.expiresAt],
      );
    },

    async consumeState(tenantId, stateHash) {
      const { rows } = await client.query<{
        nonce_hash: Buffer;
        code_verifier_sealed: string;
        provider: string;
      }>(
        `DELETE FROM oidc_login_states
         WHERE tenant_id = $1 AND state_hash = $2 AND expires_at > now()
         RETURNING nonce_hash, code_verifier_sealed, provider`,
        [tenantId, stateHash],
      );
      const row = rows[0];
      if (!row) {
        return null;
      }
      return { nonceHash: row.nonce_hash, sealed: row.code_verifier_sealed, provider: row.provider };
    },
  };
}
