-- F1 destination allowlist: the operator-set host:port rules a connector may reach
-- (docs/internal/coding-requirements section F1, DFIND-173).
--
-- EVERY CONNECTOR GOES THROUGH THIS TABLE. S3 over HTTPS, PostgreSQL and MySQL over
-- raw TCP all resolve and pin through `assertAllowedDestination`
-- (packages/core/src/security/safe-fetch.ts); a `host`+`port` with no row is refused
-- before any byte leaves, and a private address is refused unless its row carries
-- `allow_private = 1`.
--
-- THE OPERATOR WRITES IT, NEVER THE DESK. Rows come only from
-- `packages/host/scripts/destination-allowlist.ts`; there is deliberately no API for
-- the list, so a compromised session cannot point the desk's connectors at an
-- attacker host. `mac` is an HMAC-SHA256 over `tenant_id|host|port|allow_private`
-- under the vault wrap key (`HKDF(wrapKey, "destination-allowlist-v1")` in
-- packages/host/src/data-sources/allowlist.ts): a row edited in SQLite by hand fails
-- its MAC and is ignored, logged as a security event — the same class of tamper
-- DFIND-160 closed on the session endpoint.
--
-- PURGED WITH THE TENANT. `tenant_id` keys the row so the tenant purge clears a
-- tenant's entries in the same transaction as the rest.
--
-- ONE-WAY AND ADDITIVE: one new table, nothing existing is altered. The runner is
-- forward-only and has no `down`.
--
-- NUMBERING. Carries 1788820000020, above 0027's 1788820000019, last in the journal.
CREATE TABLE IF NOT EXISTS `destination_allowlist` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`host` text NOT NULL,
	`port` integer NOT NULL,
	`allow_private` integer NOT NULL DEFAULT 0,
	`mac` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `destination_allowlist_port_check` CHECK(`port` BETWEEN 1 AND 65535),
	CONSTRAINT `destination_allowlist_allow_private_check` CHECK(`allow_private` IN (0,1))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `destination_allowlist_tenant_host_port_idx` ON `destination_allowlist` (`tenant_id`,`host`,`port`);
