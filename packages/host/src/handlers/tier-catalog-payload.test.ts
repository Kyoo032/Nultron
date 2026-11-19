import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INPUT_MODALITIES, PROVIDER_IDS } from "@agentforge/core";
import { MODEL_TIERS } from "@agentforge/core/tiers";
import { ROUTER_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";
import type { HostRequest, HostResult } from "../types";

/**
 * The tier fields of the two catalog payloads (chat-first plan, track M1): `GET /api/v1/models` and
 * `GET /api/v1/chat` each carry `tiers` and `defaultTier` beside everything they carried before.
 *
 * The desk lists three tier models. Daily resolves (to `gpt-6-luna`, which takes text only, and a Claude that
 * also takes images), Fast resolves, and Reasoning has no candidate listed. Every provider's list is cached,
 * each with one row no tier names, so no static fill-in block (`mergeChatCatalog`) joins the catalog: the
 * fill-ins list every tier id, and would make Reasoning available and Fast image-capable here.
 */

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-tier-payload-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "c".repeat(64);
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.AGENTFORGE_MODELS_CACHE_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;

type Dispatch = (request: HostRequest) => Promise<HostResult>;
let dispatch: Dispatch;
const realFetch = globalThis.fetch;

type Modality = "text" | "image" | "video";

type Entry = { id: string; available: boolean; inputModalities: Modality[]; contextLength: number | null };
type Payload = {
  models: Array<{ id: string; contextLength?: number }>;
  defaultModel: string;
  tiers: Entry[];
  defaultTier: string;
};

async function json(method: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const result = await dispatch({ method, path, query: {}, params: {}, headers: {} });
  if (result.type !== "json") {
    throw new Error(`expected json, got ${result.type}`);
  }
  return { status: result.status, body: (result.body ?? {}) as Record<string, unknown> };
}

beforeAll(async () => {
  ({ dispatch } = await import("../router"));
  const { saveModelCache } = await import("../model-cache");
  const { resetCatalogMemo } = await import("../selectable-models");
  saveModelCache({
    openai: [
      { id: "gpt-6-luna", label: "GPT 6 Luna", provider: "openai", inputModalities: ["text"] },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", provider: "openai", inputModalities: ["text", "image"] },
      { id: "deepseek-v4-1-flash", label: "DeepSeek V4.1 Flash", provider: "openai", inputModalities: ["text"] },
    ],
    anthropic: [{ id: "claude-fixture", label: "Claude Fixture", provider: "anthropic", inputModalities: ["text"] }],
    google: [{ id: "gemini-fixture", label: "Gemini Fixture", provider: "google", inputModalities: ["text"] }],
    volcengine: [{ id: "doubao-fixture", label: "Doubao Fixture", provider: "volcengine", inputModalities: ["text"] }],
  });
  resetCatalogMemo();
}, ROUTER_IMPORT_BUDGET_MS);

afterAll(async () => {
  globalThis.fetch = realFetch;
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const SURFACES = [
  { name: "GET /api/v1/models", path: "/api/v1/models" },
  { name: "GET /api/v1/chat", path: "/api/v1/chat" },
] as const;

describe.each(SURFACES)("$name carries the tiers", ({ path }) => {
  async function payload(): Promise<Payload> {
    const { status, body } = await json("GET", path);
    expect(status).toBe(200);
    return body as unknown as Payload;
  }

  it("has one entry per tier, in order, with exactly the four wire fields", async () => {
    const { tiers } = await payload();
    expect(tiers.map((tier) => tier.id)).toEqual([...MODEL_TIERS]);
    for (const tier of tiers) {
      expect(Object.keys(tier).sort()).toEqual(["available", "contextLength", "id", "inputModalities"]);
    }
  });

  it("names Daily the default tier", async () => {
    expect((await payload()).defaultTier).toBe("daily");
  });

  it("still carries the models and the default model", async () => {
    const body = await payload();
    expect(body.models.map((model) => model.id)).toEqual(expect.arrayContaining(["gpt-6-luna", "claude-sonnet-5-5"]));
    expect(typeof body.defaultModel).toBe("string");
    expect(body.defaultModel.length).toBeGreaterThan(0);
  });

  it("marks the tiers whose candidates are listed available, and the one with none unavailable", async () => {
    const byId = new Map((await payload()).tiers.map((tier) => [tier.id, tier]));
    expect(byId.get("daily")?.available).toBe(true);
    expect(byId.get("fast")?.available).toBe(true);
    expect(byId.get("reasoning")).toEqual({
      id: "reasoning",
      available: false,
      inputModalities: ["text"],
      contextLength: null,
    });
  });

  it("lets Daily take an image because a listed candidate does, though its head does not", async () => {
    const daily = (await payload()).tiers.find((tier) => tier.id === "daily");
    expect(daily?.inputModalities).toContain("text");
    expect(daily?.inputModalities).toContain("image");
    expect(daily?.inputModalities).toEqual(
      INPUT_MODALITIES.filter((modality) => daily?.inputModalities.includes(modality)),
    );
  });

  it("keeps Fast to text, since nothing it can resolve to takes an image", async () => {
    expect((await payload()).tiers.find((tier) => tier.id === "fast")?.inputModalities).toEqual(["text"]);
  });

  it("takes a tier's context length from the model it resolves to", async () => {
    const body = await payload();
    const head = body.models.find((model) => model.id === "gpt-6-luna");
    expect(body.tiers.find((tier) => tier.id === "daily")?.contextLength).toBe(head?.contextLength ?? null);
  });

  it("names no model and no provider inside the tier fields", async () => {
    const body = await payload();
    const text = JSON.stringify({ tiers: body.tiers, defaultTier: body.defaultTier }).toLowerCase();
    for (const model of body.models) {
      expect(text, model.id).not.toContain(model.id.toLowerCase());
    }
    for (const provider of [...PROVIDER_IDS, "claude", "gpt", "gemini"]) {
      expect(text, provider).not.toContain(provider);
    }
  });
});

describe("GET /api/v1/chat keeps the rest of its payload", () => {
  it("still carries the agent, the version and the specialists", async () => {
    const { body } = await json("GET", "/api/v1/chat");
    expect(body).toHaveProperty("agent");
    expect(body).toHaveProperty("version");
    expect(body).toHaveProperty("specialists");
  });
});

describe("POST /api/v1/models keeps the tiers on a refresh", () => {
  it("answers the same tier fields beside the probe summary", async () => {
    // No key: a stub desk never calls the gateway; only the models.dev registry refresh runs, and it
    // must not reach the network from a test.
    globalThis.fetch = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    const { status, body } = await json("POST", "/api/v1/models");
    expect(status).toBe(200);
    expect(body).toHaveProperty("probe");
    expect((body.tiers as Entry[]).map((tier) => tier.id)).toEqual([...MODEL_TIERS]);
    expect(body.defaultTier).toBe("daily");
  });
});
