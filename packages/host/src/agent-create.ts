import {
  ApiError,
  DEFAULT_CHAT_MODALITIES,
  type AgentRecord,
  type AgentVersionRecord,
  type TenantContext,
} from "@agentforge/core";
import { defaultSelectableModel, listSelectableModels } from "./selectable-models";
import { ensureToolsRegistered } from "./register-tools";
import { removeAgentRow } from "./agent-delete";
import { agentDraftSchema, refusedToolsFor, type AgentDraft } from "./agent-draft";
import { promptMadeConfig } from "./prompt-made-agent";
import { agentService } from "./tenant";

export function readAgentDraftBody(body: unknown): AgentDraft {
  ensureToolsRegistered();
  const parsed = agentDraftSchema.safeParse(body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".") || "body";
    throw new ApiError("invalid_request", `${field}: ${issue?.message ?? "is not valid"}`, 400);
  }
  const refused = refusedToolsFor(parsed.data.baseMode, parsed.data.tools);
  if (refused.length > 0) {
    throw new ApiError(
      "invalid_request",
      `tools not available for ${parsed.data.baseMode}: ${refused.join(", ")}`,
      400,
    );
  }
  const tools = [...new Set(parsed.data.tools)];
  return { ...parsed.data, tools };
}

export type PromptAgentAnswer = {
  agent: AgentRecord;
  version: AgentVersionRecord;
  tools: string[];
};

export async function createPromptAgent(tenant: TenantContext, draft: AgentDraft): Promise<PromptAgentAnswer> {
  const created = await agentService.createPromptMade(
    tenant,
    {
      name: draft.name,
      description: draft.description,
      systemPrompt: draft.instructions,
      model: defaultSelectableModel(undefined, tenant),
      inputModalities: [...DEFAULT_CHAT_MODALITIES],
      productModes: ["chat"],
      config: promptMadeConfig(draft.baseMode),
    },
    draft.tools,
    listSelectableModels(tenant),
  );
  try {
    const published = await agentService.publish(tenant, created.agent.id, created.version.id);
    return { agent: published, version: created.version, tools: [...draft.tools] };
  } catch (error) {
    await removeAgentRow(tenant, created.agent.id).catch(() => undefined);
    throw error;
  }
}
