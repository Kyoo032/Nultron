CREATE TABLE IF NOT EXISTS `agent_tool_allowlist` (
	`agent_id` text NOT NULL,
	`tool_key` text NOT NULL,
	PRIMARY KEY(`agent_id`, `tool_key`)
);
