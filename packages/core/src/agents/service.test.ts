import { describe, expect, it } from "vitest";
import type { TenantContext } from "../tenancy/types";
import { MemoryAgentRepository } from "./memory-repo";
import { AgentService, resolvePublishedVersion } from "./service";
import { ApiError } from "../errors";
import { DEFAULT_CHAT_MODEL, DEFAULT_CHAT_PROMPT, DEFAULT_CHAT_TOOLS } from "./default-chat";

/** Every starter tool, sorted: a literal, so a tool added or dropped by accident fails here. */
const STARTER_TOOLS_SORTED = [
  "calculator",
  "datetime",
  "delete_file",
  "edit_file",
  "image_generate",
  "knowledge_search",
  "list_files",
  "past_sessions",
  "read_file",
  "run_code",
  "search_files",
  "video_generate",
  "web_fetch",
  "web_search",
  "write_file",
];

/** What a desk made before the general-agent pass has bound. */
const LEGACY_STARTER_TOOLS = [
  "calculator",
  "datetime",
  "web_search",
  "image_generate",
  "video_generate",
  "past_sessions",
];

const LEGACY_CHAT_PROMPT =
  "You are a helpful assistant. Be clear and direct. Use tools when they make the answer better. When the user refers to an earlier chat, use past_sessions to look it up.";

function tenant(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    tenantId: "local-tenant",
    organizationId: "org-a",
    workspaceId: "ws-a",
    userId: "user-a",
    role: "builder",
    ...overrides,
  };
}

describe("AgentService tenancy", () => {
  it("does not let org B read org A agents", async () => {
    const repo = new MemoryAgentRepository();
    const service = new AgentService(repo);
    const created = await service.create(tenant(), {
      name: "Tutor",
      systemPrompt: "Help with writing",
      model: "gpt-4o-mini",
    });
    const other = tenant({ organizationId: "org-b", workspaceId: "ws-b", userId: "user-b" });
    expect(await service.get(other, created.agent.id)).toBeNull();
    expect(await service.get(tenant(), created.agent.id)).not.toBeNull();
  });

  it("rejects a model that is not in the catalog", async () => {
    const repo = new MemoryAgentRepository();
    const service = new AgentService(repo);
    try {
      await service.create(tenant(), {
        name: "Tutor",
        systemPrompt: "Help",
        model: "not-a-model",
      });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("unknown_model");
    }
  });
});

describe("ensureDefaultChat", () => {
  it("provisions a published personal chat agent with starter tools", async () => {
    const repo = new MemoryAgentRepository();
    const service = new AgentService(repo);
    const created = await service.ensureDefaultChat(tenant({ role: "member" }));
    expect(created.agent.slug).toBe("quick-chat");
    expect(created.agent.visibility).toBe("private");
    expect(created.agent.currentVersionId).toBe(created.version.id);
    expect(created.version.inputModalities).toEqual(["text", "image", "video"]);
    expect(created.version.productModes).toEqual(["chat"]);
    expect(created.version.model).toBe(DEFAULT_CHAT_MODEL);
    expect(created.version.systemPrompt).toBe(DEFAULT_CHAT_PROMPT);
    expect(created.bindings.map((binding) => binding.toolKey).sort()).toEqual(STARTER_TOOLS_SORTED);
    expect(created.bindings.every((binding) => binding.enabled)).toBe(true);
    expect([...DEFAULT_CHAT_TOOLS].sort()).toEqual(STARTER_TOOLS_SORTED);
  });

  it("adds new starter tools onto an existing default chat", async () => {
    const repo = new MemoryAgentRepository();
    const service = new AgentService(repo);
    const created = await service.ensureDefaultChat(tenant({ role: "member" }));
    repo.bindings = repo.bindings.filter(
      (binding) => binding.toolKey !== "image_generate" && binding.toolKey !== "video_generate",
    );
    const again = await service.ensureDefaultChat(tenant({ role: "member" }));
    expect(again.agent.id).toBe(created.agent.id);
    expect(again.bindings.map((binding) => binding.toolKey).sort()).toEqual(STARTER_TOOLS_SORTED);
  });

  it("backfills the general-agent tools onto a desk made before them, once", async () => {
    const repo = new MemoryAgentRepository();
    const service = new AgentService(repo);
    const created = await service.ensureDefaultChat(tenant());
    repo.bindings = repo.bindings.filter((binding) => LEGACY_STARTER_TOOLS.includes(binding.toolKey));
    const legacyIds = new Set(repo.bindings.map((binding) => binding.id));
    expect(repo.bindings).toHaveLength(LEGACY_STARTER_TOOLS.length);

    const upgraded = await service.ensureDefaultChat(tenant());
    expect(upgraded.bindings.map((binding) => binding.toolKey).sort()).toEqual(STARTER_TOOLS_SORTED);
    expect(repo.bindings).toHaveLength(STARTER_TOOLS_SORTED.length);
    for (const binding of upgraded.bindings) {
      expect(binding.agentVersionId).toBe(created.version.id);
      expect(binding.enabled).toBe(true);
    }
    // The rows the desk already had are kept as they were, not replaced.
    const idsAfter = new Set(repo.bindings.map((binding) => binding.id));
    for (const id of legacyIds) {
      expect(idsAfter.has(id)).toBe(true);
    }

    const bindingIds = repo.bindings.map((binding) => binding.id);
    const third = await service.ensureDefaultChat(tenant());
    expect(repo.bindings.map((binding) => binding.id)).toEqual(bindingIds);
    expect(third.bindings).toHaveLength(STARTER_TOOLS_SORTED.length);
  });

  it("leaves a binding the owner switched off switched off, and adds no duplicate", async () => {
    const repo = new MemoryAgentRepository();
    const service = new AgentService(repo);
    await service.ensureDefaultChat(tenant());
    repo.bindings = repo.bindings.map((binding) =>
      binding.toolKey === "write_file" || binding.toolKey === "web_fetch" ? { ...binding, enabled: false } : binding,
    );
    repo.bindings = repo.bindings.filter((binding) => binding.toolKey !== "delete_file");

    const again = await service.ensureDefaultChat(tenant());
    const byKey = new Map<string, boolean[]>();
    for (const binding of again.bindings) {
      byKey.set(binding.toolKey, [...(byKey.get(binding.toolKey) ?? []), binding.enabled]);
    }
    expect(byKey.get("write_file")).toEqual([false]);
    expect(byKey.get("web_fetch")).toEqual([false]);
    expect(byKey.get("delete_file")).toEqual([true]);
    expect(byKey.get("edit_file")).toEqual([true]);
    expect(again.bindings).toHaveLength(STARTER_TOOLS_SORTED.length);

    const stored = repo.bindings.filter((binding) => binding.toolKey === "write_file");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.enabled).toBe(false);
  });

  it("backfills only the default chat, never another agent", async () => {
    const repo = new MemoryAgentRepository();
    const service = new AgentService(repo);
    const other = await service.create(tenant(), {
      name: "Tutor",
      systemPrompt: "Help with writing",
      model: "gpt-4o-mini",
    });
    await service.publish(tenant(), other.agent.id, other.version.id);
    await service.bindTool(tenant(), other.agent.id, other.version.id, "calculator");

    await service.ensureDefaultChat(tenant());
    const otherBindings = await repo.listBindings("org-a", other.version.id);
    expect(otherBindings.map((binding) => binding.toolKey)).toEqual(["calculator"]);
  });

  it("serves the current prompt for a desk that stored an older one, without rewriting the row", async () => {
    const repo = new MemoryAgentRepository();
    const service = new AgentService(repo);
    const created = await service.ensureDefaultChat(tenant());
    repo.versions = repo.versions.map((version) =>
      version.id === created.version.id ? { ...version, systemPrompt: LEGACY_CHAT_PROMPT } : version,
    );

    const ensured = await service.ensureDefaultChat(tenant());
    expect(ensured.version.systemPrompt).toBe(DEFAULT_CHAT_PROMPT);
    const forRun = await service.getPublishedForRun(tenant(), created.agent.id);
    expect(forRun.version.systemPrompt).toBe(DEFAULT_CHAT_PROMPT);
    expect(repo.versions.find((version) => version.id === created.version.id)?.systemPrompt).toBe(LEGACY_CHAT_PROMPT);
  });

  it("never replaces another agent's prompt with the default chat's", async () => {
    const repo = new MemoryAgentRepository();
    const service = new AgentService(repo);
    const other = await service.create(tenant(), {
      name: "Tutor",
      systemPrompt: "Help with writing",
      model: "gpt-4o-mini",
    });
    await service.publish(tenant(), other.agent.id, other.version.id);
    const forRun = await service.getPublishedForRun(tenant(), other.agent.id);
    expect(forRun.version.systemPrompt).toBe("Help with writing");
  });

  it("returns the same agent on a second call", async () => {
    const repo = new MemoryAgentRepository();
    const service = new AgentService(repo);
    const first = await service.ensureDefaultChat(tenant());
    const second = await service.ensureDefaultChat(tenant());
    expect(second.agent.id).toBe(first.agent.id);
    expect(repo.agents).toHaveLength(1);
  });

  it("gives each user their own default chat", async () => {
    const repo = new MemoryAgentRepository();
    const service = new AgentService(repo);
    const alex = await service.ensureDefaultChat(tenant({ userId: "alex" }));
    const jordan = await service.ensureDefaultChat(tenant({ userId: "jordan" }));
    expect(alex.agent.id).not.toBe(jordan.agent.id);
  });
});

describe("resolvePublishedVersion", () => {
  it("uses the published version, not a later draft", async () => {
    const repo = new MemoryAgentRepository();
    const service = new AgentService(repo);
    const created = await service.create(tenant(), {
      name: "Tutor",
      systemPrompt: "v1 prompt",
      model: "gpt-4o-mini",
    });
    await service.publish(tenant(), created.agent.id, created.version.id);
    const publishedAgent = await service.get(tenant(), created.agent.id);
    repo.versions.push({
      ...created.version,
      id: "draft-v2",
      version: 2,
      systemPrompt: "draft prompt should not run",
    });
    const published = resolvePublishedVersion(publishedAgent!, repo.versions);
    expect(published.id).toBe(created.version.id);
    expect(published.systemPrompt).toBe("v1 prompt");
  });
});

describe("createRevision", () => {
  it("creates v2 with edited systemPrompt and publishes it", async () => {
    const repo = new MemoryAgentRepository();
    const service = new AgentService(repo);
    const created = await service.create(tenant(), {
      name: "Tutor",
      systemPrompt: "v1 prompt",
      model: "gpt-4o-mini",
    });
    await service.publish(tenant(), created.agent.id, created.version.id);
    const { version } = await service.createRevision(tenant(), created.agent.id, {
      systemPrompt: "v2 soul",
    });
    expect(version.version).toBe(2);
    expect(version.systemPrompt).toBe("v2 soul");
    expect(version.model).toBe("gpt-4o-mini");
    const agent = await service.get(tenant(), created.agent.id);
    expect(agent?.currentVersionId).toBe(version.id);
  });

  it("leaves the published v1 row unchanged", async () => {
    const repo = new MemoryAgentRepository();
    const service = new AgentService(repo);
    const created = await service.create(tenant(), {
      name: "Tutor",
      systemPrompt: "v1 prompt",
      model: "gpt-4o-mini",
    });
    await service.publish(tenant(), created.agent.id, created.version.id);
    await service.createRevision(tenant(), created.agent.id, { systemPrompt: "v2 soul" });
    const v1 = repo.versions.find((version) => version.id === created.version.id);
    expect(v1?.systemPrompt).toBe("v1 prompt");
    expect(v1?.version).toBe(1);
  });

  it("clones bindings onto v2 when toolKeys are omitted", async () => {
    const repo = new MemoryAgentRepository();
    const service = new AgentService(repo);
    const created = await service.create(tenant(), {
      name: "Tutor",
      systemPrompt: "v1 prompt",
      model: "gpt-4o-mini",
    });
    await service.publish(tenant(), created.agent.id, created.version.id);
    await service.bindTool(tenant(), created.agent.id, created.version.id, "calculator");
    await service.bindTool(tenant(), created.agent.id, created.version.id, "datetime");
    const { version } = await service.createRevision(tenant(), created.agent.id, {
      systemPrompt: "v2 soul",
    });
    const bindings = await repo.listBindings("org-a", version.id);
    expect(bindings.map((binding) => binding.toolKey).sort()).toEqual(["calculator", "datetime"]);
    const v1Bindings = await repo.listBindings("org-a", created.version.id);
    expect(v1Bindings).toHaveLength(2);
  });

  it("replaces bindings when toolKeys are provided", async () => {
    const repo = new MemoryAgentRepository();
    const service = new AgentService(repo);
    const created = await service.create(tenant(), {
      name: "Tutor",
      systemPrompt: "v1 prompt",
      model: "gpt-4o-mini",
    });
    await service.publish(tenant(), created.agent.id, created.version.id);
    await service.bindTool(tenant(), created.agent.id, created.version.id, "calculator");
    await service.bindTool(tenant(), created.agent.id, created.version.id, "datetime");
    const { version } = await service.createRevision(tenant(), created.agent.id, {
      toolKeys: ["web_search"],
    });
    const bindings = await repo.listBindings("org-a", version.id);
    expect(bindings.map((binding) => binding.toolKey)).toEqual(["web_search"]);
  });

  it("rejects the default chat agent", async () => {
    const repo = new MemoryAgentRepository();
    const service = new AgentService(repo);
    const created = await service.ensureDefaultChat(tenant());
    try {
      await service.createRevision(tenant(), created.agent.id, { systemPrompt: "nope" });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("default_agent_soul");
    }
  });

  it("rejects an unpublished agent", async () => {
    const repo = new MemoryAgentRepository();
    const service = new AgentService(repo);
    const created = await service.create(tenant(), {
      name: "Tutor",
      systemPrompt: "v1 prompt",
      model: "gpt-4o-mini",
    });
    try {
      await service.createRevision(tenant(), created.agent.id, { systemPrompt: "v2" });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("unpublished_agent");
    }
  });

  it("getPublishedForRun returns the new soul", async () => {
    const repo = new MemoryAgentRepository();
    const service = new AgentService(repo);
    const created = await service.create(tenant(), {
      name: "Tutor",
      systemPrompt: "v1 prompt",
      model: "gpt-4o-mini",
    });
    await service.publish(tenant(), created.agent.id, created.version.id);
    await service.createRevision(tenant(), created.agent.id, { systemPrompt: "v2 soul" });
    const published = await service.getPublishedForRun(tenant(), created.agent.id);
    expect(published.version.version).toBe(2);
    expect(published.version.systemPrompt).toBe("v2 soul");
  });
});

describe("productModes", () => {
  it("defaults a new agent to Chat and persists an explicit list", async () => {
    const repo = new MemoryAgentRepository();
    const service = new AgentService(repo);
    const created = await service.create(tenant(), {
      name: "Tutor",
      systemPrompt: "Help",
      model: "gpt-4o-mini",
    });
    expect(created.version.productModes).toEqual(["chat"]);

    const marketing = await service.create(tenant(), {
      name: "Campaign",
      systemPrompt: "Ads",
      model: "gpt-4o-mini",
      productModes: ["images", "videos"],
    });
    await service.publish(tenant(), marketing.agent.id, marketing.version.id);
    expect(await service.listVisibleProductModes(tenant())).toEqual(["images", "videos"]);
  });

  it("updates published product modes", async () => {
    const repo = new MemoryAgentRepository();
    const service = new AgentService(repo);
    const created = await service.create(tenant(), {
      name: "Desk",
      systemPrompt: "Help",
      model: "gpt-4o-mini",
      productModes: ["chat"],
    });
    await service.publish(tenant(), created.agent.id, created.version.id);
    const updated = await service.updateProductModes(tenant(), created.agent.id, ["documents", "research"]);
    expect(updated.productModes).toEqual(["documents", "research"]);
    expect(await service.listVisibleProductModes(tenant())).toEqual(["documents", "research"]);
  });

  it("stores per-agent image and video generate pins on version config", async () => {
    const repo = new MemoryAgentRepository();
    const service = new AgentService(repo);
    const created = await service.create(tenant(), {
      name: "Desk",
      systemPrompt: "Help",
      model: "gpt-4o-mini",
      productModes: ["chat", "images", "videos"],
    });
    await service.publish(tenant(), created.agent.id, created.version.id);
    const updated = await service.updateGenerateDefaults(tenant(), created.agent.id, {
      imageGenModel: "gpt-image-2",
      videoGenModel: "seedance-2.0-fast",
    });
    expect(updated.config).toEqual({ imageGenModel: "gpt-image-2", videoGenModel: "seedance-2.0-fast" });
    const sources = await service.listGenerateDefaultSources(tenant());
    expect(sources[0]?.config).toEqual({ imageGenModel: "gpt-image-2", videoGenModel: "seedance-2.0-fast" });
  });
});
