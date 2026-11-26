import { sql } from "@agentforge/db";
import { installAgentAllowlistLookup, installJudgeUsageSink } from "@agentforge/core";
import { recordTokenUsage } from "./usage-record";

/**
 * F6 layer 2 (B6) — the host half of the per-agent tool allowlist.
 *
 * The table (`0031_agent_tool_allowlist.sql`) is agent-scoped, not tenant-scoped:
 * agent ids are already per-organization and the run's tools come from the agent's
 * own bindings, so a row can only restrict tools the agent was offered anyway.
 *
 * Lookup is per tool call inside `invokeToolGuarded`, so reads go through a small
 * process cache invalidated on every write — the schema has no versioning to watch.
 *
 * An agent with no rows returns `null` = "no list" = today's unrestricted behaviour.
 * The distinction from an empty array matters: `[]` would deny every tool.
 */

const cache = new Map<string, readonly string[] | null>();

/** The agent's allowed keys, or `null` when the agent has no list. */
export function agentToolAllowlistGet(agentId: string): readonly string[] | null {
  const cached = cache.get(agentId);
  if (cached !== undefined || cache.has(agentId)) return cached ?? null;
  const rows = sql
    .prepare("SELECT tool_key FROM agent_tool_allowlist WHERE agent_id = ? ORDER BY tool_key")
    .all(agentId) as { tool_key: string }[];
  const list = rows.length === 0 ? null : Object.freeze(rows.map((row) => row.tool_key));
  cache.set(agentId, list);
  return list;
}

/**
 * Replace the agent's list atomically. `[]` deletes the rows — back to unrestricted —
 * which is what the API's explicit empty payload must mean (a UI cannot express
 * "allow nothing" without it being a footgun for every unsaved agent).
 */
export function agentToolAllowlistReplace(agentId: string, toolKeys: readonly string[]): void {
  const remove = sql.prepare("DELETE FROM agent_tool_allowlist WHERE agent_id = ?");
  const insert = sql.prepare("INSERT OR IGNORE INTO agent_tool_allowlist (agent_id, tool_key) VALUES (?, ?)");
  sql.transaction(() => {
    remove.run(agentId);
    for (const key of [...new Set(toolKeys)]) {
      insert.run(agentId, key);
    }
  })();
  cache.delete(agentId);
}

/** Install the core lookup — same seam as `audit/install.ts`, invoked from `router.ts`. */
export function installAgentToolAllowlist(): void {
  installAgentAllowlistLookup(agentToolAllowlistGet);
}

installAgentToolAllowlist();

// F6 (B2): one `injection_judge` ledger row per judge call — metered under its own mode
// so the defence's spend shows up separately from the run it protects.
installJudgeUsageSink((tenant, usage) => {
  recordTokenUsage(
    tenant,
    { model: usage.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
    { mode: "injection_judge" },
  );
});
