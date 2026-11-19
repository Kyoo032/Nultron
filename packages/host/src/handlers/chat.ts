import { isDefaultChatAgent, isVirtualAgentSlug } from "@agentforge/core";
import type { HostRequest, HostResult } from "../types";
import { jsonError, jsonOk } from "../errors";
import { agentService, getTenant } from "../tenant";
import { defaultSelectableModel, listSelectableModels } from "../selectable-models";
import { tierCatalogFields } from "../tier-resolve";

export async function handleGetChat(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    const ready = await agentService.ensureDefaultChat(tenant);
    const specialists = (await agentService.list(tenant))
      .filter((agent) => !isDefaultChatAgent(agent) && agent.currentVersionId)
      // A mode agent's row owns its threads; it is not an agent a person built (`../virtual-agents.ts`).
      .filter((agent) => !isVirtualAgentSlug(agent.slug))
      .filter((agent) => !/office[- ]hours/i.test(agent.slug) && !/office hours/i.test(agent.name))
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        description: agent.description,
      }));
    const models = listSelectableModels(tenant);
    return jsonOk({
      agent: ready.agent,
      version: ready.version,
      models,
      defaultModel: defaultSelectableModel(undefined, tenant),
      ...tierCatalogFields(models, tenant),
      specialists,
    });
  } catch (error) {
    return jsonError(error);
  }
}
