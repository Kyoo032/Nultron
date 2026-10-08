-- 0012_password_signin.sql
-- The credentials behind the portal's second sign-in, `PORTAL_SIGNIN_MODE=password` (owner decision,
-- 2026-10-07, for one white-label deployment: "the login portal doesnt need email code, we will use
-- username and password protection for now, with 2FA method being designed").
--
-- ## What this adds, and what it does not touch
--
-- One table, `user_credentials`, and one resolver, `resolve_tenant_for_username`. Nothing about
-- `users`, `invites`, `login_otps` or the code sign-in changes: a portal started in the default mode
-- never reads this table, and an existing deployment migrates it empty. The portal still has no
-- self-sign-up: a row here exists because an operator ran `portal:account create`, which also made the
-- `users` row (active, with the role the operator chose), so `login_precheck` (0005) and the seat count
-- read the person exactly as they read anyone who got in through the e-mailed code.
--
-- ## The row
--
--   * `user_id` is the primary key: one credential per person, and it goes with the person (ON DELETE
--     CASCADE). `tenant_id` is NOT NULL for the RLS policy below; the portal writes it from the `users`
--     row it belongs to (`INSERT ... SELECT u.tenant_id FROM users u`), never from the caller.
--   * `username` is a `citext`, unique per tenant, 3-32 characters of `a-z 0-9 . _ -`, starting with a
--     letter or digit. It can never contain `@`, so "username or e-mail" is unambiguous at the form.
--   * `password_hash` and `password_salt` are the scrypt output and its 16-byte random salt. The cost
--     parameters sit BESIDE the hash (`scrypt_n`, `scrypt_r`, `scrypt_p`; the key length is the hash's
--     own length), which is the whole point of storing them: raising the cost later is a code change,
--     and every account is re-hashed at its next successful sign-in because the stored parameters no
--     longer equal the current ones. The CHECKs only refuse values that are plainly wrong (a cost below
--     2^14, a non-power-of-two N), so a lowered default cannot be written by mistake.
--   * `must_change` is true for an operator-issued initial or reset password and false once the person
--     has chosen their own. While it is true the portal asks for a new password before it issues a
--     session.
--   * `failed_attempts` and `locked_until` are the lockout, kept here so it survives a restart and a
--     second portal process. An attempt is COUNTED before the password is compared (a single UPDATE that
--     returns the stored hash only to a caller that won an increment), so a burst of parallel guesses
--     buys exactly as many comparisons as the counter allows. Five failures set `locked_until` fifteen
--     minutes ahead. The numbers live in the application, not in a CHECK: the CHECK only bounds the
--     counter to 0..5, as `login_otps.attempts` is bounded.
--   * `password_changed_at` and `last_sign_in_at` are for the operator's `list` and for nothing else.
--
-- No column for a second factor, on purpose: that design is not finished, and a placeholder column
-- would be a decision made by accident.
--
-- ## RLS and grants
--
-- The plain tenant-scoped shape 0004 gives `users` and 0011 gives `invites`: `tenant_id =
-- app_tenant_id()` for both reads and writes, a permissive policy for `portal_admin`, no DELETE for
-- `portal_app` (the row leaves with its person), and nothing at all for `tenant_readonly`: a password
-- hash has no business in a tenant's nightly export.
--
-- ## The resolver
--
-- `resolve_tenant_for_username(citext)`, in the shape and with the same hardening as 0007's
-- `resolve_tenant_for_email`: SECURITY DEFINER, owned by `portal_admin`, a pinned `search_path`,
-- EXECUTE for `portal_app` only, and it answers at most a tenant id -- NULL when the username is
-- unknown OR is used in more than one tenant, so it cannot pick a tenant for the person. It is needed
-- only where no tenant is in hand: the device-code page (`/activate`) with no pending code. The browser
-- sign-in (`/authorize`) always has the client's tenant and looks the username up inside it.

BEGIN;

CREATE TABLE IF NOT EXISTS user_credentials (
  user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  username            citext NOT NULL,
  password_hash       bytea NOT NULL,
  password_salt       bytea NOT NULL,
  hash_algo           text NOT NULL DEFAULT 'scrypt',
  scrypt_n            integer NOT NULL,
  scrypt_r            integer NOT NULL,
  scrypt_p            integer NOT NULL,
  must_change         boolean NOT NULL DEFAULT true,
  failed_attempts     integer NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at     timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_credentials_username_chk CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$'),
  CONSTRAINT user_credentials_algo_chk CHECK (hash_algo = 'scrypt'),
  CONSTRAINT user_credentials_hash_len_chk CHECK (octet_length(password_hash) BETWEEN 16 AND 64),
  CONSTRAINT user_credentials_salt_len_chk CHECK (octet_length(password_salt) BETWEEN 16 AND 64),
  -- A power of two from 2^14 (16 MiB at r = 8) to 2^20. Nothing below the floor can be stored.
  CONSTRAINT user_credentials_scrypt_n_chk
    CHECK (scrypt_n BETWEEN 16384 AND 1048576 AND (scrypt_n & (scrypt_n - 1)) = 0),
  CONSTRAINT user_credentials_scrypt_r_chk CHECK (scrypt_r BETWEEN 1 AND 32),
  CONSTRAINT user_credentials_scrypt_p_chk CHECK (scrypt_p BETWEEN 1 AND 16),
  CONSTRAINT user_credentials_attempts_chk CHECK (failed_attempts BETWEEN 0 AND 5)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_credentials_username ON user_credentials (tenant_id, username);
-- The resolver's lookup, and nothing else reads by username without a tenant.
CREATE INDEX IF NOT EXISTS ix_user_credentials_username ON user_credentials (username);

COMMENT ON TABLE user_credentials IS
  'Password sign-in (PORTAL_SIGNIN_MODE=password): one scrypt credential per person, created only by
   the operator command portal:account. The cost parameters sit beside the hash so they can be raised;
   the lockout counters live here so they survive a restart. No second-factor column on purpose.';
COMMENT ON COLUMN user_credentials.username IS
  'Unique per tenant, 3-32 characters of a-z 0-9 . _ -, never containing @, so "username or e-mail" is
   unambiguous at the sign-in form.';
COMMENT ON COLUMN user_credentials.password_hash IS
  'scrypt output, at the length it was made with. Never leaves the store: no row mapper reads it back
   except the verifier.';
COMMENT ON COLUMN user_credentials.must_change IS
  'True for an initial or operator-reset password: the portal asks for a new one before it issues a
   session. False once the person chose their own.';
COMMENT ON COLUMN user_credentials.failed_attempts IS
  'Attempts counted since the last success or the last lock expiry, 0..5. Counted BEFORE the password
   is compared, so parallel guesses cannot out-run it.';
COMMENT ON COLUMN user_credentials.locked_until IS
  'Set fifteen minutes ahead by the fifth counted attempt. While it is in the future no password is
   compared and every answer is the same wrong-password sentence.';

----------------------------------------------------------------------
-- RLS + grants, in the plain tenant-scoped shape 0004 defines
----------------------------------------------------------------------
ALTER TABLE user_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_credentials FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_user_credentials_tenant ON user_credentials;
CREATE POLICY p_user_credentials_tenant ON user_credentials
  FOR ALL
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

DROP POLICY IF EXISTS p_user_credentials_admin ON user_credentials;
CREATE POLICY p_user_credentials_admin ON user_credentials
  FOR ALL TO portal_admin
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON user_credentials TO portal_app;

REVOKE ALL ON user_credentials FROM tenant_readonly;

ALTER TABLE user_credentials OWNER TO portal_admin;

----------------------------------------------------------------------
-- The resolver, in 0007's shape
----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION resolve_tenant_for_username(p_username citext)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  -- LIMIT 2 is the whole trick, as in resolve_tenant_for_email: "exactly one" from "more than one".
  WITH matches AS (
    SELECT DISTINCT c.tenant_id FROM user_credentials c WHERE c.username = p_username LIMIT 2
  )
  SELECT m.tenant_id FROM matches m WHERE (SELECT count(*) FROM matches) = 1;
$fn$;

ALTER FUNCTION resolve_tenant_for_username(citext) OWNER TO portal_admin;
REVOKE ALL ON FUNCTION resolve_tenant_for_username(citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_tenant_for_username(citext) TO portal_app;

COMMENT ON FUNCTION resolve_tenant_for_username(citext) IS
  'Tenant for a username, or NULL when it is unknown OR used in more than one tenant. Only for the
   device-code page, which can have no tenant in hand; the browser sign-in looks the username up inside
   the OAuth client''s own tenant.';

COMMIT;
