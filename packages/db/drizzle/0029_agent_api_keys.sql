CREATE TABLE IF NOT EXISTS `agent_api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`workspace_id` text,
	`name` text NOT NULL,
	`key_prefix` text NOT NULL,
	`key_hash` blob NOT NULL,
	`last4` text NOT NULL,
	`allowed_agents` text NOT NULL,
	`rate_limit_rpm` integer,
	`status` text NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`last_used_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `agent_api_keys_key_prefix_unique` UNIQUE(`key_prefix`),
	CONSTRAINT `agent_api_keys_key_hash_unique` UNIQUE(`key_hash`),
	CONSTRAINT `agent_api_keys_hash_len_check` CHECK(length(`key_hash`) = 32),
	CONSTRAINT `agent_api_keys_rate_limit_check` CHECK(`rate_limit_rpm` IS NULL OR `rate_limit_rpm` > 0),
	CONSTRAINT `agent_api_keys_status_check` CHECK(`status` IN ('active','revoked')),
	CONSTRAINT `agent_api_keys_revoked_check` CHECK((`status` = 'revoked') = (`revoked_at` IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_api_keys_tenant_idx` ON `agent_api_keys` (`tenant_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `api_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`key_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`status` text NOT NULL,
	`result_sealed` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `api_jobs_status_check` CHECK(`status` IN ('queued','running','awaiting_approval','done','failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `api_jobs_tenant_key_idx` ON `api_jobs` (`tenant_id`,`key_id`);
