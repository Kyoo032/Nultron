/** tenants, tenant_config, orgs, users — the rows every other table hangs off. */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { normaliseEmail } from "../../crypto";
import type { PortalOps } from "../types";
import { type Row, toOrg, toTenant, toTenantConfig, toUser } from "./rows";

function first(rows: Row[]): Row | null {
  return rows.length > 0 ? rows[0] : null;
}

export function tenantsOps(client: PoolClient): PortalOps["tenants"] {
  return {
    async create(input) {
      const { rows } = await client.query<Row>(
        `INSERT INTO tenants (id, slug, name, status, residency)
         VALUES ($1, $2, $3, COALESCE($4, 'active'), COALESCE($5, 'id-jakarta'))
         RETURNING *`,
        [input.id ?? randomUUID(), input.slug, input.name, input.status ?? null, input.residency ?? null],
      );
      return toTenant(rows[0]);
    },
    async findById(id) {
      const { rows } = await client.query<Row>(`SELECT * FROM tenants WHERE id = $1`, [id]);
      const row = first(rows);
      return row ? toTenant(row) : null;
    },
    async findBySlug(slug) {
      const { rows } = await client.query<Row>(`SELECT * FROM tenants WHERE slug = $1`, [slug]);
      const row = first(rows);
      return row ? toTenant(row) : null;
    },
    async setName(id, name) {
      const { rows } = await client.query<Row>(
        `UPDATE tenants SET name = $2::text WHERE id = $1 RETURNING *`,
        [id, name],
      );
      const row = first(rows);
      return row ? toTenant(row) : null;
    },
    async setStatus(id, status) {
      const { rows } = await client.query<Row>(
        `UPDATE tenants
            SET status = $2::text,
                suspended_at = CASE WHEN $2::text = 'suspended' THEN COALESCE(suspended_at, now()) ELSE NULL END
          WHERE id = $1
          RETURNING *`,
        [id, status],
      );
      const row = first(rows);
      return row ? toTenant(row) : null;
    },
  };
}

export function tenantConfigOps(client: PoolClient): PortalOps["tenantConfig"] {
  return {
    async get(tenantId) {
      const { rows } = await client.query<Row>(`SELECT * FROM tenant_config WHERE tenant_id = $1`, [
        tenantId,
      ]);
      const row = first(rows);
      return row ? toTenantConfig(row) : null;
    },
    async upsert(input) {
      // version is bumped on every write, which is what lets /tenant/config answer 304-style.
      const { rows } = await client.query<Row>(
        `INSERT INTO tenant_config (tenant_id, branding, model_allowlist, feature_flags)
         VALUES ($1, COALESCE($2::jsonb, '{}'::jsonb), COALESCE($3::jsonb, '[]'::jsonb),
                 COALESCE($4::jsonb, '{}'::jsonb))
         ON CONFLICT (tenant_id) DO UPDATE
           SET branding        = COALESCE($2::jsonb, tenant_config.branding),
               model_allowlist = COALESCE($3::jsonb, tenant_config.model_allowlist),
               feature_flags   = COALESCE($4::jsonb, tenant_config.feature_flags),
               version         = tenant_config.version + 1,
               updated_at      = now()
         RETURNING *`,
        [
          input.tenantId,
          input.branding ? JSON.stringify(input.branding) : null,
          input.modelAllowlist ? JSON.stringify(input.modelAllowlist) : null,
          input.featureFlags ? JSON.stringify(input.featureFlags) : null,
        ],
      );
      return toTenantConfig(rows[0]);
    },
  };
}

export function orgsOps(client: PoolClient): PortalOps["orgs"] {
  return {
    async create(input) {
      const seatCap = input.seatCap ?? 20;
      const { rows } = await client.query<Row>(
        `INSERT INTO orgs (tenant_id, name, slug, plan, seat_cap, seat_band, currency,
                           billing_email, feature_flags)
         -- Every parameter that appears in more than one expression is cast explicitly: Postgres
         -- otherwise deduces a type per use site and refuses the mismatch.
         VALUES ($1::uuid, $2, $3, COALESCE($4, 'free'), $5::integer,
                 GREATEST($5::integer, COALESCE($6::integer, $5::integer)),
                 COALESCE($7, 'USD'), $8, COALESCE($9::jsonb, '{}'::jsonb))
         RETURNING *`,
        [
          input.tenantId,
          input.name,
          input.slug,
          input.plan ?? null,
          seatCap,
          input.seatBand ?? null,
          input.currency ?? null,
          input.billingEmail ?? null,
          input.featureFlags ? JSON.stringify(input.featureFlags) : null,
        ],
      );
      return toOrg(rows[0]);
    },
    async findById(id) {
      const { rows } = await client.query<Row>(`SELECT * FROM orgs WHERE id = $1`, [id]);
      const row = first(rows);
      return row ? toOrg(row) : null;
    },
    async findBySlug(tenantId, slug) {
      const { rows } = await client.query<Row>(
        `SELECT * FROM orgs WHERE tenant_id = $1 AND slug = $2`,
        [tenantId, slug],
      );
      const row = first(rows);
      return row ? toOrg(row) : null;
    },
    async listForTenant(tenantId) {
      const { rows } = await client.query<Row>(
        `SELECT * FROM orgs WHERE tenant_id = $1 ORDER BY created_at ASC, slug ASC`,
        [tenantId],
      );
      return Object.freeze(rows.map(toOrg));
    },
    async setStatus(id, status) {
      // orgs_past_due_chk ties past_due_since to the status, so both move together or neither does.
      const { rows } = await client.query<Row>(
        `UPDATE orgs
            SET status = $2::text,
                past_due_since = CASE WHEN $2::text = 'past_due' THEN COALESCE(past_due_since, now()) ELSE NULL END,
                suspended_at   = CASE WHEN $2::text = 'suspended' THEN COALESCE(suspended_at, now()) ELSE suspended_at END
          WHERE id = $1
          RETURNING *`,
        [id, status],
      );
      const row = first(rows);
      return row ? toOrg(row) : null;
    },
    async setSeatCap(id, seatCap) {
      // orgs_seat_band_chk wants seat_band >= seat_cap, so raising the cap raises the band with it.
      const { rows } = await client.query<Row>(
        `UPDATE orgs SET seat_cap = $2::integer, seat_band = GREATEST(seat_band, $2::integer)
          WHERE id = $1 RETURNING *`,
        [id, seatCap],
      );
      const row = first(rows);
      return row ? toOrg(row) : null;
    },
    async countActiveUsers(orgId) {
      const { rows } = await client.query<{ n: number }>(`SELECT count_active_users($1) AS n`, [orgId]);
      return Number(rows[0]?.n ?? 0);
    },
    async hasSeatFor(orgId, userId) {
      // `login_precheck`'s new-session branch (0005), read without its advisory lock: seats in use,
      // plus one when this person is not already inside the active set (a live session seen in the
      // last 30 days), must not exceed the cap. Even a seated person fails when the org is over
      // its cap, because that is what the function says at the exchange and a page must not
      // promise more. An org that is not found has no cap to exceed: the exchange decides.
      const { rows } = await client.query<{ fits: boolean }>(
        `SELECT (count_active_users(o.id) + CASE WHEN EXISTS (
                   SELECT 1 FROM sessions s
                    WHERE s.user_id = $2 AND s.revoked_at IS NULL
                      AND s.last_seen_at > now() - interval '30 days'
                 ) THEN 0 ELSE 1 END) <= o.seat_cap AS fits
           FROM orgs o WHERE o.id = $1`,
        [orgId, userId],
      );
      return rows[0]?.fits ?? true;
    },
    async countProvisioned(orgId) {
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM users WHERE org_id = $1 AND status <> 'disabled'`,
        [orgId],
      );
      return Number(rows[0]?.n ?? 0);
    },
  };
}

export function usersOps(client: PoolClient): PortalOps["users"] {
  return {
    async create(input) {
      const { rows } = await client.query<Row>(
        `INSERT INTO users (tenant_id, org_id, email, display_name, status, role, gateway_endpoint)
         VALUES ($1, $2, $3, $4, COALESCE($5, 'invited'), COALESCE($6, 'member'), $7)
         RETURNING *`,
        [
          input.tenantId,
          input.orgId,
          normaliseEmail(input.email),
          input.displayName ?? null,
          input.status ?? null,
          input.role ?? null,
          input.gatewayEndpoint ?? null,
        ],
      );
      return toUser(rows[0]);
    },
    async findById(id) {
      const { rows } = await client.query<Row>(`SELECT * FROM users WHERE id = $1`, [id]);
      const row = first(rows);
      return row ? toUser(row) : null;
    },
    async findByEmail(tenantId, email) {
      const { rows } = await client.query<Row>(
        `SELECT * FROM users WHERE tenant_id = $1 AND email = $2`,
        [tenantId, normaliseEmail(email)],
      );
      const row = first(rows);
      return row ? toUser(row) : null;
    },
    async setRole(id, role) {
      const { rows } = await client.query<Row>(`UPDATE users SET role = $2::text WHERE id = $1 RETURNING *`, [id, role]);
      const row = first(rows);
      return row ? toUser(row) : null;
    },
    async setGatewayEndpoint(id, gatewayEndpoint, gatewayKeySealed = null) {
      const { rows } = await client.query<Row>(
        `UPDATE users SET gateway_endpoint = $2::text, gateway_key_sealed = $3::text WHERE id = $1 RETURNING *`,
        [id, gatewayEndpoint, gatewayKeySealed],
      );
      const row = first(rows);
      return row ? toUser(row) : null;
    },
    async lockOwners(tenantId) {
      // FOR UPDATE cannot sit on an aggregate, so the rows are locked in a subquery. Under READ
      // COMMITTED a waiter re-evaluates the WHERE once the lock frees, so a row another transaction
      // just demoted no longer counts.
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM (
           SELECT id FROM users
            WHERE tenant_id = $1 AND role = 'owner' AND status <> 'disabled'
            ORDER BY id
            FOR UPDATE
         ) AS owners`,
        [tenantId],
      );
      return Number(rows[0]?.n ?? 0);
    },
    async setStatus(id, status) {
      const { rows } = await client.query<Row>(
        `UPDATE users
            SET status = $2::text,
                deactivated_at = CASE WHEN $2::text = 'disabled' THEN COALESCE(deactivated_at, now()) ELSE NULL END
          WHERE id = $1
          RETURNING *`,
        [id, status],
      );
      const row = first(rows);
      return row ? toUser(row) : null;
    },
  };
}
