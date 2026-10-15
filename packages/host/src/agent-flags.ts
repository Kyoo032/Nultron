import {
  canAdminister,
  isDefaultChatAgent,
  isVirtualAgentSlug,
  type AgentRecord,
  type TenantContext,
} from "@agentforge/core";
import { DrizzleAgentRepository, db } from "@agentforge/db";
import { isPromptMadeVersion } from "./prompt-made-agent";

const repo = new DrizzleAgentRepository(db);

export type AgentFlags = {
  madeFromPrompt: boolean;
  deletable: boolean;
};

export function mayDeleteAgent(tenant: TenantContext, agent: AgentRecord): boolean {
  if (isDefaultChatAgent(agent) || isVirtualAgentSlug(agent.slug)) {
    return false;
  }
  return agent.createdByUserId === tenant.userId || canAdminister(tenant.role);
}

export async function agentFlagsFor(tenant: TenantContext, agent: AgentRecord): Promise<AgentFlags> {
  const version = agent.currentVersionId
    ? await repo.findVersionById(tenant.organizationId, agent.currentVersionId)
    : null;
  return {
    madeFromPrompt: version !== null && isPromptMadeVersion(version),
    deletable: mayDeleteAgent(tenant, agent),
  };
}

export async function withAgentFlags<T extends AgentRecord>(
  tenant: TenantContext,
  agents: readonly T[],
): Promise<Array<T & AgentFlags>> {
  return Promise.all(agents.map(async (agent) => ({ ...agent, ...(await agentFlagsFor(tenant, agent)) })));
}
