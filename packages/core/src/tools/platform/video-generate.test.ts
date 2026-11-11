import { afterEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "../../tenancy/types";
import { invokeTool } from "../define-tool";
import { runWithToolSecrets } from "../secret-scope";
import { videoGenerateTool } from "./video-generate";

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  role: "member",
};

describe("videoGenerateTool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the gateway key on the model's own route when no backend was picked", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "video_123", task_id: "abcd", status: "processing" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { status: "SUCCESS", result_url: "https://cdn.example/clip.mp4" } }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runWithToolSecrets(
      { secrets: { OPENAI_API_KEY: "sk-model", OPENAI_BASE_URL: "https://api.tokotokenai.com/v1" }, backends: {} },
      () => invokeTool(videoGenerateTool, { prompt: "rain on a window" }, tenant),
    );
    // No catalog and no pick: the fallback id is the one video model a prepaid key was proven to run,
    // whose wire is the Seedance body on /v1/video/generations (not Grok's /v1/videos).
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.tokotokenai.com/v1/video/generations");
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({
      model: "seedance-2.0-fast",
      duration: 5,
      size: "720p",
      metadata: { ratio: "16:9" },
    });
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).not.toHaveProperty("video_length");
    expect(result).toMatchObject({
      success: true,
      backend: "gateway",
      video: "https://cdn.example/clip.mp4",
      model: "seedance-2.0-fast",
    });
  });

  it("sends the documented Grok fields, and none of the Seedance-only ones, for grok-imagine-video", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "video_123", task_id: "abcd", status: "processing" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { status: "SUCCESS", result_url: "https://cdn.example/clip.mp4" } }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runWithToolSecrets(
      { secrets: { OPENAI_API_KEY: "sk-model", OPENAI_BASE_URL: "https://api.tokotokenai.com/v1" }, backends: {} },
      () =>
        invokeTool(
          videoGenerateTool,
          {
            prompt: "rain on a window",
            model: "grok-imagine-video",
            seconds: 8,
            resolution: "1080p",
            aspect_ratio: "9:16",
          },
          tenant,
        ),
    );
    // Grok takes 6 or 10 s and 480p or 720p: 8 s is a tie and goes to the shorter clip, 1080p goes to 720p,
    // and the result says so instead of leaving the page to believe it got what it asked for.
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      model: "grok-imagine-video",
      prompt: "rain on a window",
      aspect_ratio: "9:16",
      video_length: 6,
      resolution_name: "720p",
      preset: "normal",
    });
    expect(result).toMatchObject({
      success: true,
      sent: { aspect: "9:16", seconds: 6, resolution: "720p" },
      adjusted: [
        { field: "seconds", asked: 8, used: 6 },
        { field: "resolution", asked: "1080p", used: "720p" },
      ],
    });
  });

  it("sends sound inside the clip when asked, and says what it sent", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ task_id: "abcd", status: "processing" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { status: "SUCCESS", result_url: "https://cdn.example/clip.mp4" } }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runWithToolSecrets(
      { secrets: { OPENAI_API_KEY: "sk-model", OPENAI_BASE_URL: "https://api.tokotokenai.com/v1" }, backends: {} },
      () =>
        invokeTool(
          videoGenerateTool,
          { prompt: "ocean waves", model: "seedance-2.0-fast", seconds: 4, resolution: "480p", aspect_ratio: "3:4", audio: true },
          tenant,
        ),
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.tokotokenai.com/v1/video/generations");
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({
      duration: 4,
      size: "480p",
      metadata: { ratio: "3:4", generate_audio: true },
    });
    expect(result).toMatchObject({ success: true, sent: { seconds: 4, resolution: "480p", aspect: "3:4", audio: true } });
    expect(result).toMatchObject({ adjusted: [] });
  });

  it("refuses sound on a model that makes silent clips, before any call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await runWithToolSecrets(
      { secrets: { OPENAI_API_KEY: "sk-model", OPENAI_BASE_URL: "https://api.tokotokenai.com/v1" }, backends: {} },
      () => invokeTool(videoGenerateTool, { prompt: "p", model: "grok-imagine-video", audio: true }, tenant),
    );
    expect(result).toMatchObject({ success: false });
    expect(String((result as { error: string }).error)).toMatch(/silent clips/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not spend the chat Ark key on video_generate", async () => {
    const result = await runWithToolSecrets({ secrets: { ARK_API_KEY: "ark-test" }, backends: {} }, () =>
      invokeTool(videoGenerateTool, { prompt: "rain on a window" }, tenant),
    );
    expect(result).toMatchObject({ success: false });
    expect(String((result as { error: string }).error)).toMatch(/gateway|FAL|Toko/i);
  });

  it("routes text-to-video and image-to-video to different FAL endpoints when FAL is selected", async () => {
    const queue = () => [
      {
        ok: true,
        json: async () => ({
          request_id: "1",
          status_url: "https://queue.fal.run/status",
          response_url: "https://queue.fal.run/resp",
        }),
      },
      { ok: true, json: async () => ({ status: "COMPLETED" }) },
      { ok: true, json: async () => ({ video: { url: "https://cdn.fal.ai/clip.mp4" } }) },
    ];
    const fetchMock = vi.fn();
    for (const response of [...queue(), ...queue()]) {
      fetchMock.mockResolvedValueOnce(response);
    }
    vi.stubGlobal("fetch", fetchMock);

    await runWithToolSecrets(
      { secrets: { FAL_KEY: "fal-test", OPENAI_API_KEY: "sk-model" }, backends: { video_gen: "fal" } },
      () => invokeTool(videoGenerateTool, { prompt: "rain on a window" }, tenant),
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://queue.fal.run/fal-ai/pixverse/v6/text-to-video");

    await runWithToolSecrets(
      { secrets: { FAL_KEY: "fal-test", OPENAI_API_KEY: "sk-model" }, backends: { video_gen: "fal" } },
      () =>
        invokeTool(videoGenerateTool, { prompt: "animate this", image_url: "https://cdn.example/still.png" }, tenant),
    );
    expect(fetchMock.mock.calls[3]?.[0]).toBe("https://queue.fal.run/fal-ai/pixverse/v6/image-to-video");
  });

  it("reuses the Ark key only when Seedance is selected", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "cgt-1" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "succeeded", content: { video_url: "https://ark.example/out.mp4" } }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runWithToolSecrets(
      {
        secrets: { ARK_API_KEY: "ark-test", ARK_BASE_URL: "https://ark.cn-beijing.volces.com/api/v3" },
        backends: { video_gen: "volcengine" },
      },
      () => invokeTool(videoGenerateTool, { prompt: "rain on a window" }, tenant),
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/contents/generations/tasks");
    expect(result).toMatchObject({ success: true, backend: "volcengine", video: "https://ark.example/out.mp4" });
  });

  it("does not fall through to Seedance when FAL is selected without FAL_KEY", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await runWithToolSecrets(
      { secrets: { ARK_API_KEY: "ark-test" }, backends: { video_gen: "fal" } },
      () => invokeTool(videoGenerateTool, { prompt: "rain on a window" }, tenant),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false });
  });
});

describe("videoGenerateTool model choice", () => {
  const gateway = { OPENAI_API_KEY: "sk-model", OPENAI_BASE_URL: "https://api.tokotokenai.com/v1" };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubGateway() {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { status: "SUCCESS", result_url: "https://cdn.example/clip.mp4" } }),
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
    options: { secrets?: Record<string, string>; video?: string[] } = {},
  ) {
    return runWithToolSecrets(
      {
        secrets: { ...gateway, ...options.secrets },
        backends: {},
        ...(options.video ? { mediaModels: { image: [], video: options.video } } : {}),
      },
      () => invokeTool(videoGenerateTool, { prompt: "rain on a window", ...args }, tenant),
    );
  }

  it("replaces a model id the desk's catalog does not list with the catalog's video model", async () => {
    const fetchMock = stubGateway();
    const result = await run({ model: "]" }, { video: ["veo_3_1-fast", "seedance-2.0"] });
    expect(sentModel(fetchMock)).toBe("seedance-2.0");
    expect(result).toMatchObject({ success: true, model: "seedance-2.0" });
  });

  it("falls back to the configured video model before the catalog's pick", async () => {
    const fetchMock = stubGateway();
    await run(
      { model: "sora-9" },
      { video: ["seedance-2.0", "veo_3_1-fast"], secrets: { VIDEO_GEN_MODEL: "veo_3_1-fast" } },
    );
    expect(sentModel(fetchMock)).toBe("veo_3_1-fast");
  });

  it("keeps a model the catalog lists, in the catalog's spelling", async () => {
    const fetchMock = stubGateway();
    await run({ model: "VEO_3_1-FAST" }, { video: ["seedance-2.0", "veo_3_1-fast"] });
    expect(sentModel(fetchMock)).toBe("veo_3_1-fast");
  });

  it("with an empty catalog keeps a video model id and otherwise sends the built-in default", async () => {
    const kept = stubGateway();
    await run({ model: "seedance-2.0" }, { video: [] });
    expect(sentModel(kept)).toBe("seedance-2.0");
    vi.unstubAllGlobals();
    const dropped = stubGateway();
    await run({ model: "]" }, { video: [] });
    expect(sentModel(dropped)).toBe("seedance-2.0-fast");
  });

  it("sends the model as given when no catalog is in scope, as the Videos studio calls it", async () => {
    const fetchMock = stubGateway();
    await run({ model: "studio-picked-model" });
    expect(sentModel(fetchMock)).toBe("studio-picked-model");
  });
});
