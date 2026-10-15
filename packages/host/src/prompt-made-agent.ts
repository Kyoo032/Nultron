import type { AgentVersionRecord } from "@agentforge/core";

export const PROMPT_MADE_CONFIG_KEY = "madeFromPrompt";

export function promptMadeConfig(baseMode: string): Record<string, unknown> {
  return { baseMode, [PROMPT_MADE_CONFIG_KEY]: true };
}

export function isPromptMadeVersion(version: Pick<AgentVersionRecord, "config">): boolean {
  return version.config?.[PROMPT_MADE_CONFIG_KEY] === true;
}
