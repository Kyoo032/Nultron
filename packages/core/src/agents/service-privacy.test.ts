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
const OTHER_MEMBER = person("peer", "member");

async function makePrivate(service: AgentService, name: string) {
  return service.create(MAKER, { name, systemPrompt: "Help", model: "gpt-4o-mini", visibility: "private" });
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

  it("lets a member make and edit their own private agent, but not share it", async () => {
    const service = new AgentService(new MemoryAgentRepository(), undefined, undefined, () => true);
    const { agent, version } = await makePrivate(service, "Mine");
    const binding = await service.bindTool(MAKER, agent.id, version.id, "calculator");
    expect(binding.toolKey).toBe("calculator");
    const shared = await service.share(MAKER, agent.id, "workspace").catch((error: unknown) => error);
    expect((shared as ApiError).status).toBe(403);
  });

  it("still refuses a member who asks for a workspace-visible agent at creation", async () => {
    const service = new AgentService(new MemoryAgentRepository(), undefined, undefined, () => true);
    const outcome = await service
      .create(MAKER, { name: "Open", systemPrompt: "Help", model: "gpt-4o-mini", visibility: "workspace" })
      .catch((error: unknown) => error);
    expect((outcome as ApiError).status).toBe(403);
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
