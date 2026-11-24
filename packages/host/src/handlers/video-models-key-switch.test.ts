import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ROUTER_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";
import type { HostRequest, HostResult } from "../types";

/**
 * Key 114 host regression test: switching between two gateway keys whose video model entitlements
 * differ immediately updates `GET /api/v1/videos`, `GET /api/v1/models`, and
 * `GET /api/v1/settings`'s `modelAvailability.kinds.video.offered` in both directions.
 */

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-video-key-switch-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_SECRETS_KEY = "7a3e91c40b2d6f85e1c3a4b908f762d14e5f80a9b2c1d3e4f5a6b7c8d9e0f123";
delete process.env.AGENTFORGE_SERVER;
delete process.env.AGENTFORGE_RUNTIME;
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;

const KEY_A = "sk-fake-key-a-seedance-veo-0001";
const KEY_B = "sk-fake-key-b-grok-seedance-veo-0002";

const MODELS_KEY_A = ["gpt-4o-mini", "doubao-seedance-2-0-260128", "veo_3_1-fast"];
const MODELS_KEY_B = ["gpt-4o-mini", "grok-imagine-video", "doubao-seedance-2-0-260128", "veo_3_1-fast"];

let dispatch: (request: HostRequest) => Promise<HostResult>;

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const result = await dispatch({ method, path, query: {}, params: {}, headers: {}, body });
  if (result.type !== "json") {
    throw new Error(`expected json, got ${result.type}`);
  }
  return { status: result.status, body: (result.body ?? {}) as T };
}

function stubGatewayForKeys(): void {
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (url.endsWith("/models") || url.includes("/v1/models")) {
      const ids = auth.includes(KEY_B) ? MODELS_KEY_B : auth.includes(KEY_A) ? MODELS_KEY_A : [];
      return new Response(
        JSON.stringify({ data: ids.map((id) => ({ id, object: "model" })) }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/api/pricing")) {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  });
}

beforeAll(async () => {
  ({ dispatch } = await import("../router"));
}, ROUTER_IMPORT_BUDGET_MS);

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("Key 114: video model catalog updates immediately on key switches", () => {
  it("updates GET /api/v1/videos and Settings availability across Key A -> Key B -> Key A", async () => {
    stubGatewayForKeys();

    // Save Key A (Seedance + Veo, NO Grok).
    const saveA = await call<{ modelAvailability?: { kinds?: { video?: { offered: number } } } }>(
      "POST",
      "/api/v1/settings",
      { openaiApiKey: KEY_A },
    );
    expect(saveA.status).toBe(200);
    expect(saveA.body.modelAvailability?.kinds?.video?.offered).toBe(2);

    const videosA = await call<{ models: Array<{ id: string }>; defaultModel: string }>("GET", "/api/v1/videos");
    expect(videosA.status).toBe(200);
    const idsA = videosA.body.models.map((m) => m.id);
    expect(idsA).toEqual(expect.arrayContaining(["doubao-seedance-2-0-260128", "veo_3_1-fast"]));
    expect(idsA).not.toContain("grok-imagine-video");

    // Switch to Key B (Grok + Seedance + Veo).
    const saveB = await call<{ modelAvailability?: { kinds?: { video?: { offered: number } } } }>(
      "POST",
      "/api/v1/settings",
      { openaiApiKey: KEY_B },
    );
    expect(saveB.status).toBe(200);
    expect(saveB.body.modelAvailability?.kinds?.video?.offered).toBe(3);

    const videosB = await call<{ models: Array<{ id: string }>; defaultModel: string }>("GET", "/api/v1/videos");
    expect(videosB.status).toBe(200);
    const idsB = videosB.body.models.map((m) => m.id);
    expect(idsB).toEqual(expect.arrayContaining(["grok-imagine-video", "doubao-seedance-2-0-260128", "veo_3_1-fast"]));

    // Switch back to Key A (Grok must immediately disappear).
    const saveA2 = await call<{ modelAvailability?: { kinds?: { video?: { offered: number } } } }>(
      "POST",
      "/api/v1/settings",
      { openaiApiKey: KEY_A },
    );
    expect(saveA2.status).toBe(200);
    expect(saveA2.body.modelAvailability?.kinds?.video?.offered).toBe(2);

    const videosA2 = await call<{ models: Array<{ id: string }>; defaultModel: string }>("GET", "/api/v1/videos");
    expect(videosA2.status).toBe(200);
    const idsA2 = videosA2.body.models.map((m) => m.id);
    expect(idsA2).toEqual(expect.arrayContaining(["doubao-seedance-2-0-260128", "veo_3_1-fast"]));
    expect(idsA2).not.toContain("grok-imagine-video");
  });
});
