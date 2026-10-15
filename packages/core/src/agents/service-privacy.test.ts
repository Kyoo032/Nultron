import { describe, expect, it } from "vitest";
import type { TenantContext } from "../tenancy/types";
import { ApiError } from "../errors";
import { MemoryAgentRepository } from "./memory-repo";
import { AgentService } from "./service";

function person(userId: string, role: TenantContext["role"]): TenantContext {
  return { tenantId: "t", organizationId: "org-a", workspaceId: "ws-a", userId, role };
}

const MAKER = person("maker", "member");
const OWNER = person("boss", "owner");
const ADMIN = person("ad", "admin");
const MAKER_AS_OWNER = person("maker", "owner");
const OTHER_MEMBER = person("peer", "member");

async function makePrivate(service: AgentService, name: string, tools: string[] = []) {
  return service.createPromptMade(
    MAKER,
    { name, systemPrompt: "Help", model: "gpt-4o-mini", config: { baseMode: "chat", madeFromPrompt: true } },
    tools,
  );
}

function statusOf(outcome: unknown): number | undefined {
  return outcome instanceof ApiError ? outcome.status : undefined;
}

describe("who sees a private agent", () => {
  it("hides a colleague's private agent from an owner and an admin in server mode", async () => {
    const service = new AgentService(new MemoryAgentRepository(), undefined, undefined, () => true);
    const { agent } = await makePrivate(service, "Secret helper");

    expect(await service.get(MAKER, agent.id)).not.toBeNull();
    for (const looker of [OWNER, ADMIN, OTHER_MEMBER]) {
      expect(await service.get(looker, agent.id), looker.role).toBeNull();
      expect((await service.list(looker)).map((row) => row.id), looker.role).not.toContain(agent.id);
    }
  });

  it("keeps showing every private agent to an owner and an admin off server mode", async () => {
    const service = new AgentService(new MemoryAgentRepository(), undefined, undefined, () => false);
    const { agent } = await makePrivate(service, "Secret helper");

    for (const looker of [MAKER, OWNER, ADMIN]) {
      expect(await service.get(looker, agent.id), looker.role).not.toBeNull();
      expect((await service.list(looker)).map((row) => row.id), looker.role).toContain(agent.id);
    }
    expect(await service.get(OTHER_MEMBER, agent.id)).toBeNull();
  });

  it("defaults to the off-server behaviour when no flag is given", async () => {
    const service = new AgentService(new MemoryAgentRepository());
    const { agent } = await makePrivate(service, "Secret helper");
    expect(await service.get(OWNER, agent.id)).not.toBeNull();
  });

  it("gives the owner a 404 on an edit of a colleague's private agent in server mode", async () => {
    const service = new AgentService(new MemoryAgentRepository(), undefined, undefined, () => true);
    const { agent, version } = await makePrivate(service, "Secret helper");
    const outcome = await service.bindTool(OWNER, agent.id, version.id, "calculator").catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(ApiError);
    expect((outcome as ApiError).status).toBe(404);
  });

  it("lets a member make their own private agent through the prompt-made path, but not edit, bind, publish elsewhere or share it", async () => {
    const service = new AgentService(new MemoryAgentRepository(), undefined, undefined, () => true);
    const { agent, version } = await makePrivate(service, "Mine", ["calculator"]);
    expect(agent.visibility).toBe("private");
    const bound = await service.bindTool(MAKER, agent.id, version.id, "calculator").catch((error: unknown) => error);
    expect(statusOf(bound)).toBe(403);
    const revised = await service
      .createRevision(MAKER, agent.id, { toolKeys: ["calculator"] })
      .catch((error: unknown) => error);
    expect(statusOf(revised)).toBe(403);
    const shared = await service.share(MAKER, agent.id, "workspace").catch((error: unknown) => error);
    expect(statusOf(shared)).toBe(403);
  });

  it("refuses a member every older create, private or not", async () => {
    const service = new AgentService(new MemoryAgentRepository(), undefined, undefined, () => true);
    for (const visibility of ["private", "workspace"] as const) {
      const outcome = await service
        .create(MAKER, { name: "Open", systemPrompt: "Help", model: "gpt-4o-mini", visibility })
        .catch((error: unknown) => error);
      expect(statusOf(outcome), visibility).toBe(403);
    }
  });

  it("refuses a non-string or empty name with 400 instead of throwing", async () => {
    const service = new AgentService(new MemoryAgentRepository());
    for (const name of [42, "", "   ", null]) {
      const outcome = await service
        .create(OWNER, { name: name as never, systemPrompt: "x", model: "gpt-4o-mini" })
        .catch((error: unknown) => error);
      expect(statusOf(outcome), String(name)).toBe(400);
    }
  });

  it("refuses a tool outside the base mode on a prompt-made agent, even for an owner", async () => {
    const service = new AgentService(new MemoryAgentRepository(), undefined, undefined, () => true);
    const refusedAtCreate = await makePrivate(service, "Wide", ["music_generate"]).catch((error: unknown) => error);
    expect(statusOf(refusedAtCreate)).toBe(400);

    const { agent, version } = await makePrivate(service, "Narrow", ["calculator"]);
    const bound = await service
      .bindTool(MAKER_AS_OWNER, agent.id, version.id, "music_generate")
      .catch((error: unknown) => error);
    expect(statusOf(bound)).toBe(400);
    const revised = await service
      .createRevision(MAKER_AS_OWNER, agent.id, { toolKeys: ["calculator", "music_generate"] })
      .catch((error: unknown) => error);
    expect(statusOf(revised)).toBe(400);
    const ok = await service.bindTool(MAKER_AS_OWNER, agent.id, version.id, "datetime");
    expect(ok.toolKey).toBe("datetime");
  });

  it("does not limit the tools of an agent that is not prompt-made", async () => {
    const service = new AgentService(new MemoryAgentRepository());
    const { agent, version } = await service.create(OWNER, { name: "Built", systemPrompt: "x", model: "gpt-4o-mini" });
    const bound = await service.bindTool(OWNER, agent.id, version.id, "music_generate");
    expect(bound.toolKey).toBe("music_generate");
  });

  it("gives a name that collides with Chat or a mode agent the agent- prefix", async () => {
    const service = new AgentService(new MemoryAgentRepository());
    const chat = await service.create(OWNER, { name: "Quick Chat", systemPrompt: "x", model: "gpt-4o-mini" });
    const mode = await service.create(OWNER, { name: "va-research", systemPrompt: "x", model: "gpt-4o-mini" });
    const plain = await service.create(OWNER, { name: "Research", systemPrompt: "x", model: "gpt-4o-mini" });
    expect(chat.agent.slug).toBe("agent-quick-chat");
    expect(chat.agent.name).toBe("Quick Chat");
    expect(mode.agent.slug).toBe("agent-va-research");
    expect(plain.agent.slug).toBe("research");
  });
});
