import { ApiError, canAdminister, isDefaultChatAgent, isVirtualAgentSlug, type TenantContext } from "@agentforge/core";
import { DrizzleAgentRepository, db, sql } from "@agentforge/db";
import { deleteSourceByOrigin } from "./knowledge";
import { removeGraphForThread } from "./knowledge-graph-prune";
import { log } from "./log";
import { agentService } from "./tenant";

const repo = new DrizzleAgentRepository(db);

export type AgentDeleteAnswer = {
  chatsDeleted: number;
  workspacesRemoved: number;
};

type ThreadOwner = { id: string; user_id: string };

function notFound(): ApiError {
  return new ApiError("not_found", "Agent not found", 404);
}

function chatsOf(organizationId: string, agentId: string): ThreadOwner[] {
  return sql
    .prepare("SELECT id, user_id FROM threads WHERE organization_id = ? AND agent_id = ?")
    .all(organizationId, agentId) as ThreadOwner[];
}

function workspacesOf(agentId: string): number {
  const row = sql
    .prepare("SELECT count(DISTINCT project_id) AS n FROM project_agents WHERE agent_id = ?")
    .get(agentId) as { n: number };
  return row.n;
}

function dropRows(tenant: TenantContext, agentId: string): void {
  sql.transaction(() => {
    sql.prepare("DELETE FROM project_agents WHERE agent_id = ?").run(agentId);
    sql.prepare("DELETE FROM doc_proposals WHERE agent_id = ? AND status = 'pending'").run(agentId);
    sql
      .prepare("DELETE FROM agents WHERE id = ? AND organization_id = ? AND workspace_id = ?")
      .run(agentId, tenant.organizationId, tenant.workspaceId);
  })();
}

function forgetChatKnowledge(owner: TenantContext, threadId: string): void {
  try {
    deleteSourceByOrigin(owner, { kind: "thread", id: threadId });
    removeGraphForThread(owner, threadId);
  } catch (error) {
    log.warn("agent_delete_knowledge_not_dropped", {
      threadId,
      detail: error instanceof Error ? error.message : "unknown",
    });
  }
}

export async function removeAgentRow(tenant: TenantContext, agentId: string): Promise<void> {
  dropRows(tenant, agentId);
}

export async function deleteAgentFor(tenant: TenantContext, agentId: string): Promise<AgentDeleteAnswer> {
  const agent = await repo.findAgentById(tenant.organizationId, agentId);
  if (!agent || agent.workspaceId !== tenant.workspaceId) {
    throw notFound();
  }
  const isMaker = agent.createdByUserId === tenant.userId;
  if (!isMaker && !canAdminister(tenant.role)) {
    const visible = (await agentService.get(tenant, agentId)) !== null;
    throw visible
      ? new ApiError("forbidden", "Only the maker or an admin can delete this agent.", 403)
      : notFound();
  }
  if (isDefaultChatAgent(agent) || isVirtualAgentSlug(agent.slug)) {
    throw new ApiError("not_deletable", "This agent is built in and cannot be deleted.", 409);
  }
  const chats = chatsOf(tenant.organizationId, agentId);
  if (agent.visibility === "workspace" && chats.some((chat) => chat.user_id !== agent.createdByUserId)) {
    throw new ApiError(
      "agent_in_use",
      "Another person has a chat with this agent, so it cannot be deleted. Nothing was removed.",
      409,
    );
  }
  const workspacesRemoved = workspacesOf(agentId);
  dropRows(tenant, agentId);
  for (const chat of chats) {
    forgetChatKnowledge({ ...tenant, userId: chat.user_id }, chat.id);
  }
  return { chatsDeleted: chats.length, workspacesRemoved };
}
