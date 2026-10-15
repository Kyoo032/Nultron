import { VIRTUAL_AGENTS, type TenantContext, type VirtualAgent } from "@agentforge/core";
import { findMemberProject, hasProjectAgent } from "../projects/store";
import { virtualAgentsOnDesk } from "../virtual-agents";

export async function agentForProposal(
  tenant: TenantContext,
  projectId: string | null,
  agentId: string,
): Promise<VirtualAgent | null> {
  const agent = VIRTUAL_AGENTS.find((candidate) => candidate.id === agentId);
  if (agent === undefined) {
    return null;
  }
  if (projectId !== null && findMemberProject(tenant, projectId) !== null) {
    return agent.generalist || hasProjectAgent(projectId, agent.id) ? agent : null;
  }
  const onDesk = await virtualAgentsOnDesk(tenant);
  return onDesk.some((candidate) => candidate.id === agent.id) ? agent : null;
}
