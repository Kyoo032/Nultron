-- Email channel (F5b): inbound mail through a provider webhook plus owner notices.
--
-- FOUR TABLES. `email_channels` is one agent-facing address; the webhook resolves the desk from
-- the address in the delivery, never from anything else the sender can name. `workspace_id` carries
-- the desk's workspace id (the desk is the tenant the session TenantContext names), same
-- convention as `channel_endpoints` in 0023.
-- `email_sender_allowlist` is a pattern → user map; a null `user_id` means "the desk's owner".
-- `email_inbound_seen` is the at-least-once dedupe: the provider's message id is the primary key,
-- so a redelivery is refused by the insert itself inside the same transaction that stores the mail.
-- `email_threads` maps a mail thread (RFC 5322 References root) to the chat thread the reply runs in.
--
-- BODIES ARE NOT HERE. Inbound and outbound text lives only in the sealed message store
-- (`messages.content`, sealed by `sealJson` on insert), same as every chat turn (S1).
--
-- ONE-WAY AND ADDITIVE, declared `IF NOT EXISTS` like 0010-0026: a baseline-stamped database gets
-- the journal row without the tables and `ensureEmailChannelTables` in `ensure-schema.ts` re-creates
-- them there. `when` is 1788820000019, above 0026's 1788820000018; epoch milliseconds as elsewhere.
CREATE TABLE IF NOT EXISTS `email_channels` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `agent_id` text NOT NULL,
  `address` text NOT NULL,
  `unknown_sender_policy` text NOT NULL,
  `status` text NOT NULL,
  `created_at` integer NOT NULL,
  CONSTRAINT `email_channels_policy_check` CHECK (`unknown_sender_policy` IN ('ignore', 'refuse')),
  CONSTRAINT `email_channels_status_check` CHECK (`status` IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `email_channels_address_unique` ON `email_channels` (`address`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `email_channels_workspace_idx` ON `email_channels` (`workspace_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `email_sender_allowlist` (
  `id` text PRIMARY KEY NOT NULL,
  `channel_id` text NOT NULL REFERENCES `email_channels`(`id`) ON DELETE cascade,
  `pattern` text NOT NULL,
  `user_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `email_sender_allowlist_pattern_unique` ON `email_sender_allowlist` (`channel_id`,`pattern`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `email_inbound_seen` (
  `provider_message_id` text PRIMARY KEY NOT NULL,
  `channel_id` text NOT NULL REFERENCES `email_channels`(`id`) ON DELETE cascade,
  `received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `email_inbound_seen_channel_idx` ON `email_inbound_seen` (`channel_id`,`received_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `email_threads` (
  `id` text PRIMARY KEY NOT NULL,
  `channel_id` text NOT NULL REFERENCES `email_channels`(`id`) ON DELETE cascade,
  `thread_id` text NOT NULL,
  `root_message_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `email_threads_root_unique` ON `email_threads` (`channel_id`,`root_message_id`);
