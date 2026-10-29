/**
 * A chat run's tools read a stored image by its reference, for the caller's organization only.
 *
 * Two organizations under ONE tenant id, each with real rows (`media.organization_id` is a foreign key).
 * Organization A saves an image; organization B holds the same id and must get no bytes from it.
 * Every refusal for B is paired with A reading the same id successfully, so a resolver that refused
 * everybody cannot pass.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { imageGenerateTool, invokeTool, runWithToolSecrets, type TenantContext } from "@agentforge/core";
import type { MediaReferenceResolver } from "@agentforge/core/tools/media-reference";
import type { withChatMediaReferences as WithChatMediaReferences } from "./chat-media-resolver";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-chat-media-ref-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_SECRETS_KEY = "3f9a1c7e5b2d4608a1c3e5f7092b4d6f8a0c2e4f6b8d0a2c4e6f8b0d2f4a6c8e";
delete process.env.AGENTFORGE_RUNTIME;
delete process.env.DATABASE_URL;

const TENANT = "media-ref-tenant";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString("base64")}`;

let orgA: TenantContext;
let orgB: TenantContext;
let mediaId: string;
let resolver: MediaReferenceResolver;
let withReferences: typeof WithChatMediaReferences;

// Imported after the environment above is set: the media store reads it when the module loads.
beforeAll(async () => {
  const { db, ensurePortalOwner } = await import("@agentforge/db");
  orgA = await ensurePortalOwner(db, { tenantId: TENANT, orgId: "org-a", userId: "alice", role: "owner" });
  orgB = await ensurePortalOwner(db, { tenantId: TENANT, orgId: "org-b", userId: "bob", role: "owner" });
  const { saveMedia } = await import("./media");
  const row = await saveMedia(orgA, new File([PNG], "lantern.png", { type: "image/png" }));
  mediaId = row.id;
  const chat = await import("./chat-media-resolver");
  resolver = chat.chatMediaReferenceResolver;
  withReferences = chat.withChatMediaReferences;
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function gatewayFetch() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: [{ url: "https://cdn.example/out.png" }] }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A run as the router starts it: the tool is called inside the wrapped runtime's execute. */
async function editWith(tenant: TenantContext) {
  let output: unknown;
  const runtime = withReferences({
    execute: async () => {
      output = await runWithToolSecrets(
        { secrets: { OPENAI_API_KEY: "sk-model", OPENAI_BASE_URL: "https://api.tokotokenai.com/v1" }, backends: {} },
        () =>
          invokeTool(imageGenerateTool, { prompt: "make it blue", image_url: `/api/v1/media/${mediaId}/file` }, tenant),
      );
    },
  });
  await runtime.execute({} as never);
  return output;
}

describe("chat media reference resolver", () => {
  it("reads the caller's own image as a data URL", async () => {
    expect(await resolver(orgA, mediaId)).toBe(PNG_DATA_URL);
  });

  it("answers null for another organization's media id, not its bytes", async () => {
    expect(await resolver(orgB, mediaId)).toBeNull();
  });

  it("the edit tool sends the image to the gateway for its own organization", async () => {
    const fetchMock = gatewayFetch();
    const result = await editWith(orgA);
    const init = fetchMock.mock.calls[0]?.[1] as { body: string };
    expect(JSON.parse(init.body).image).toBe(PNG_DATA_URL);
    expect(result).toMatchObject({ success: true });
  });

  it("the edit tool refuses another organization's media id with no bytes sent", async () => {
    const fetchMock = gatewayFetch();
    const result = await editWith(orgB);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false });
    expect(String((result as { error: string }).error)).toMatch(/no image/i);
    expect(JSON.stringify(result)).not.toContain("base64");
  });
});
