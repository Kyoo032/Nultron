CREATE TABLE IF NOT EXISTS `audit_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`at` integer NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`agent_id` text,
	`event` text NOT NULL,
	`target_kind` text,
	`target_id` text,
	`outcome` text,
	`duration_ms` integer,
	`item_count` integer,
	`ref_hash` text,
	`channel` text,
	`rule` text,
	`prev_hash` text NOT NULL,
	`row_hash` text NOT NULL,
	CONSTRAINT `audit_events_id_unique` UNIQUE(`id`),
	CONSTRAINT `audit_events_actor_kind_check` CHECK(`actor_kind` IN ('user','api_key','system','operator')),
	CONSTRAINT `audit_events_outcome_check` CHECK(`outcome` IN ('ok','denied','failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_events_tenant_at_idx` ON `audit_events` (`tenant_id`,`at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_events_tenant_event_at_idx` ON `audit_events` (`tenant_id`,`event`,`at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `audit_checkpoints` (
	`seq` integer PRIMARY KEY NOT NULL,
	`row_hash` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `audit_purge_window` (
	`id` integer PRIMARY KEY NOT NULL,
	`max_seq` integer,
	CONSTRAINT `audit_purge_window_id_check` CHECK(`id` = 1)
);
--> statement-breakpoint
INSERT OR IGNORE INTO `audit_purge_window` (`id`, `max_seq`) VALUES (1, 0);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `audit_events_no_update`
BEFORE UPDATE ON `audit_events`
BEGIN
	SELECT RAISE(ABORT, 'audit_events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `audit_events_no_delete`
BEFORE DELETE ON `audit_events`
WHEN OLD.seq > COALESCE((SELECT `max_seq` FROM `audit_purge_window` WHERE `id` = 1), 0)
BEGIN
	SELECT RAISE(ABORT, 'audit_events rows may only be purged below the retention window');
END;
