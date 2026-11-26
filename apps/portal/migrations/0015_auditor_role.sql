-- 0015_auditor_role.sql
-- The OPC Auditor seat: a read-only delegation beside owner / admin / member.
--
-- Widens `users_role_chk` (docs/internal/portal/migrations/0002_core_tables.sql:146, never edited)
-- so `users.role` may be 'auditor', and `invites_role_chk` (migrations/0011_invites.sql:58) so an
-- invite may carry it. Nothing else about a role changes: the claim still reads from the member's
-- row at every mint and refresh, and the last-owner rule in `invites/role.ts` still counts only
-- `owner` rows, so demoting the last owner stays refused.

BEGIN;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_role_chk;

ALTER TABLE users
  ADD CONSTRAINT users_role_chk
  CHECK (role IN ('owner','admin','member','auditor'));

ALTER TABLE invites
  DROP CONSTRAINT IF EXISTS invites_role_chk;

ALTER TABLE invites
  ADD CONSTRAINT invites_role_chk
  CHECK (role IN ('owner','admin','member','auditor'));

COMMIT;
