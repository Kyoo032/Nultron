import { z } from "zod";
import {
  ApiError,
  PRODUCT_MODE_IDS,
  harnessSpecFor,
  getTool,
  hasLiveProvider,
  isServerMode,
  productModeLabel,
  resolveRuntimeMode,
  type ProductMode,
  type TenantContext,
} from "@agentforge/core";
import { requireGatewayAllowed } from "./gateway-gate";
import { collectJobAssistantText } from "./job-regen";
import { defaultSelectableModel } from "./selectable-models";
import { loadSettings } from "./settings-store";
import { ensureToolsRegistered } from "./register-tools";

export const AGENT_NAME_MAX = 80;
export const AGENT_DESCRIPTION_MAX = 200;
export const AGENT_INSTRUCTIONS_MAX = 6000;
export const AGENT_PROMPT_MAX = 2000;
export const AGENT_TOOLS_MAX = 40;

const MODE_IDS = PRODUCT_MODE_IDS as [ProductMode, ...ProductMode[]];

export const agentDraftSchema = z.object({
  name: z.string().trim().min(1).max(AGENT_NAME_MAX),
  description: z.string().trim().max(AGENT_DESCRIPTION_MAX).default(""),
  instructions: z.string().trim().min(1).max(AGENT_INSTRUCTIONS_MAX),
  baseMode: z.enum(MODE_IDS),
  tools: z.array(z.string().trim().min(1).max(AGENT_NAME_MAX)).max(AGENT_TOOLS_MAX).default([]),
});

export type AgentDraft = {
  name: string;
  description: string;
  instructions: string;
  baseMode: ProductMode;
  tools: string[];
};

export type AgentDraftAnswer = {
  draft: AgentDraft;
  source: "live" | "stub";
};

export function readDraftPrompt(body: unknown): string {
  const raw = body && typeof body === "object" ? (body as { prompt?: unknown }).prompt : undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ApiError("invalid_request", "prompt is required", 400);
  }
  const prompt = raw.trim();
  if (prompt.length > AGENT_PROMPT_MAX) {
    throw new ApiError("invalid_request", `prompt must be ${AGENT_PROMPT_MAX} characters or fewer`, 400);
  }
  return prompt;
}

export function toolsAvailableFor(baseMode: ProductMode): string[] {
  return [...harnessSpecFor(baseMode).tools];
}

export function keepModeTools(baseMode: ProductMode, tools: readonly string[]): string[] {
  const allowed = new Set(toolsAvailableFor(baseMode));
  const kept: string[] = [];
  for (const toolKey of tools) {
    if (allowed.has(toolKey) && getTool(toolKey) && !kept.includes(toolKey)) {
      kept.push(toolKey);
    }
  }
  return kept;
}

export function refusedToolsFor(baseMode: ProductMode, tools: readonly string[]): string[] {
  const allowed = new Set(toolsAvailableFor(baseMode));
  return tools.filter((toolKey) => !allowed.has(toolKey) || getTool(toolKey) === undefined);
}

function invalidDraft(): ApiError {
  return new ApiError(
    "model_output_invalid",
    "The model did not write an agent in the expected form. Try again with a clearer description.",
    502,
  );
}

function jsonObjectText(raw: string): string | null {
  const unfenced = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  return start < 0 || end <= start ? null : unfenced.slice(start, end + 1);
}

export function parseAgentDraftReply(raw: string): AgentDraft {
  const text = jsonObjectText(raw);
  if (text === null) {
    throw invalidDraft();
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalidDraft();
  }
  const parsed = agentDraftSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidDraft();
  }
  const { tools, ...rest } = parsed.data;
  return { ...rest, tools: keepModeTools(rest.baseMode, tools) };
}

export function stubAgentDraft(prompt: string): AgentDraft {
  const words = prompt.split(/\s+/).filter((word) => word.length > 0);
  const name = words.slice(0, 6).join(" ").slice(0, AGENT_NAME_MAX) || "Agent";
  return {
    name,
    description: prompt.slice(0, AGENT_DESCRIPTION_MAX),
    instructions: prompt,
    baseMode: "chat",
    tools: [],
  };
}

const MODE_CATALOG = PRODUCT_MODE_IDS.map((id) => {
  const tools = toolsAvailableFor(id);
  return `- ${id} (${productModeLabel(id)}): ${tools.length > 0 ? tools.join(", ") : "no tools"}`;
}).join("\n");

export const AGENT_DRAFT_SYSTEM_PROMPT = [
  "You design one agent for a person from their request. Answer with one JSON object and nothing else.",
  "Fields:",
  `- "name": a short name, at most ${AGENT_NAME_MAX} characters.`,
  `- "description": one line, at most ${AGENT_DESCRIPTION_MAX} characters.`,
  `- "instructions": what the agent does and how it answers, written to the agent as "you", at most ${AGENT_INSTRUCTIONS_MAX} characters.`,
  "- \"baseMode\": one id from the list below, the mode whose work the agent does most.",
  "- \"tools\": only names listed under the chosen baseMode. Use [] when the agent needs no tool.",
  "Write name, description and instructions in the language of the request.",
  "Modes and their tools:",
  MODE_CATALOG,
].join("\n");

export async function draftAgent(tenant: TenantContext, prompt: string): Promise<AgentDraftAnswer> {
  const settings = loadSettings(tenant);
  const mode = resolveRuntimeMode({
    settingsHasKey: hasLiveProvider(settings),
    envRuntime: process.env.AGENTFORGE_RUNTIME,
  });
  if (mode === "stub" && !isServerMode()) {
    return { draft: stubAgentDraft(prompt), source: "stub" };
  }
  requireGatewayAllowed(settings, { tenant });
  ensureToolsRegistered();
  const raw = await collectJobAssistantText({
    tenant,
    model: defaultSelectableModel(undefined, tenant),
    systemPrompt: AGENT_DRAFT_SYSTEM_PROMPT,
    runPrefix: "agent-draft",
    agentId: "agent-draft",
    versionId: "agent-draft",
    prompt,
  });
  return { draft: parseAgentDraftReply(raw), source: "live" };
}
