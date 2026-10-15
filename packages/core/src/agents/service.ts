import { ApiError } from "../errors";
import type { InputModality, TenantContext, Visibility } from "../tenancy/types";
import { canAdminister, canBuild } from "../tenancy/types";
import {
  DEFAULT_CHAT_DESCRIPTION,
  DEFAULT_CHAT_MODALITIES,
  DEFAULT_CHAT_MODEL,
  DEFAULT_CHAT_NAME,
  DEFAULT_CHAT_PROMPT,
  DEFAULT_CHAT_SLUG,
  DEFAULT_CHAT_TOOLS,
  isDefaultChatAgent,
} from "./default-chat";
import { getChatModel, listChatModels, type ChatModel } from "../models/catalog";
import { isProductMode, requireProductModes, resolveProductModes, type ProductMode } from "./product-modes";
import { mergeGeneratePins } from "./generate-defaults";
import { isVirtualAgentSlug } from "./virtual-agents";
import { harnessSpecFor } from "../harness/specs";

export type AgentRecord = {
  id: string;
  organizationId: string;
  workspaceId: string;
  name: string;
  slug: string;
  description: string;
  visibility: Visibility;
  createdByUserId: string;
  currentVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AgentVersionRecord = {
  id: string;
  agentId: string;
  organizationId: string;
  version: number;
  systemPrompt: string;
  model: string;
  inputModalities: InputModality[];
  productModes?: ProductMode[] | null;
  config: Record<string, unknown>;
  createdAt: Date;
};

export type ToolBindingRecord = {
  id: string;
  agentVersionId: string;
  organizationId: string;
  toolKey: string;
  config: Record<string, unknown>;
  enabled: boolean;
};

export type CreateAgentInput = {
  name: string;
  description?: string;
  systemPrompt: string;
  model: string;
  inputModalities?: InputModality[];
  productModes?: ProductMode[];
  visibility?: Visibility;
  config?: Record<string, unknown>;
};

export type CreateRevisionInput = {
  systemPrompt?: string;
  model?: string;
  inputModalities?: InputModality[];
  toolKeys?: string[];
};

export interface AgentRepository {
  insertAgent(agent: AgentRecord): Promise<void>;
  insertVersion(version: AgentVersionRecord): Promise<void>;
  insertBinding(binding: ToolBindingRecord): Promise<void>;
  findAgentById(organizationId: string, agentId: string): Promise<AgentRecord | null>;
  listAgents(organizationId: string, workspaceId: string): Promise<AgentRecord[]>;
  findVersionById(organizationId: string, versionId: string): Promise<AgentVersionRecord | null>;
  listVersions(organizationId: string, agentId: string): Promise<AgentVersionRecord[]>;
  listBindings(organizationId: string, agentVersionId: string): Promise<ToolBindingRecord[]>;
  updateAgent(organizationId: string, agentId: string, patch: Partial<AgentRecord>): Promise<void>;
  updateVersion(
    organizationId: string,
    versionId: string,
    patch: Partial<Pick<AgentVersionRecord, "productModes" | "config">>,
  ): Promise<void>;
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  const base = slug.length > 0 ? slug : "agent";
  return base === DEFAULT_CHAT_SLUG || isVirtualAgentSlug(base) ? `agent-${base}` : base;
}

const PROMPT_MADE_KEY = "madeFromPrompt";

function assertPromptMadeTools(baseMode: string, toolKeys: readonly string[]): void {
  const allowed = new Set<string>(isProductMode(baseMode) ? harnessSpecFor(baseMode).tools : []);
  const refused = toolKeys.filter((toolKey) => !allowed.has(toolKey));
  if (refused.length > 0) {
    throw new ApiError("invalid_request", `tools not available for ${baseMode}: ${refused.join(", ")}`, 400);
  }
}

function assertVersionTools(version: Pick<AgentVersionRecord, "config">, toolKeys: readonly string[]): void {
  if (version.config?.[PROMPT_MADE_KEY] !== true) {
    return;
  }
  const baseMode = version.config.baseMode;
  assertPromptMadeTools(typeof baseMode === "string" ? baseMode : "", toolKeys);
}

function ensureModalities(input?: InputModality[]): InputModality[] {
  const modalities = input && input.length > 0 ? input : (["text"] as InputModality[]);
  if (!modalities.includes("text")) {
    return ["text", ...modalities];
  }
  return [...new Set(modalities)];
}

function canView(agent: AgentRecord, tenant: TenantContext, serverMode: boolean): boolean {
  if (agent.organizationId !== tenant.organizationId) {
    return false;
  }
  if (agent.workspaceId !== tenant.workspaceId) {
    return false;
  }
  if (agent.visibility === "workspace") {
    return true;
  }
  if (agent.createdByUserId === tenant.userId) {
    return true;
  }
  return !serverMode && canAdminister(tenant.role);
}

export function resolvePublishedVersion(
  agent: AgentRecord,
  versions: AgentVersionRecord[],
): AgentVersionRecord {
  if (!agent.currentVersionId) {
    throw new ApiError("unpublished_agent", "Agent has no published version", 400);
  }
  const published = versions.find((version) => version.id === agent.currentVersionId);
  if (!published) {
    throw new ApiError("unpublished_agent", "Published version was not found", 400);
  }
  return published;
}

/**
 * The default chat's soul cannot be edited (`default_agent_soul`), so the code is its only source.
 * A desk made before a prompt change still stores the old text in its version row; without this it
 * would bind the new tools and never be told about them. Read-time only: the stored row is untouched.
 */
function withCurrentChatSoul(agent: AgentRecord, version: AgentVersionRecord): AgentVersionRecord {
  if (!isDefaultChatAgent(agent) || version.systemPrompt === DEFAULT_CHAT_PROMPT) {
    return version;
  }
  return { ...version, systemPrompt: DEFAULT_CHAT_PROMPT };
}

export class AgentService {
  constructor(
    private readonly repo: AgentRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = () => crypto.randomUUID(),
    private readonly serverMode: () => boolean = () => false,
  ) {}

  private canSee(agent: AgentRecord, tenant: TenantContext): boolean {
    return canView(agent, tenant, this.serverMode());
  }

  async create(
    tenant: TenantContext,
    input: CreateAgentInput,
    knownModels: ChatModel[] = listChatModels(),
  ): Promise<{ agent: AgentRecord; version: AgentVersionRecord }> {
    if (!canBuild(tenant.role)) {
      throw new ApiError("forbidden", "Builder role required", 403);
    }
    return this.insertNew(tenant, input, knownModels, this.id());
  }

  async createPromptMade(
    tenant: TenantContext,
    input: Omit<CreateAgentInput, "visibility">,
    toolKeys: readonly string[],
    knownModels: ChatModel[] = listChatModels(),
    agentId: string = this.id(),
  ): Promise<{ agent: AgentRecord; version: AgentVersionRecord }> {
    const baseMode = input.config?.baseMode;
    if (input.config?.[PROMPT_MADE_KEY] !== true || typeof baseMode !== "string") {
      throw new ApiError("invalid_request", "A prompt-made agent needs a base mode", 400);
    }
    assertPromptMadeTools(baseMode, toolKeys);
    const { agent, version } = await this.insertNew(tenant, { ...input, visibility: "private" }, knownModels, agentId);
    for (const toolKey of toolKeys) {
      await this.repo.insertBinding({
        id: this.id(),
        agentVersionId: version.id,
        organizationId: tenant.organizationId,
        toolKey,
        config: {},
        enabled: true,
      });
    }
    return { agent, version };
  }

  private async insertNew(
    tenant: TenantContext,
    input: CreateAgentInput,
    knownModels: ChatModel[],
    agentId: string,
  ): Promise<{ agent: AgentRecord; version: AgentVersionRecord }> {
    if (typeof input.name !== "string" || input.name.trim().length === 0) {
      throw new ApiError("invalid_request", "name is required", 400);
    }
    if (!getChatModel(input.model, knownModels)) {
      throw new ApiError("unknown_model", `Model '${input.model}' is not available`, 400);
    }
    const timestamp = this.now();
    const versionId = this.id();
    const agent: AgentRecord = {
      id: agentId,
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      name: input.name,
      slug: slugify(input.name),
      description: input.description ?? "",
      visibility: input.visibility ?? "private",
      createdByUserId: tenant.userId,
      currentVersionId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const version: AgentVersionRecord = {
      id: versionId,
      agentId,
      organizationId: tenant.organizationId,
      version: 1,
      systemPrompt: input.systemPrompt,
      model: input.model,
      inputModalities: ensureModalities(input.inputModalities),
      productModes: requireProductModes(input.productModes),
      config: input.config ?? {},
      createdAt: timestamp,
    };
    await this.repo.insertAgent(agent);
    await this.repo.insertVersion(version);
    return { agent, version };
  }

  async listVisibleProductModes(tenant: TenantContext): Promise<ProductMode[]> {
    const agents = await this.list(tenant);
    const sources: Array<{ slug: string; productModes?: ProductMode[] | null }> = [];
    for (const agent of agents) {
      if (isDefaultChatAgent(agent) || !agent.currentVersionId) {
        continue;
      }
      const version = await this.repo.findVersionById(tenant.organizationId, agent.currentVersionId);
      sources.push({ slug: agent.slug, productModes: version?.productModes ?? null });
    }
    return resolveProductModes(sources);
  }

  async listGenerateDefaultSources(tenant: TenantContext): Promise<
    Array<{
      slug: string;
      createdAt: Date;
      productModes?: ProductMode[] | null;
      config?: Record<string, unknown> | null;
    }>
  > {
    const agents = await this.list(tenant);
    const sources: Array<{
      slug: string;
      createdAt: Date;
      productModes?: ProductMode[] | null;
      config?: Record<string, unknown> | null;
    }> = [];
    for (const agent of agents) {
      if (!agent.currentVersionId) {
        continue;
      }
      const version = await this.repo.findVersionById(tenant.organizationId, agent.currentVersionId);
      sources.push({
        slug: agent.slug,
        createdAt: agent.createdAt,
        productModes: version?.productModes ?? null,
        config: version?.config ?? {},
      });
    }
    return sources;
  }

  async updateProductModes(
    tenant: TenantContext,
    agentId: string,
    productModes: unknown,
  ): Promise<AgentVersionRecord> {
    const agent = await this.requireOwned(tenant, agentId);
    if (!agent.currentVersionId) {
      throw new ApiError("unpublished_agent", "Agent has no published version", 400);
    }
    const version = await this.repo.findVersionById(tenant.organizationId, agent.currentVersionId);
    if (!version || version.agentId !== agent.id) {
      throw new ApiError("not_found", "Version not found", 404);
    }
    const next = requireProductModes(productModes);
    const updated: AgentVersionRecord = { ...version, productModes: next };
    await this.repo.updateVersion(tenant.organizationId, version.id, { productModes: next });
    return updated;
  }

  async updateGenerateDefaults(
    tenant: TenantContext,
    agentId: string,
    patch: { imageGenModel?: string | null; videoGenModel?: string | null; musicGenModel?: string | null },
  ): Promise<AgentVersionRecord> {
    const agent = await this.requireOwned(tenant, agentId);
    if (!agent.currentVersionId) {
      throw new ApiError("unpublished_agent", "Agent has no published version", 400);
    }
    const version = await this.repo.findVersionById(tenant.organizationId, agent.currentVersionId);
    if (!version || version.agentId !== agent.id) {
      throw new ApiError("not_found", "Version not found", 404);
    }
    const config = mergeGeneratePins(version.config, patch);
    const updated: AgentVersionRecord = { ...version, config };
    await this.repo.updateVersion(tenant.organizationId, version.id, { config });
    return updated;
  }

  async get(tenant: TenantContext, agentId: string): Promise<AgentRecord | null> {
    const agent = await this.repo.findAgentById(tenant.organizationId, agentId);
    if (!agent || !this.canSee(agent, tenant)) {
      return null;
    }
    return agent;
  }

  async list(tenant: TenantContext): Promise<AgentRecord[]> {
    const agents = await this.repo.listAgents(tenant.organizationId, tenant.workspaceId);
    return agents.filter((agent) => this.canSee(agent, tenant));
  }

  async publish(tenant: TenantContext, agentId: string, versionId: string): Promise<AgentRecord> {
    const version = await this.repo.findVersionById(tenant.organizationId, versionId);
    const ownPromptMade =
      version !== null &&
      version.agentId === agentId &&
      version.config?.[PROMPT_MADE_KEY] === true &&
      !canBuild(tenant.role);
    const agent = ownPromptMade ? await this.requireMaker(tenant, agentId) : await this.requireOwned(tenant, agentId);
    if (!version || version.agentId !== agent.id) {
      throw new ApiError("not_found", "Version not found", 404);
    }
    const updated = { ...agent, currentVersionId: versionId, updatedAt: this.now() };
    await this.repo.updateAgent(tenant.organizationId, agentId, {
      currentVersionId: versionId,
      updatedAt: updated.updatedAt,
    });
    return updated;
  }

  async createRevision(
    tenant: TenantContext,
    agentId: string,
    input: CreateRevisionInput,
    knownModels: ChatModel[] = listChatModels(),
  ): Promise<{ version: AgentVersionRecord }> {
    const agent = await this.requireOwned(tenant, agentId);
    if (isDefaultChatAgent(agent)) {
      throw new ApiError("default_agent_soul", "Default chat agent soul cannot be edited", 400);
    }
    const versions = await this.repo.listVersions(tenant.organizationId, agentId);
    const published = resolvePublishedVersion(agent, versions);
    const model = input.model ?? published.model;
    if (!getChatModel(model, knownModels)) {
      throw new ApiError("unknown_model", `Model '${model}' is not available`, 400);
    }
    const nextNumber = Math.max(...versions.map((version) => version.version), 0) + 1;
    const versionId = this.id();
    const version: AgentVersionRecord = {
      id: versionId,
      agentId,
      organizationId: tenant.organizationId,
      version: nextNumber,
      systemPrompt: input.systemPrompt ?? published.systemPrompt,
      model,
      inputModalities: input.inputModalities
        ? ensureModalities(input.inputModalities)
        : [...published.inputModalities],
      productModes: published.productModes ? [...published.productModes] : published.productModes,
      config: { ...published.config },
      createdAt: this.now(),
    };
    if (input.toolKeys !== undefined) {
      assertVersionTools(version, input.toolKeys);
    }
    await this.repo.insertVersion(version);

    if (input.toolKeys !== undefined) {
      for (const toolKey of input.toolKeys) {
        await this.repo.insertBinding({
          id: this.id(),
          agentVersionId: versionId,
          organizationId: tenant.organizationId,
          toolKey,
          config: {},
          enabled: true,
        });
      }
    } else {
      const publishedBindings = await this.repo.listBindings(tenant.organizationId, published.id);
      for (const binding of publishedBindings) {
        await this.repo.insertBinding({
          id: this.id(),
          agentVersionId: versionId,
          organizationId: tenant.organizationId,
          toolKey: binding.toolKey,
          config: { ...binding.config },
          enabled: binding.enabled,
        });
      }
    }

    await this.repo.updateAgent(tenant.organizationId, agentId, {
      currentVersionId: versionId,
      updatedAt: this.now(),
    });
    return { version };
  }

  async share(tenant: TenantContext, agentId: string, visibility: Visibility): Promise<AgentRecord> {
    if (!canBuild(tenant.role)) {
      throw new ApiError("forbidden", "Builder role required", 403);
    }
    const agent = await this.requireOwned(tenant, agentId);
    const updated = { ...agent, visibility, updatedAt: this.now() };
    await this.repo.updateAgent(tenant.organizationId, agentId, {
      visibility,
      updatedAt: updated.updatedAt,
    });
    return updated;
  }

  async bindTool(tenant: TenantContext, agentId: string, versionId: string, toolKey: string): Promise<ToolBindingRecord> {
    await this.requireOwned(tenant, agentId);
    const version = await this.repo.findVersionById(tenant.organizationId, versionId);
    if (!version || version.agentId !== agentId) {
      throw new ApiError("not_found", "Version not found", 404);
    }
    assertVersionTools(version, [toolKey]);
    const binding: ToolBindingRecord = {
      id: this.id(),
      agentVersionId: versionId,
      organizationId: tenant.organizationId,
      toolKey,
      config: {},
      enabled: true,
    };
    await this.repo.insertBinding(binding);
    return binding;
  }

  async getPublishedForRun(tenant: TenantContext, agentId: string): Promise<{
    agent: AgentRecord;
    version: AgentVersionRecord;
    bindings: ToolBindingRecord[];
  }> {
    const agent = await this.get(tenant, agentId);
    if (!agent) {
      throw new ApiError("not_found", "Agent not found", 404);
    }
    const versions = await this.repo.listVersions(tenant.organizationId, agentId);
    const version = withCurrentChatSoul(agent, resolvePublishedVersion(agent, versions));
    const bindings = await this.repo.listBindings(tenant.organizationId, version.id);
    return { agent, version, bindings };
  }

  async ensureDefaultChat(tenant: TenantContext): Promise<{
    agent: AgentRecord;
    version: AgentVersionRecord;
    bindings: ToolBindingRecord[];
  }> {
    const existing = (await this.repo.listAgents(tenant.organizationId, tenant.workspaceId)).find(
      (agent) => agent.slug === DEFAULT_CHAT_SLUG && agent.createdByUserId === tenant.userId,
    );
    if (existing) {
      if (!existing.currentVersionId) {
        const versions = await this.repo.listVersions(tenant.organizationId, existing.id);
        const latest = versions.sort((left, right) => right.version - left.version)[0];
        if (!latest) {
          throw new ApiError("unpublished_agent", "Default chat has no version", 500);
        }
        await this.repo.updateAgent(tenant.organizationId, existing.id, {
          currentVersionId: latest.id,
          updatedAt: this.now(),
        });
        existing.currentVersionId = latest.id;
      }
      const published = await this.getPublishedForRun(tenant, existing.id);
      published.bindings = await this.ensureStarterBindings(tenant, published.version.id, published.bindings);
      return published;
    }

    const timestamp = this.now();
    const agentId = this.id();
    const versionId = this.id();
    const agent: AgentRecord = {
      id: agentId,
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      name: DEFAULT_CHAT_NAME,
      slug: DEFAULT_CHAT_SLUG,
      description: DEFAULT_CHAT_DESCRIPTION,
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
      systemPrompt: DEFAULT_CHAT_PROMPT,
      model: DEFAULT_CHAT_MODEL,
      inputModalities: [...DEFAULT_CHAT_MODALITIES],
      productModes: ["chat"],
      config: {},
      createdAt: timestamp,
    };
    await this.repo.insertAgent(agent);
    await this.repo.insertVersion(version);
    const bindings: ToolBindingRecord[] = [];
    for (const toolKey of DEFAULT_CHAT_TOOLS) {
      const binding: ToolBindingRecord = {
        id: this.id(),
        agentVersionId: versionId,
        organizationId: tenant.organizationId,
        toolKey,
        config: {},
        enabled: true,
      };
      await this.repo.insertBinding(binding);
      bindings.push(binding);
    }
    return { agent, version, bindings };
  }

  /**
   * Backfills the default chat's published version with any `DEFAULT_CHAT_TOOLS` key it has no row
   * for, so a tool added after a desk was made reaches it. Presence is by key, whatever `enabled` says:
   * a row the owner switched off counts as present and stays off, and a second call adds nothing.
   * Only `ensureDefaultChat` calls it, with the default chat's own bindings, so no other agent gains a tool.
   */
  private async ensureStarterBindings(
    tenant: TenantContext,
    versionId: string,
    bindings: ToolBindingRecord[],
  ): Promise<ToolBindingRecord[]> {
    const have = new Set(bindings.map((binding) => binding.toolKey));
    const added: ToolBindingRecord[] = [];
    for (const toolKey of DEFAULT_CHAT_TOOLS) {
      if (have.has(toolKey)) {
        continue;
      }
      const binding: ToolBindingRecord = {
        id: this.id(),
        agentVersionId: versionId,
        organizationId: tenant.organizationId,
        toolKey,
        config: {},
        enabled: true,
      };
      await this.repo.insertBinding(binding);
      added.push(binding);
    }
    return added.length === 0 ? bindings : [...bindings, ...added];
  }

  private async requireMaker(tenant: TenantContext, agentId: string): Promise<AgentRecord> {
    const agent = await this.repo.findAgentById(tenant.organizationId, agentId);
    if (
      !agent ||
      agent.workspaceId !== tenant.workspaceId ||
      !this.canSee(agent, tenant) ||
      agent.createdByUserId !== tenant.userId ||
      agent.visibility !== "private"
    ) {
      throw new ApiError("not_found", "Agent not found", 404);
    }
    return agent;
  }

  private async requireOwned(tenant: TenantContext, agentId: string): Promise<AgentRecord> {
    const agent = await this.repo.findAgentById(tenant.organizationId, agentId);
    if (!agent || agent.workspaceId !== tenant.workspaceId || !this.canSee(agent, tenant)) {
      throw new ApiError("not_found", "Agent not found", 404);
    }
    if (agent.createdByUserId !== tenant.userId && !canAdminister(tenant.role)) {
      throw new ApiError("forbidden", "Only the creator can edit this agent", 403);
    }
    if (!canBuild(tenant.role)) {
      throw new ApiError("forbidden", "Builder role required", 403);
    }
    return agent;
  }
}
