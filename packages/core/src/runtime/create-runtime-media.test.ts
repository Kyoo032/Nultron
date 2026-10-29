import { afterEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "../tenancy/types";
import { getMediaModels, getSecret } from "../tools/secret-scope";
import { createRuntime } from "./create-runtime";

const seen = vi.hoisted(() => ({ media: undefined as unknown, image: undefined as unknown }));

vi.mock("./stub-runtime", () => ({
  StubRuntime: class {
    async execute() {
      seen.media = getMediaModels();
      seen.image = getSecret("IMAGE_GEN_MODEL");
    }
  },
}));

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "ws",
  userId: "user",
  role: "builder",
};

describe("createRuntime media catalog", () => {
  const previous = process.env.AGENTFORGE_RUNTIME;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.AGENTFORGE_RUNTIME;
    } else {
      process.env.AGENTFORGE_RUNTIME = previous;
    }
  });

  it("hands the tools of a run the desk's image and video catalog beside its secrets", async () => {
    process.env.AGENTFORGE_RUNTIME = "stub";
    const catalog = { image: ["gpt-image-2"], video: ["seedance-2.0"] };
    await createRuntime({ imageGenModel: "seedream-5.0-pro" }, catalog).execute({
      tenant,
      runId: "run-media",
      modality: "text",
      version: {
        id: "v1",
        agentId: "a1",
        organizationId: "org",
        version: 1,
        systemPrompt: "You are helpful.",
        model: "stub-model",
        inputModalities: ["text"],
        config: {},
        createdAt: new Date(),
      },
      bindings: [],
      history: [{ role: "user", parts: [{ type: "text", text: "a lantern" }] }],
      onEvent: () => {},
    });
    expect(seen.media).toEqual(catalog);
    expect(seen.image).toBe("seedream-5.0-pro");
  });
});
