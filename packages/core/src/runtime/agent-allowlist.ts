/**
 * F6 layer 2, spec B6 — the per-agent tool allowlist seam.
 *
 * The list itself lives in the host database (`agent_tool_allowlist`, host migration
 * 0031): core cannot open it, so the host installs a lookup here
 * (`packages/host/src/agent-tool-allowlist.ts`, imported through `router.ts` for the
 * same seam reason as `audit/install.ts`). `invokeToolGuarded` asks it beside the
 * disabled-tools check.
 *
 * Semantics (spec's own words): an agent with NO rows keeps today's behaviour — every
 * offered tool may run. A `null` lookup (no host install — desktop, webdev, unit
 * tests) means "no allowlist feature", also today's behaviour.
 */
export type AgentAllowlistLookup = (agentId: string) => readonly string[] | null;

let lookup: AgentAllowlistLookup | null = null;

export function installAgentAllowlistLookup(next: AgentAllowlistLookup | null): void {
  lookup = next;
}

/**
 * The agent's allowed tool keys, or `null` when no list exists — which must read as
 * "unrestricted", never as "deny all" (an empty table would otherwise brick every
 * agent the moment the feature ships).
 */
export function agentAllowedTools(agentId: string): readonly string[] | null {
  return lookup ? lookup(agentId) : null;
}
