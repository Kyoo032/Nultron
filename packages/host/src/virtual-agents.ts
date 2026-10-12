import { db, DrizzleAgentRepository, listLocalWorkspaces } from "@agentforge/db";
import {
  DEFAULT_CHAT_MODALITIES,
  DEFAULT_CHAT_MODEL,
  GENERALIST_WORKER_TOOLS,
  VIRTUAL_AGENTS,
  productModeLabel,
  resolveWorkspaceModes,
  virtualAgentBySlug,
  virtualAgentsForDesk,
  type AgentRecord,
  type AgentVersionRecord,
  type ProductMode,
  type RunBudget,
  type TenantContext,
  type ToolBindingRecord,
  type VirtualAgent,
} from "@agentforge/core";
import { agentService } from "./tenant";

/**
 * Virtual agents on the host (tester code, `docs/internal/chat-first-plan.md` track B).
 *
 * Every mode agent on a desk owns one agent row there, slug `va-<mode>`, so its threads are
 * its own and the thread list can be asked for by agent. The row is only an owner for threads: the
 * prompt, the tools and the budget of a run come from the registry in code (`runPolicyFor`), never
 * from the row or its binding rows, so nothing stored on a desk can widen what an agent may do.
 */

const repo = new DrizzleAgentRepository(db);

/** One ensure at a time per desk, person and agent: two first requests must not insert two rows. */
const pending = new Map<string, Promise<AgentRecord>>();

async function insertVirtualAgentRow(tenant: TenantContext, agent: VirtualAgent): Promise<AgentRecord> {
  const existing = (await repo.listAgents(tenant.organizationId, tenant.workspaceId)).find(
    (row) => row.slug === agent.slug && row.createdByUserId === tenant.userId,
  );
  if (existing) {
    return existing;
  }
  const timestamp = new Date();
  const agentId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const row: AgentRecord = {
    id: agentId,
    organizationId: tenant.organizationId,
    workspaceId: tenant.workspaceId,
    name: productModeLabel(agent.id),
    slug: agent.slug,
    description: "",
    visibility: "private",
    createdByUserId: tenant.userId,
    currentVersionId: versionId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const version: AgentVersionRecord = {
    id: versionId,
    agentId,
    organizationId: tenant.organizationId,
    version: 1,
    // A copy for anyone reading the row. A run takes the prompt from the registry.
    systemPrompt: agent.prompt,
    model: DEFAULT_CHAT_MODEL,
    // What Chat takes. A run reads this from the registry too, so an older row made with less still works.
    inputModalities: [...DEFAULT_CHAT_MODALITIES],
    // `chat`, not the agent's own mode: a job mode reads other agents' `productModes` for its
    // generation defaults, and this row must never be read as one of those.
    productModes: ["chat"],
    config: { virtualAgent: agent.id },
    createdAt: timestamp,
  };
  await repo.insertAgent(row);
  await repo.insertVersion(version);
  return row;
}

/** The agent row that owns this virtual agent's threads on the tenant's desk, created on first use. */
export async function ensureVirtualAgentRow(tenant: TenantContext, agent: VirtualAgent): Promise<AgentRecord> {
  if (agent.generalist) {
    return (await agentService.ensureDefaultChat(tenant)).agent;
  }
  const key = `${tenant.organizationId}:${tenant.workspaceId}:${tenant.userId}:${agent.slug}`;
  const running = pending.get(key);
  if (running) {
    return running;
  }
  const work = insertVirtualAgentRow(tenant, agent).finally(() => pending.delete(key));
  pending.set(key, work);
  return work;
}

async function deskModes(tenant: TenantContext): Promise<ProductMode[]> {
  const rows = await listLocalWorkspaces(db, tenant.organizationId);
  const desk = rows.find((row) => row.id === tenant.workspaceId);
  return resolveWorkspaceModes(desk?.productModes);
}

export type VirtualAgentView = {
  readonly id: ProductMode;
  readonly generalist: boolean;
  readonly conversation: VirtualAgent["conversation"];
  /** The row that owns its threads. Null only for an agent the desk has not hired. */
  readonly agentId: string | null;
  readonly loop: VirtualAgent["loop"];
  readonly tools: readonly string[];
  readonly budget: { readonly maxSteps: number; readonly maxToolCalls: number };
  readonly repairRounds: number;
  readonly skills: VirtualAgent["skills"];
};

function viewOf(agent: VirtualAgent, agentId: string | null): VirtualAgentView {
  return {
    id: agent.id,
    generalist: agent.generalist,
    conversation: agent.conversation,
    agentId,
    loop: agent.loop,
    tools: agent.tools,
    budget: { maxSteps: agent.budget.maxSteps, maxToolCalls: agent.budget.maxToolCalls },
    repairRounds: agent.repairRounds,
    skills: agent.skills,
  };
}

export type VirtualAgentCatalog = {
  /** On the desk: the generalist, then the desk's own modes. */
  readonly agents: VirtualAgentView[];
  /** Every other agent in the registry, which the desk could hire. No row is made for these. */
  readonly available: VirtualAgentView[];
};

/**
 * The desk's agents as the renderer draws them, and the ones it could still hire. No prompt: it is
 * the host's, and the screen has no use for it. A row is made only for an agent that is on the desk.
 */
export async function listVirtualAgents(tenant: TenantContext): Promise<VirtualAgentCatalog> {
  const onDesk = virtualAgentsForDesk(await deskModes(tenant));
  const agents: VirtualAgentView[] = [];
  for (const agent of onDesk) {
    // Every agent on the desk converses, so every one owns a row for its threads.
    const row = await ensureVirtualAgentRow(tenant, agent);
    agents.push(viewOf(agent, row.id));
  }
  const hired = new Set(onDesk.map((agent) => agent.id));
  const available = VIRTUAL_AGENTS.filter((agent) => !hired.has(agent.id)).map((agent) => viewOf(agent, null));
  return { agents, available };
}

/**
 * The default agent's bindings plus one for each worker it may run from its own chat
 * (`GENERALIST_WORKER_TOOLS`). Made here, like a mode agent's, so no desk needs a stored row for a
 * worker and none can be switched off by editing one. A key the desk already binds is left as it is.
 */
export function withGeneralistWorkers(bindings: ToolBindingRecord[]): ToolBindingRecord[] {
  const have = new Set(bindings.map((binding) => binding.toolKey));
  const added: ToolBindingRecord[] = GENERALIST_WORKER_TOOLS.filter((toolKey) => !have.has(toolKey)).map(
    (toolKey) => ({
      id: `virtual-chat-${toolKey}`,
      agentVersionId: bindings[0]?.agentVersionId ?? "",
      organizationId: bindings[0]?.organizationId ?? "",
      toolKey,
      config: {},
      enabled: true,
    }),
  );
  return added.length === 0 ? bindings : [...bindings, ...added];
}

export type VirtualAgentRunPolicy = {
  readonly agent: VirtualAgent;
  readonly systemPrompt: string;
  /** Goes after everything the run appends to the prompt (the Soul block, retrieved knowledge). */
  readonly closingPrompt: string;
  readonly bindings: ToolBindingRecord[];
  readonly budget: RunBudget;
};

/**
 * What a run of a mode agent's conversation is allowed, or null when the row is not a mode agent's
 * (the generalist keeps its own path, an agent a person built keeps its bindings). The bindings are
 * made here from the registry, so a binding row added to the agent by hand is never read.
 */
export function runPolicyFor(
  published: { agent: Pick<AgentRecord, "slug">; version: Pick<AgentVersionRecord, "id" | "organizationId"> },
): VirtualAgentRunPolicy | null {
  const agent = virtualAgentBySlug(published.agent.slug);
  if (!agent || agent.generalist) {
    return null;
  }
  return {
    agent,
    systemPrompt: agent.prompt,
    closingPrompt: agent.closing,
    bindings: agent.tools.map((toolKey) => ({
      id: `virtual-${agent.id}-${toolKey}`,
      agentVersionId: published.version.id,
      organizationId: published.version.organizationId,
      toolKey,
      config: {},
      enabled: true,
    })),
    budget: agent.budget,
  };
}
