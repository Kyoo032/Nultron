-- Desk files: the versioned text files an agent and its owner share on a desk
-- (docs/internal/mode-harness-tools-plan.md, unit H2).
--
-- THREE TABLES, TWO OWNERS. `desk_files` and `desk_file_versions` are the desk store
-- (packages/host/src/desk-files). `file_proposals` belongs to the Personal folder root (unit H3): a
-- write or delete an agent wants to make in a real folder, held until the owner approves it. This
-- migration only creates it, so both lanes build on one schema change.
--
-- BODIES ARE NOT HERE. A version row names a sealed object in the tenant object store
-- (`object_key`), written through `putTenantObject`, so the tenant quota counts every version and a
-- hosted erase removes them with the tenant's prefix. `bytes` and `sha256` describe the plain text;
-- the sealed object is larger.
--
-- A LIVE PATH IS UNIQUE PER DESK, A DELETED ONE IS NOT. A delete sets `deleted_at` and keeps the
-- row and its history; a later write to the same path inserts a new row. The unique index is
-- therefore partial, over rows with `deleted_at IS NULL`.
--
-- `workspace_id` CARRIES NO FOREIGN KEY, like `artifacts` and `datasets`. The tenant purge
-- (packages/db/src/tenant-purge.ts) deletes both desk tables' rows by desk before the organization
-- cascade, and `desk_file_versions` follows its file through the one foreign key below.
--
-- ONE-WAY AND ADDITIVE: three new tables, nothing existing is altered. The runner is forward-only
-- and has no `down`.
--
-- NUMBERING. The runner applies a migration only when `lastAppliedCreatedAt < entry.when`, so `when`
-- decides what runs and `idx` is cosmetic. This file carries 1788820000015, above 0021's
-- 1788820000014, and its journal entry sits last. Declared defensively (`IF NOT EXISTS`) like
-- 0010-0021: a database baseline-stamped past this point has the journal row without the tables,
-- and `ensureDeskFileTables` in `ensure-schema.ts` re-creates them there. Times are epoch
-- milliseconds, as everywhere else in this schema.
CREATE TABLE IF NOT EXISTS `desk_files` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `path` text NOT NULL,
  `head_version` integer NOT NULL,
  `bytes` integer NOT NULL,
  `mime` text NOT NULL,
  `sha256` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `desk_files_live_path_unique` ON `desk_files` (`workspace_id`,`path`) WHERE `deleted_at` IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `desk_files_ws_idx` ON `desk_files` (`workspace_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `desk_file_versions` (
  `file_id` text NOT NULL REFERENCES `desk_files`(`id`) ON DELETE cascade,
  `version` integer NOT NULL,
  `object_key` text NOT NULL,
  `bytes` integer NOT NULL,
  `sha256` text NOT NULL,
  `author_kind` text NOT NULL,
  `author_id` text NOT NULL,
  `mode` text,
  `created_at` integer NOT NULL,
  PRIMARY KEY(`file_id`, `version`),
  CONSTRAINT `desk_file_versions_author_kind_check` CHECK (`author_kind` IN ('user', 'agent'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `file_proposals` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `run_id` text NOT NULL,
  `path` text NOT NULL,
  `kind` text NOT NULL,
  `before_sha256` text,
  `after_body` text,
  `status` text NOT NULL,
  `created_at` integer NOT NULL,
  `decided_at` integer,
  CONSTRAINT `file_proposals_kind_check` CHECK (`kind` IN ('write', 'delete')),
  CONSTRAINT `file_proposals_status_check` CHECK (`status` IN ('pending', 'approved', 'applied', 'rejected', 'stale', 'failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `file_proposals_ws_status_idx` ON `file_proposals` (`workspace_id`,`status`);
