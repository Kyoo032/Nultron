import { afterEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "../../tenancy/types";
import { invokeTool } from "../define-tool";
import { runWithMediaReferenceResolver, type MediaReferenceResolver } from "../media-reference";
import { runWithToolSecrets } from "../secret-scope";
import { imageGenerateTool } from "./image-generate";

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  role: "member",
};

const GATEWAY_SECRETS = { OPENAI_API_KEY: "sk-model", OPENAI_BASE_URL: "https://api.tokotokenai.com/v1" };
const MEDIA_ID = "3f9a1c7e-5b2d-4608-a1c3-e5f7092b4d6f";
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function stubGateway() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: [{ url: "https://cdn.example/out.png" }] }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

function run(args: Record<string, unknown>, resolver?: MediaReferenceResolver, secrets = GATEWAY_SECRETS) {
  const scoped = () => runWithToolSecrets({ secrets, backends: {} }, () => invokeTool(imageGenerateTool, args, tenant));
  return resolver ? runWithMediaReferenceResolver(resolver, scoped) : scoped();
}

describe("image_generate image input", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes an https URL through unchanged", async () => {
    const fetchMock = stubGateway();
    const result = await run({ prompt: "make it blue", image_url: "https://cdn.example/in.png" });
    expect(bodyOf(fetchMock).image).toBe("https://cdn.example/in.png");
    expect(result).toMatchObject({ success: true });
  });

  it("resolves a stored media reference through the resolver, with the caller's tenant", async () => {
    const fetchMock = stubGateway();
    const resolver = vi.fn(async () => PNG_DATA_URL);
    const result = await run({ prompt: "make it blue", image_url: `/api/v1/media/${MEDIA_ID}/file` }, resolver);
    expect(resolver).toHaveBeenCalledWith(tenant, MEDIA_ID);
    expect(bodyOf(fetchMock).image).toBe(PNG_DATA_URL);
    expect(result).toMatchObject({ success: true });
  });

  it("accepts a bare media id as the reference", async () => {
    const fetchMock = stubGateway();
    const resolver = vi.fn(async () => PNG_DATA_URL);
    await run({ prompt: "make it blue", image_url: MEDIA_ID }, resolver);
    expect(resolver).toHaveBeenCalledWith(tenant, MEDIA_ID);
    expect(bodyOf(fetchMock).image).toBe(PNG_DATA_URL);
  });

  it("refuses text that is neither a URL nor a media reference", async () => {
    const fetchMock = stubGateway();
    await expect(run({ prompt: "make it blue", image_url: "the blue one from earlier" })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a media reference when no resolver is installed for the run", async () => {
    const fetchMock = stubGateway();
    const result = await run({ prompt: "make it blue", image_url: MEDIA_ID });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false });
    expect(String((result as { error: string }).error)).toMatch(/not available/i);
  });

  it("answers a clear error, and no bytes, when the resolver finds no image", async () => {
    const fetchMock = stubGateway();
    const result = await run({ prompt: "make it blue", image_url: MEDIA_ID }, async () => null);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false });
    expect(String((result as { error: string }).error)).toMatch(/no image/i);
    expect(JSON.stringify(result)).not.toContain("base64");
  });

  it("refuses a media reference that resolves to something other than an image", async () => {
    const fetchMock = stubGateway();
    const result = await run({ prompt: "make it blue", image_url: MEDIA_ID }, async () => "data:video/mp4;base64,AAAA");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false });
    expect(String((result as { error: string }).error)).toMatch(/not an image/i);
  });

  it("refuses a data URL above the image cap before it reaches the gateway", async () => {
    const fetchMock = stubGateway();
    const oversize = `data:image/png;base64,${"A".repeat(8_400_000)}`;
    const result = await run({ prompt: "make it blue", image_url: oversize });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false });
    expect(String((result as { error: string }).error)).toMatch(/larger than 6 MB/i);
  });
});

describe("image_generate style and size", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("appends a style phrase to the prompt", async () => {
    const fetchMock = stubGateway();
    await run({ prompt: "a lantern", style: "watercolor" });
    const prompt = bodyOf(fetchMock).prompt as string;
    expect(prompt.startsWith("a lantern, ")).toBe(true);
    expect(prompt).toMatch(/watercolor/);
  });

  it("leaves the prompt alone for style none and when no style is given", async () => {
    const fetchMock = stubGateway();
    await run({ prompt: "a lantern", style: "none" });
    expect(bodyOf(fetchMock).prompt).toBe("a lantern");
    fetchMock.mockClear();
    await run({ prompt: "a lantern" });
    expect(bodyOf(fetchMock).prompt).toBe("a lantern");
  });

  it("maps size to the gateway size and lets it win over aspect_ratio", async () => {
    const portrait = stubGateway();
    await run({ prompt: "a lantern", size: "portrait" });
    expect(bodyOf(portrait).size).toBe("1024x1536");

    const wide = stubGateway();
    await run({ prompt: "a lantern", size: "wide" });
    expect(bodyOf(wide).size).toBe("1536x1024");

    const precedence = stubGateway();
    await run({ prompt: "a lantern", size: "portrait", aspect_ratio: "landscape" });
    expect(bodyOf(precedence).size).toBe("1024x1536");
  });

  it("maps size to the FAL image size", async () => {
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
      .mockResolvedValueOnce({ ok: true, json: async () => ({ images: [{ url: "https://cdn.fal.ai/x.png" }] }) });
    vi.stubGlobal("fetch", fetchMock);
    await runWithToolSecrets({ secrets: { FAL_KEY: "fal-test" }, backends: { image_gen: "fal" } }, () =>
      invokeTool(imageGenerateTool, { prompt: "a lantern", size: "wide", style: "flat" }, tenant),
    );
    const init = fetchMock.mock.calls[0]?.[1] as { body: string };
    const payload = JSON.parse(init.body) as { image_size: string; prompt: string };
    expect(payload.image_size).toBe("landscape_16_9");
    expect(payload.prompt).toMatch(/^a lantern, /);
  });
});
