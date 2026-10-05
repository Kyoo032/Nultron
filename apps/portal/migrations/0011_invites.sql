-- 0011_invites.sql
-- The invite that gates a first sign-in (owner decision, 2026-10-01: "invite code, and it binds to
-- the tester email, then for login later they will need email verification to get inside").
--
-- ## What decides who may sign in, and where this fits
--
-- Until now the only gate was a `users` row: `resolve_tenant_for_email` (0007) finds the tenant of
-- any address that has one, `sendLoginOtp` mails a code to it, and `login_precheck` (0005) refuses
-- the session unless `users.status = 'active'`. Nothing created an `invited` user -- the schema has
-- always had the status ("invited | active | disabled", 0002) and no flow to move anybody out of
-- it. So the fit is not a second gate beside that one: an operator's invite creates the `invited`
-- member and one row here, and redeeming the code is what moves the member to `active`. The seat
-- count (`count_active_users`, 0005) counts `active` users with a live session, so an invited
-- member holds no seat until they have actually signed in.
--
-- ## The row
--
--   * `email` is the address the code is bound to. Redemption looks the invite up BY that address,
--     so a code can only ever be matched against the invite of the address that presented it.
--   * `code_hash` is sha256 of the normalised code (upper case, no dashes or spaces) -- the same
--     rule as every other credential in this schema: a dump of this table redeems nothing. The code
--     carries 100 bits (20 characters of a 32-character alphabet), so the hash needs no slowdown.
--   * `failed_attempts` is capped at 5 by a CHECK, exactly as `login_otps.attempts` is. It is the
--     persistent half of the rate limit on wrong codes; the per-IP half is in the portal's process.
--   * `redeemed_at` makes the code single use. `revoked_at` retires an invite an operator replaced:
--     one live invite per address, so a lost code is replaced, never added to.
--   * `role` is the role the member holds once the invite is redeemed (`owner | admin | member`, the
--     vocabulary `users.role` already has). The operator chooses it when inviting; redeeming copies it
--     onto the member, and the portal then puts it in the access token and the token response, which
--     is what the host provisions the person's own role from instead of guessing one.
--   * `expires_at` is set by the application (7 days by default); there is deliberately no CHECK
--     tying it to `created_at`, so a test can ask for a row that is already past it.
--
-- ## RLS and grants
--
-- Plain tenant-scoped, the shape 0004 gives `users` and `login_otps`: `tenant_id` is NOT NULL and
-- the only readers are inside `store.tx(tenantId, ...)`, so there is no pre-authentication window
-- and nothing here widens one. `tenant_readonly` gets nothing: for seven days a live `code_hash`
-- is credential-adjacent and has no business in a tenant's nightly export. `portal_app` gets no
-- DELETE -- an invite is a record of who was let in and when, and 7-day rows are tiny.

BEGIN;

CREATE TABLE IF NOT EXISTS invites (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email           citext NOT NULL,
  code_hash       bytea NOT NULL,
  role            text NOT NULL DEFAULT 'member',
  failed_attempts integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '7 days',
  redeemed_at     timestamptz,
  revoked_at      timestamptz,
  CONSTRAINT invites_hash_len_chk CHECK (octet_length(code_hash) = 32),
  CONSTRAINT invites_role_chk CHECK (role IN ('owner','admin','member')),
  -- five wrong guesses lock the invite; a sixth redemption can never succeed.
  CONSTRAINT invites_attempts_chk CHECK (failed_attempts BETWEEN 0 AND 5),
  CONSTRAINT invites_redeemed_chk CHECK (redeemed_at IS NULL OR redeemed_at >= created_at)
);

-- Redemption reads "the newest live invite for this address", and the operator's tool reads the
-- same row to say whether it is replacing one.
CREATE INDEX IF NOT EXISTS ix_invites_tenant_email ON invites (tenant_id, email, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_invites_code_hash ON invites (code_hash);
-- One live invite per address, enforced here and not only by the application's retire-then-insert:
-- two operators inviting the same address at once would otherwise leave two live codes, of which only
-- the newest could ever be redeemed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invites_live
  ON invites (tenant_id, email) WHERE redeemed_at IS NULL AND revoked_at IS NULL;

COMMENT ON TABLE invites IS
  'First-sign-in invites: one live code per address, bound to that address, 7 days, single use,
   5 wrong guesses. Redeeming moves users.status from invited to active. Only sha256(code) is stored.';
COMMENT ON COLUMN invites.email IS
  'The address the code is bound to. Redemption looks the invite up by it, so a code never matches
   another address''s invite.';
COMMENT ON COLUMN invites.code_hash IS
  'sha256 of the normalised invite code, exactly 32 bytes. Never the code.';
COMMENT ON COLUMN invites.role IS
  'The role the member holds once the invite is redeemed: owner | admin | member. Copied onto
   users.role at redemption and carried to the host in the access token and the token response.';
COMMENT ON COLUMN invites.failed_attempts IS
  'Wrong redemptions so far. At 5 the invite is locked; the operator issues a new one.';
COMMENT ON COLUMN invites.revoked_at IS
  'Set when an operator issues a replacement for the same address, so one invite is live at a time.';

----------------------------------------------------------------------
-- RLS + grants, in the plain tenant-scoped shape 0004 defines
----------------------------------------------------------------------
ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_invites_tenant ON invites;
CREATE POLICY p_invites_tenant ON invites
  FOR ALL
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

DROP POLICY IF EXISTS p_invites_admin ON invites;
CREATE POLICY p_invites_admin ON invites
  FOR ALL TO portal_admin
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON invites TO portal_app;

REVOKE ALL ON invites FROM tenant_readonly;

ALTER TABLE invites OWNER TO portal_admin;

COMMIT;
