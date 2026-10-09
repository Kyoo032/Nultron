-- 0013_password_grace.sql
-- One counter beside the lockout of `user_credentials` (0012), for `PORTAL_SIGNIN_MODE=password`: the
-- attempts a source address that has not failed against a person may still take while that person's
-- account is locked.
--
-- ## Why it exists
--
-- 0012's lock refuses everybody, the person included, while `locked_until` is in the future. That makes
-- the lock a way to keep a NAMED person out for free: anyone who knows a username or an address can
-- spend five wrong attempts every fifteen minutes and the account is never open. The portal now lets a
-- source that has not itself failed against the account in the window (an in-process record, see
-- `src/security/password-attempts.ts`) take a small number of attempts under the lock; a source that
-- has failed is still refused outright.
--
-- Those attempts must be COUNTED where the lock itself is, or the number of passwords an attacker can
-- try would depend on the number of addresses it can spend and on the process it reaches. So this is a
-- durable counter in the same row, taken in the same `FOR UPDATE` transaction as `failed_attempts`, and
-- the schema holds the cap as well as the code does:
--
--   comparisons per account per window  <=  5 (failed_attempts) + 3 (grace_attempts)  =  8
--
-- A window is the stretch from the first counted attempt to the end of the lock it leads to (fifteen
-- minutes after the fifth); a success, an operator's `reset-password` and the end of the lock all set it
-- back to zero together with `failed_attempts`. A restart changes nothing: both counters are here.
--
-- Nothing else about 0012 moves. `failed_attempts` keeps its 0..5 check and its meaning, and a row
-- written before this file reads as zero slots spent.

BEGIN;

ALTER TABLE user_credentials
  ADD COLUMN IF NOT EXISTS grace_attempts smallint NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_credentials_grace_attempts_chk'
  ) THEN
    ALTER TABLE user_credentials
      ADD CONSTRAINT user_credentials_grace_attempts_chk CHECK (grace_attempts BETWEEN 0 AND 3);
  END IF;
END
$$;

COMMENT ON COLUMN user_credentials.grace_attempts IS
  'Attempts taken under the lock by a source address with no earlier failure against this person, 0..3.
   Counted before the password is compared, in the same transaction as failed_attempts, so the most
   passwords tried per window is failed_attempts (5) plus this (3). Cleared with failed_attempts.';

COMMIT;
