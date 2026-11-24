-- 0014_user_gateway_endpoint.sql
-- Operator-assigned API gateway endpoint per user (Nultron admin only).
--
-- NULL means the user uses the product's default pinned gateway (`https://api.tokotokenai.com/v1`).
-- When set by an operator (`portal.sh account create --gateway-endpoint ...`,
-- `portal.sh account set-endpoint ...`, or `portal.sh invite --gateway-endpoint ...`), the portal
-- emits `gateway_endpoint` in `/auth/token` responses on every mint and refresh so the hosted app
-- routes that user's key validation, model catalog, and model calls to their assigned endpoint.
-- Regular users cannot view or modify this column through any self-service route.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS gateway_endpoint text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_gateway_endpoint_chk'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_gateway_endpoint_chk
      CHECK (
        gateway_endpoint IS NULL
        OR (length(gateway_endpoint) <= 2048 AND gateway_endpoint ~ '^https?://[^/\s@]+')
      );
  END IF;
END
$$;

COMMENT ON COLUMN users.gateway_endpoint IS
  'Optional operator-assigned OpenAI-compatible gateway base URL for this user (Nultron admin only).
   NULL uses the default pinned gateway. Returned in /auth/token bodies on every mint and refresh.';

COMMIT;
