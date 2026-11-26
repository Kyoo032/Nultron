-- 0018_gateway_endpoint_key.sql
-- The write-only bearer key for a user's assigned gateway endpoint (DFIND-155).
--
-- An assigned endpoint must never receive the company key, so an operator issues a key per
-- endpoint (`portal.sh account set-endpoint --key-stdin`, read from stdin, never from an argument
-- or a URL). The portal stores it SEALED — AES-256-GCM under a key derived from the signing key
-- (`src/gateway-key.ts`), which the sha256-only rule covers: the raw key exists nowhere on disk.
-- The portal opens it only to put `gateway_key` in a `/auth/token` body for that user; it is never
-- logged, never rendered, and only ever emitted together with the endpoint it belongs to.
--
-- NULL means the endpoint has no issued key: the host then reports needs_key rather than sending
-- the company key.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS gateway_key_sealed text NULL;

COMMENT ON COLUMN users.gateway_key_sealed IS
  'Sealed write-only bearer key for the users assigned gateway endpoint (DFIND-155).
   Opened only to emit gateway_key in /auth/token bodies. NULL means no issued key.';

COMMIT;
