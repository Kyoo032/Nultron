-- F1 data sources: the read-only connectors an owner points at their own systems
-- (docs/internal/coding-requirements section F1, DFIND-173).
--
-- TWO TABLES, BOTH TENANT-SCOPED. `data_sources` is one connector (an S3 bucket, a
-- PostgreSQL or MySQL server; `azure_blob` joins in W3 part 2 and `mysql` ships behind
-- Rizky's dependency decision, section 6). `data_source_sync_runs` is the metadata-only
-- record of each sync: counts and an error code, never a file name — a name can carry
-- PII and this table exists so the audit trail never has to hold one.
--
-- SECRETS ARE NOT HERE AS TEXT. `config_sealed`, `secret_sealed` and
-- `table_allowlist_sealed` are AES-256-GCM envelopes under the vault wrap key
-- (`HKDF(wrapKey, "data-source-v1")` in packages/host/src/data-sources/secrets.ts),
-- the same at-rest rule settings and session tokens already follow. No API response
-- ever includes them; `secret_last4` is kept only so the UI can say "key ending ••1a2b"
-- without opening the envelope.
--
-- NO FOREIGN KEYS, like `artifacts` and `datasets`. The tenant purge
-- (packages/db/src/tenant-purge.ts) deletes both tables' rows by tenant in the reset
-- transaction, so a data source's sealed credentials go with the tenant's other secrets.
--
-- ONE-WAY AND ADDITIVE: two new tables, nothing existing is altered. The runner is
-- forward-only and has no `down`.
--
-- NUMBERING. The runner applies a migration only when `lastAppliedCreatedAt < entry.when`,
-- so `when` decides what runs and `idx` is cosmetic. This file carries 1788820000019,
-- above 0026's 1788820000018, and its journal entry sits between 0026's and 0028's.
-- Times are epoch milliseconds, as everywhere else in this schema.
CREATE TABLE IF NOT EXISTS `data_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`config_sealed` text NOT NULL,
	`secret_sealed` text NOT NULL,
	`secret_last4` text,
	`status` text NOT NULL,
	`table_allowlist_sealed` text,
	`last_sync_at` integer,
	`last_sync_result` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `data_sources_kind_check` CHECK(`kind` IN ('s3','azure_blob','postgres','mysql')),
	CONSTRAINT `data_sources_status_check` CHECK(`status` IN ('active','disabled'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `data_sources_tenant_idx` ON `data_sources` (`tenant_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `data_source_sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`data_source_id` text NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`files_ok` integer,
	`files_failed` integer,
	`error_code` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `data_source_sync_runs_source_idx` ON `data_source_sync_runs` (`data_source_id`,`started_at`);
