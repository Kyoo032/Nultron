-- Customer inbox: the conversations a desk's own customers start on a channel such as WhatsApp
-- (docs/internal/whatsapp-omnichannel-plan.md, Phase 1).
--
-- THREE TABLES. `channel_endpoints` is one connected number or bot, and the row a webhook is routed
-- by: the payload names a phone number id, never a desk, so the desk is whatever this row says.
-- `customer_conversations` is one per person per endpoint. `customer_messages` is the thread.
--
-- WHY TABLES AND NOT THE CHANNELS JSON FILES. The webhook has no session and has to find its desk
-- from the number id in one lookup; Meta delivers at least once, so a message needs an atomic
-- dedupe (a unique index, not a read-modify-write of a file); and the page counts things. The owner
-- channels (docs/internal/maps/channels.md) are untouched and stay files.
--
-- ONE DESK PER NUMBER, INSTALL-WIDE. `channel_endpoints_kind_external_unique` is over (kind,
-- external_id) with no workspace in it: a number id belongs to exactly one desk on the whole
-- install, so a second desk cannot register someone else's number and receive their customers. The
-- host also proves the owner holds a token for the number before it writes the row.
--
-- CONVERSATIONS OUTLIVE A DISCONNECT. Disconnecting sets the endpoint `disabled`; the rows stay, and
-- reconnecting the same number picks up where it left off. A purge goes the other way: the tenant
-- purge deletes `channel_endpoints` by desk, and the foreign keys take conversations and messages.
--
-- `workspace_id` IS ON EVERY TABLE, and every query filters on it. The two ledger tables also carry
-- `organization_id`, as the Channels records do. `tenant_id` is deliberately NOT here: the design
-- hangs every table but the tenant-level ones off the organization (migrate-0015.test.ts holds the
-- list), so a tenant is reached through `organizations.tenant_id` when something needs it.
--
-- ONE-WAY AND ADDITIVE: three new tables, nothing existing is altered. The runner is forward-only
-- and has no `down`.
--
-- NUMBERING. The runner applies a migration only when `lastAppliedCreatedAt < entry.when`, so `when`
-- decides what runs and `idx` is cosmetic. This file carries 1788820000016, above 0022's
-- 1788820000015, and its journal entry sits last. Declared defensively (`IF NOT EXISTS`) like
-- 0010-0022: a database baseline-stamped past this point has the journal row without the tables,
-- and `ensureCustomerInboxTables` in `ensure-schema.ts` re-creates them there. Times are epoch
-- milliseconds, as everywhere else in this schema.
CREATE TABLE IF NOT EXISTS `channel_endpoints` (
  `id` text PRIMARY KEY NOT NULL,
  `organization_id` text NOT NULL,
  `workspace_id` text NOT NULL,
  `kind` text NOT NULL,
  `external_id` text NOT NULL,
  `display_phone` text,
  `verified_name` text,
  `status` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CONSTRAINT `channel_endpoints_kind_check` CHECK (`kind` IN ('whatsapp')),
  CONSTRAINT `channel_endpoints_status_check` CHECK (`status` IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `channel_endpoints_kind_external_unique` ON `channel_endpoints` (`kind`,`external_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `channel_endpoints_ws_idx` ON `channel_endpoints` (`workspace_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `customer_conversations` (
  `id` text PRIMARY KEY NOT NULL,
  `organization_id` text NOT NULL,
  `workspace_id` text NOT NULL,
  `endpoint_id` text NOT NULL REFERENCES `channel_endpoints`(`id`) ON DELETE cascade,
  `kind` text NOT NULL,
  `contact_id` text NOT NULL,
  `contact_name` text NOT NULL,
  `state` text NOT NULL,
  `unread_count` integer DEFAULT 0 NOT NULL,
  `last_inbound_at` integer,
  `last_outbound_at` integer,
  `last_message_at` integer NOT NULL,
  `last_message_preview` text NOT NULL,
  `last_message_direction` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CONSTRAINT `customer_conversations_kind_check` CHECK (`kind` IN ('whatsapp')),
  CONSTRAINT `customer_conversations_state_check` CHECK (`state` IN ('auto', 'needs_you', 'with_you', 'closed')),
  CONSTRAINT `customer_conversations_direction_check` CHECK (`last_message_direction` IN ('in', 'out'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `customer_conversations_contact_unique` ON `customer_conversations` (`endpoint_id`,`contact_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `customer_conversations_ws_state_idx` ON `customer_conversations` (`workspace_id`,`state`,`last_message_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `customer_messages` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `conversation_id` text NOT NULL REFERENCES `customer_conversations`(`id`) ON DELETE cascade,
  `direction` text NOT NULL,
  `sent_by` text NOT NULL,
  `kind` text NOT NULL,
  `external_id` text,
  `text` text NOT NULL,
  `delivery` text,
  `delivery_error` text,
  `created_at` integer NOT NULL,
  CONSTRAINT `customer_messages_direction_check` CHECK (`direction` IN ('in', 'out')),
  CONSTRAINT `customer_messages_sent_by_check` CHECK (`sent_by` IN ('customer', 'auto', 'owner')),
  CONSTRAINT `customer_messages_kind_check` CHECK (`kind` IN ('text', 'unsupported')),
  CONSTRAINT `customer_messages_delivery_check` CHECK (`delivery` IS NULL OR `delivery` IN ('queued', 'sent', 'delivered', 'read', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `customer_messages_external_unique` ON `customer_messages` (`conversation_id`,`direction`,`external_id`) WHERE `external_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `customer_messages_conv_idx` ON `customer_messages` (`conversation_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `customer_messages_external_idx` ON `customer_messages` (`external_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `customer_messages_ws_time_idx` ON `customer_messages` (`workspace_id`,`created_at`);
