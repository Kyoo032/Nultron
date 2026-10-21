import { afterEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "../../tenancy/types";
import { invokeTool } from "../define-tool";
import { runWithToolSecrets } from "../secret-scope";
import { imageGenerateTool } from "./image-generate";

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  role: "member",
};

describe("imageGenerateTool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the gateway key on /images/generations when no backend was picked", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ url: "https://cdn.example/lantern.png" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runWithToolSecrets(
      { secrets: { OPENAI_API_KEY: "sk-model", OPENAI_BASE_URL: "https://api.tokotokenai.com/v1" }, backends: {} },
      () => invokeTool(imageGenerateTool, { prompt: "a lantern" }, tenant),
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.tokotokenai.com/v1/images/generations");
    expect(result).toMatchObject({
      success: true,
      backend: "gateway",
      image: "https://cdn.example/lantern.png",
      model: "gpt-image-2",
    });
  });

  it("calls FAL when FAL is selected", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          request_id: "1",
          status_url: "https://queue.fal.run/status",
          response_url: "https://queue.fal.run/resp",
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "COMPLETED" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ images: [{ url: "https://cdn.fal.ai/lantern.png" }] }) });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runWithToolSecrets(
      { secrets: { FAL_KEY: "fal-test", OPENAI_API_KEY: "sk-model" }, backends: { image_gen: "fal" } },
      () => invokeTool(imageGenerateTool, { prompt: "a lantern" }, tenant),
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://queue.fal.run/fal-ai/flux-2/klein/9b");
    expect(result).toMatchObject({
      success: true,
      backend: "fal",
      image: "https://cdn.fal.ai/lantern.png",
    });
  });

  it("reuses the chat OpenAI key when OpenAI Images is selected", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ url: "https://oaidalleapiprodscus.blob.core.windows.net/img.png" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runWithToolSecrets(
      {
        secrets: { OPENAI_API_KEY: "sk-model", OPENAI_BASE_URL: "https://api.openai.com/v1", FAL_KEY: "fal-test" },
        backends: { image_gen: "openai" },
      },
      () => invokeTool(imageGenerateTool, { prompt: "a lantern" }, tenant),
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/images/generations");
    expect(result).toMatchObject({ success: true, backend: "openai" });
  });

  it("does not fall through to the gateway when FAL is selected without FAL_KEY", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await runWithToolSecrets(
      { secrets: { OPENAI_API_KEY: "sk-model" }, backends: { image_gen: "fal" } },
      () => invokeTool(imageGenerateTool, { prompt: "a lantern" }, tenant),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false });
    expect(String((result as { error: string }).error)).toMatch(/fal/i);
  });

  it("returns success when the gateway HTTP is not ok but still includes an image URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        error: { message: "need quota" },
        data: [{ url: "https://cdn.example/billed.png" }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runWithToolSecrets(
      { secrets: { OPENAI_API_KEY: "sk-model", OPENAI_BASE_URL: "https://api.tokotokenai.com/v1" }, backends: {} },
      () => invokeTool(imageGenerateTool, { prompt: "a lantern" }, tenant),
    );
    expect(result).toMatchObject({
      success: true,
      image: "https://cdn.example/billed.png",
    });
  });
});

describe("imageGenerateTool model choice", () => {
  const gateway = { OPENAI_API_KEY: "sk-model", OPENAI_BASE_URL: "https://api.tokotokenai.com/v1" };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubGateway() {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ url: "https://cdn.example/lantern.png" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function sentModel(fetchMock: ReturnType<typeof vi.fn>): unknown {
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    return JSON.parse(String(init?.body)).model;
  }

  async function run(
    args: Record<string, unknown>,
    options: { secrets?: Record<string, string>; image?: string[] } = {},
  ) {
    return runWithToolSecrets(
      {
        secrets: { ...gateway, ...options.secrets },
        backends: {},
        ...(options.image ? { mediaModels: { image: options.image, video: [] } } : {}),
      },
      () => invokeTool(imageGenerateTool, { prompt: "a lantern", ...args }, tenant),
    );
  }

  it("replaces a model id the desk's catalog does not list with the catalog's image model", async () => {
    const fetchMock = stubGateway();
    const result = await run({ model: "]" }, { image: ["seedream-5.0-pro", "gpt-image-2"] });
    expect(sentModel(fetchMock)).toBe("gpt-image-2");
    expect(result).toMatchObject({ success: true, model: "gpt-image-2" });
  });

  it("falls back to the configured image model before the catalog's pick", async () => {
    const fetchMock = stubGateway();
    await run(
      { model: "gpt-image-9" },
      { image: ["gpt-image-2", "seedream-5.0-pro"], secrets: { IMAGE_GEN_MODEL: "seedream-5.0-pro" } },
    );
    expect(sentModel(fetchMock)).toBe("seedream-5.0-pro");
  });

  it("keeps a model the catalog lists, in the catalog's spelling", async () => {
    const fetchMock = stubGateway();
    await run({ model: "Seedream-5.0-Pro" }, { image: ["gpt-image-2", "seedream-5.0-pro"] });
    expect(sentModel(fetchMock)).toBe("seedream-5.0-pro");
  });

  it("with an empty catalog keeps an image model id and drops anything else", async () => {
    const kept = stubGateway();
    await run({ model: "seedream-5.0-pro" }, { image: [] });
    expect(sentModel(kept)).toBe("seedream-5.0-pro");
    vi.unstubAllGlobals();
    const dropped = stubGateway();
    await run({ model: "]" }, { image: [] });
    expect(sentModel(dropped)).toBe("gpt-image-2");
  });

  it("sends the model as given when no catalog is in scope, as the Images studio calls it", async () => {
    const fetchMock = stubGateway();
    await run({ model: "studio-picked-model" });
    expect(sentModel(fetchMock)).toBe("studio-picked-model");
  });
});
