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

const GATEWAY_SECRETS = { OPENAI_API_KEY: "sk-model", OPENAI_BASE_URL: "https://api.tokotokenai.com/v1" };

/** Runs the tool with a stub fetch and returns the JSON body it sent to the first request. */
async function sentBody(args: Record<string, unknown>, secrets = GATEWAY_SECRETS, backends = {}) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: [{ url: "https://cdn.example/out.png" }] }),
  });
  vi.stubGlobal("fetch", fetchMock);
  await runWithToolSecrets({ secrets, backends }, () => invokeTool(imageGenerateTool, args, tenant));
  const init = fetchMock.mock.calls[0]?.[1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("image_generate request body", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Pinned before the style, size and reference changes: a call that passes none of the new
  // parameters must send exactly this body, byte for byte in its fields.
  it("sends the same gateway body for a prompt-only call", async () => {
    expect(await sentBody({ prompt: "a lantern" })).toEqual({
      model: "gpt-image-2.5-flare",
      prompt: "a lantern",
      size: "1024x1024",
      quality: "medium",
    });
  });

  it("sends the same gateway body for an explicit square aspect", async () => {
    expect(await sentBody({ prompt: "a lantern", aspect_ratio: "square" })).toEqual({
      model: "gpt-image-2.5-flare",
      prompt: "a lantern",
      size: "1024x1024",
      quality: "medium",
    });
  });

  it("sends the same FAL body for a prompt-only call", async () => {
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
      invokeTool(imageGenerateTool, { prompt: "a lantern" }, tenant),
    );
    const init = fetchMock.mock.calls[0]?.[1] as { body: string };
    expect(JSON.parse(init.body)).toEqual({ prompt: "a lantern", image_size: "square_hd" });
  });
});
