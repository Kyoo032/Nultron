import { describe, expect, it } from "vitest";
import type { TenantContext } from "../tenancy/types";
import { MemoryAgentRepository } from "./memory-repo";
import { AgentService, type ToolBindingRecord } from "./service";

const MAKER: TenantContext = {
  tenantId: "t",
  organizationId: "org-a",
  workspaceId: "ws-a",
  userId: "maker",
  role: "member",
};

const INPUT = {
  name: "Helper",
  systemPrompt: "Help",
  model: "gpt-4o-mini",
  config: { baseMode: "chat", madeFromPrompt: true },
};

class FailingBindingRepository extends MemoryAgentRepository {
  async insertBinding(_binding: ToolBindingRecord): Promise<void> {
    throw new Error("binding insert failed");
  }
}

describe("AgentService.createPromptMade", () => {
  it("writes the agent under the id the caller passes, with its version and every tool binding", async () => {
    const repo = new MemoryAgentRepository();
    const service = new AgentService(repo);
    const made = await service.createPromptMade(MAKER, INPUT, ["calculator", "datetime"], undefined, "agent-fixed");

    expect(made.agent.id).toBe("agent-fixed");
    expect(repo.agents.map((agent) => agent.id)).toEqual(["agent-fixed"]);
    expect(repo.versions.map((version) => version.agentId)).toEqual(["agent-fixed"]);
    expect(repo.bindings.map((binding) => [binding.agentVersionId, binding.toolKey])).toEqual([
      [made.version.id, "calculator"],
      [made.version.id, "datetime"],
    ]);
  });

  it("hands a failed binding insert back to the caller, so the caller can remove the agent by the id it passed", async () => {
    const service = new AgentService(new FailingBindingRepository());
    await expect(service.createPromptMade(MAKER, INPUT, ["calculator"], undefined, "agent-fixed")).rejects.toThrow(
      "binding insert failed",
    );
  });
});
