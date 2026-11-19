DROP INDEX IF EXISTS `channel_endpoints_kind_external_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_endpoints_kind_external_unique` ON `channel_endpoints` (`kind`,`external_id`) WHERE `status` = 'active';
