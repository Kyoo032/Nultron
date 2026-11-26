-- OIDC sign-in (F8b): the issuer/subject bindings a finished "Sign in with Google / Microsoft" leaves
-- behind, the login states a PKCE round trip needs between `start` and `callback`, and the
-- `sso_required` flag an Owner sets on an org to turn password and OTP off for non-owners.
--
-- ## What this adds, and what it does not touch
--
-- Two tables (`user_oidc_identities`, `oidc_login_states`), one column (`orgs.sso_required`), and one
-- resolver (`resolve_tenant_for_oidc_state`). Nothing about `users`, `login_otps`, `user_credentials`
-- or the sign-in state machine changes: a portal with no `PORTAL_OIDC_*` configured never reads these
-- tables, and an existing deployment migrates them empty. There is still no self sign-up: a binding
-- exists because an operator already made the `users` row the verified e-mail matched.
--
-- ## user_oidc_identities
--
--   * `(tenant_id, issuer, subject)` is the primary key: an OIDC subject is only unique inside its
--     issuer, and the same identity can hold seats in several tenants -- each binding is that
--     tenant's own row, to exactly one `users` row.
--   * `tenant_id` is NOT NULL for the RLS policy below; the portal writes it from the `users` row, never
--     from the caller.
--   * The row is written once, the first time a verified e-mail matches a seat, and read every sign-in
--     after. It is never updated: a subject that should point elsewhere is a new row and a manual
--     delete of the old one.
--   * No token, code or claim is stored -- the binding is the whole point of the row.
--
-- ## oidc_login_states
--
--   * One row per `start` -> `callback` round trip, keyed by `sha256(state)`: the raw `state` the
--     browser carries is the lookup, and only its hash is stored, so the table alone cannot mint a
--     callback.
--   * `nonce_hash` is `sha256(nonce)`; `code_verifier_sealed` holds the sealed JSON envelope
--     (`seal.ts`: AES-256-GCM) carrying the verifier, the door (`authorize` | `activate`) and that
--     door's parameters. Raw verifiers are never stored.
--   * `expires_at` bounds the window; `consume` is a `DELETE ... RETURNING`, so a replayed callback
--     (or a second tab) finds nothing.
--
-- ## orgs.sso_required
--
-- The Owner's switch. When true, `beginSignIn` and the password flow refuse non-owner members before
-- any code is sent or password compared; the Owner keeps password/OTP for recovery. It defaults false,
-- which is the old behaviour bit for bit.
--
-- ## RLS and grants
--
-- `user_oidc_identities` gets the plain tenant-scoped shape 0004 defines (like `user_credentials`):
-- `tenant_id = app_tenant_id()` for both reads and writes, a permissive `portal_admin` policy, no
-- DELETE for `portal_app` (a binding leaves with its person), nothing for `tenant_readonly`.
--
-- `oidc_login_states` is a pre-authentication table in the `device_codes` shape: tenant-scoped reads
-- and writes, plus `SELECT`/`DELETE` inside the `tx(null)` pre-auth window is refused -- the resolver
-- below is the only way a callback with no tenant in hand learns which tenant scope to open. Rows are
-- inserted in the door's own tenant scope (`tx(tenantId)`), never in the null window.
--
-- ## The resolver
--
-- `resolve_tenant_for_oidc_state(bytea)`, in 0007's shape: SECURITY DEFINER, owned by `portal_admin`,
-- pinned `search_path`, EXECUTE for `portal_app` only, and it answers at most a tenant id -- NULL for
-- an unknown, expired or consumed state hash. It exists because a callback carries `state` and `code`
-- and no tenant; the row it finds then supplies the scope in which it is consumed.

BEGIN;

CREATE TABLE IF NOT EXISTS user_oidc_identities (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  issuer     text NOT NULL,
  subject    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- (issuer, subject) alone is not the key: the same identity (one Google account, say) can
  -- hold seats in several tenants, and each binding is that tenant's own row.
  PRIMARY KEY (tenant_id, issuer, subject),
  CONSTRAINT user_oidc_identities_issuer_len_chk CHECK (octet_length(issuer) BETWEEN 1 AND 512),
  CONSTRAINT user_oidc_identities_subject_len_chk CHECK (octet_length(subject) BETWEEN 1 AND 255)
);

CREATE INDEX IF NOT EXISTS ix_user_oidc_identities_user ON user_oidc_identities (tenant_id, user_id);

COMMENT ON TABLE user_oidc_identities IS
  'The binding an OIDC sign-in leaves behind: (issuer, subject) -> one users row in one tenant.
   Written once on the first verified e-mail match; read on every sign-in after. Stores no token,
   code or claim.';
COMMENT ON COLUMN user_oidc_identities.tenant_id IS
  'Copied from the users row at bind time; the RLS policy needs it and no caller supplies it.';

CREATE TABLE IF NOT EXISTS oidc_login_states (
  state_hash            bytea PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nonce_hash            bytea NOT NULL,
  code_verifier_sealed  text NOT NULL,
  provider              text NOT NULL,
  expires_at            timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oidc_login_states_state_hash_len_chk CHECK (octet_length(state_hash) = 32),
  CONSTRAINT oidc_login_states_nonce_hash_len_chk CHECK (octet_length(nonce_hash) = 32),
  CONSTRAINT oidc_login_states_provider_chk CHECK (provider IN ('google', 'microsoft'))
);

CREATE INDEX IF NOT EXISTS ix_oidc_login_states_expiry ON oidc_login_states (expires_at);

COMMENT ON TABLE oidc_login_states IS
  'One row per OIDC Authorization Code + PKCE round trip. Only hashes of state and nonce are stored;
   the code verifier and door parameters are AES-256-GCM sealed in code_verifier_sealed. Consumed by
   DELETE ... RETURNING, so a replayed callback finds nothing.';
COMMENT ON COLUMN oidc_login_states.expires_at IS
  'The round-trip window. The resolver and the consume path both refuse a row past it; an expired row
   that was never consumed is deleted the next time that tenant writes a state.';

ALTER TABLE orgs ADD COLUMN IF NOT EXISTS sso_required boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN orgs.sso_required IS
  'Owner decision: true turns password and OTP sign-in off for non-owner members (the Owner keeps
   them for recovery). False is the old behaviour bit for bit.';

----------------------------------------------------------------------
-- RLS + grants
----------------------------------------------------------------------
ALTER TABLE user_oidc_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_oidc_identities FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_user_oidc_identities_tenant ON user_oidc_identities;
CREATE POLICY p_user_oidc_identities_tenant ON user_oidc_identities
  FOR ALL
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

DROP POLICY IF EXISTS p_user_oidc_identities_admin ON user_oidc_identities;
CREATE POLICY p_user_oidc_identities_admin ON user_oidc_identities
  FOR ALL TO portal_admin
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT ON user_oidc_identities TO portal_app;

REVOKE ALL ON user_oidc_identities FROM tenant_readonly;

ALTER TABLE user_oidc_identities OWNER TO portal_admin;

ALTER TABLE oidc_login_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE oidc_login_states FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_oidc_login_states_tenant ON oidc_login_states;
CREATE POLICY p_oidc_login_states_tenant ON oidc_login_states
  FOR ALL
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

DROP POLICY IF EXISTS p_oidc_login_states_admin ON oidc_login_states;
CREATE POLICY p_oidc_login_states_admin ON oidc_login_states
  FOR ALL TO portal_admin
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, DELETE ON oidc_login_states TO portal_app;

REVOKE ALL ON oidc_login_states FROM tenant_readonly;

ALTER TABLE oidc_login_states OWNER TO portal_admin;

----------------------------------------------------------------------
-- The resolver, in 0007's shape
----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION resolve_tenant_for_oidc_state(p_state_hash bytea)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT tenant_id FROM oidc_login_states
  WHERE state_hash = p_state_hash AND expires_at > now();
$fn$;

ALTER FUNCTION resolve_tenant_for_oidc_state(bytea) OWNER TO portal_admin;
REVOKE ALL ON FUNCTION resolve_tenant_for_oidc_state(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_tenant_for_oidc_state(bytea) TO portal_app;

COMMENT ON FUNCTION resolve_tenant_for_oidc_state(bytea) IS
  'Tenant for a live OIDC login state hash, or NULL when it is unknown, expired or already consumed.
   The callback has no tenant in hand; this is the only way it learns which scope to open.';

COMMIT;
