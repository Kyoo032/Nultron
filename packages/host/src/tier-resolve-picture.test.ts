import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, GATEWAY_PROVIDER_ID, type InputModality, type TenantContext } from "@agentforge/core";
import { MODEL_TIERS, TIER_DEFINITIONS } from "@agentforge/core/tiers";
import type { SelectableModel } from "./selectable-models";

/**
 * `resolveTierRun` asks the thread whether an earlier picture reaches the model only when the answer can
 * matter: a text run that names a tier. The catalog is the one the test sets; the router and the database
 * are not involved (`runs-tier.test.ts` drives the same path through them).
 */

const state = vi.hoisted(() => ({ catalog: [] as SelectableModel[] }));

vi.mock("./selectable-models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./selectable-models")>();
  return { ...actual, listSelectableModels: () => state.catalog };
});

import { markJobModelDown, resetJobModelCircuit } from "./job-model-fallback";
import { resolveTierRun } from "./tier-resolve";

afterEach(() => {
  resetJobModelCircuit();
});

const TEXT_IMAGE_VIDEO: InputModality[] = ["text", "image", "video"];

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "ws",
  userId: "user",
  role: "owner",
};

function row(id: string): SelectableModel {
  return {
    id,
    label: id,
    provider: "openai",
    inputModalities: TEXT_IMAGE_VIDEO,
    friendlyLabel: `Friendly ${id}`,
    bestFor: "Fast drafts",
    tier: "everyday",
  };
}

function everyCandidate(): SelectableModel[] {
  const ids = MODEL_TIERS.flatMap((tier) => TIER_DEFINITIONS[tier].candidates[GATEWAY_PROVIDER_ID] ?? []);
  return [...new Set(ids)].map(row);
}

function run(modality: InputModality, body: unknown, threadReplaysPicture?: () => Promise<boolean>) {
  state.catalog = everyCandidate();
  return resolveTierRun({
    body,
    modality,
    tenant,
    ...(threadReplaysPicture ? { threadReplaysPicture } : {}),
  });
}

describe("resolveTierRun and the thread's pictures", () => {
  it("asks once for a text run that names a tier, and demotes a Luna when the answer is yes", async () => {
    const asked = vi.fn(async () => true);
    const resolved = await run("text", { content: "and the right half?", tier: "daily" }, asked);
    expect(asked).toHaveBeenCalledTimes(1);
    expect(resolved?.model).toBe("claude-sonnet-5-5");
  });

  it("keeps the head of Daily when the thread replays no picture, and when nobody can say", async () => {
    const no = vi.fn(async () => false);
    expect((await run("text", { content: "hi", tier: "daily" }, no))?.model).toBe("gpt-6-luna");
    expect(no).toHaveBeenCalledTimes(1);
    expect((await run("text", { content: "hi", tier: "daily" }))?.model).toBe("gpt-6-luna");
  });

  it("does not ask when the body names no tier, and returns null", async () => {
    const asked = vi.fn(async () => true);
    expect(await run("text", { content: "hi" }, asked)).toBeNull();
    expect(await run("text", { content: "hi", tier: null }, asked)).toBeNull();
    expect(await run("text", { content: "hi", model: "gpt-6-luna" }, asked)).toBeNull();
    expect(asked).not.toHaveBeenCalled();
  });

  it("does not ask for an image run, which carries its picture by its route, or for a video run", async () => {
    const asked = vi.fn(async () => false);
    const image = await run("image", { content: [], tier: "daily" }, asked);
    expect(image?.model).toBe("claude-sonnet-5-5");
    const video = await run("video", { content: [], tier: "daily" }, asked);
    expect(video?.model).toBe("gpt-6-luna");
    expect(asked).not.toHaveBeenCalled();
  });

  it("holds a text-only model to the end of the walk while the thread replays a picture", async () => {
    // `deepseek-v4-pro` cannot read a picture at all (`TEXT_ONLY`), where a Luna only misreads one.
    // The walk leaves it for last the same way: it answers only when nothing else of the tier is live.
    markJobModelDown("claude-opus-5-5", Date.now(), tenant);
    markJobModelDown("gpt-6-astra", Date.now(), tenant);
    const resolved = await run("text", { content: "and the right half?", tier: "reasoning" }, async () => true);
    expect(resolved?.model).toBe("qwen3.8-max");
    const noPicture = await run("text", { content: "hi", tier: "reasoning" }, async () => false);
    expect(noPicture?.model).toBe("deepseek-v4-pro");
  });

  it("still refuses a model beside a tier, and a name that is not a tier", async () => {
    const asked = async () => true;
    await expect(run("text", { tier: "daily", model: "gpt-6-luna" }, asked)).rejects.toMatchObject({
      code: "tier_and_model",
    });
    await expect(run("text", { tier: "turbo" }, asked)).rejects.toBeInstanceOf(ApiError);
  });
});
