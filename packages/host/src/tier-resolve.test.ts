import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApiError,
  GATEWAY_PROVIDER_ID,
  INPUT_MODALITIES,
  PROVIDER_IDS,
  assertChatModelAcceptsModality,
  availableProviders,
  modelMisreadsPictures,
  type InputModality,
} from "@agentforge/core";
import { DEFAULT_MODEL_TIER, MODEL_TIERS, TIER_DEFINITIONS, type ModelTierId } from "@agentforge/core/tiers";
import { markJobModelDown, resetJobModelCircuit } from "./job-model-fallback";
import type { SelectableModel } from "./selectable-models";
import {
  chooseTierRun,
  resolveTierForCatalog,
  tierCatalog,
  tierCatalogFields,
  tierLiveness,
  withTierFields,
} from "./tier-resolve";

/**
 * The host half of the model tiers (chat-first plan, track M1): the catalog and the breaker turned into
 * the `TierLiveness` the pure resolver in core asks for, the tier fields of the catalog payload, and the
 * one place a request's `tier` becomes a model and a Thinking choice.
 */

afterEach(() => {
  resetJobModelCircuit();
});

const TEXT: InputModality[] = ["text"];
const TEXT_IMAGE: InputModality[] = ["text", "image"];

function row(id: string, inputModalities: InputModality[] = TEXT, contextLength?: number): SelectableModel {
  return {
    id,
    label: id,
    provider: "openai",
    inputModalities,
    ...(contextLength === undefined ? {} : { contextLength }),
    friendlyLabel: `Friendly ${id}`,
    bestFor: "Fast drafts",
    tier: "everyday",
  };
}

function gatewayCandidates(tier: ModelTierId): readonly string[] {
  return TIER_DEFINITIONS[tier].candidates[GATEWAY_PROVIDER_ID] ?? [];
}

/** A catalog that lists every gateway candidate of every tier, text only. */
function fullCatalog(modalities: InputModality[] = TEXT): SelectableModel[] {
  const ids = [...new Set(MODEL_TIERS.flatMap((tier) => gatewayCandidates(tier)))];
  return ids.map((id) => row(id, modalities));
}

describe("tierLiveness", () => {
  it("offers the providers the registry allows, which off the hosted server is the gateway alone", () => {
    expect(tierLiveness(fullCatalog()).providers).toEqual(availableProviders());
    expect(tierLiveness(fullCatalog()).providers).toEqual([GATEWAY_PROVIDER_ID]);
  });

  it("lists a candidate under the catalog's own spelling, ignoring letter case", () => {
    const liveness = tierLiveness([row("GPT-6-Luna")]);
    expect(liveness.listedAs(GATEWAY_PROVIDER_ID, "gpt-6-luna")).toBe("GPT-6-Luna");
    expect(liveness.listedAs(GATEWAY_PROVIDER_ID, "gpt-6-sol")).toBeUndefined();
  });

  it("supports no provider but the gateway at M1", () => {
    const liveness = tierLiveness(fullCatalog());
    for (const provider of ["openai", "anthropic", "google", "openrouter"] as const) {
      expect(liveness.listedAs(provider, "gpt-6-luna"), provider).toBeUndefined();
    }
  });

  it("asks the breaker by model alone, whatever the provider and whatever the case", () => {
    const liveness = tierLiveness(fullCatalog());
    expect(liveness.isDown(GATEWAY_PROVIDER_ID, "gpt-6-luna")).toBe(false);
    markJobModelDown("GPT-6-LUNA");
    expect(liveness.isDown(GATEWAY_PROVIDER_ID, "gpt-6-luna")).toBe(true);
    expect(liveness.isDown("openai", "gpt-6-luna")).toBe(true);
  });

  it("requires the row to take the modality for image and video, and not for text", () => {
    const catalog = [row("text-only", TEXT), row("sees", TEXT_IMAGE)];
    const text = tierLiveness(catalog, "text");
    const image = tierLiveness(catalog, "image");
    const video = tierLiveness(catalog, "video");
    expect(text.listedAs(GATEWAY_PROVIDER_ID, "text-only")).toBe("text-only");
    expect(image.listedAs(GATEWAY_PROVIDER_ID, "text-only")).toBeUndefined();
    expect(image.listedAs(GATEWAY_PROVIDER_ID, "sees")).toBe("sees");
    expect(video.listedAs(GATEWAY_PROVIDER_ID, "sees")).toBeUndefined();
  });
});

describe("resolveTierForCatalog", () => {
  it("resolves the head of each tier when the catalog lists every candidate", () => {
    const catalog = fullCatalog();
    for (const tier of MODEL_TIERS) {
      const resolved = resolveTierForCatalog(tier, catalog);
      expect(resolved.ok, tier).toBe(true);
      if (resolved.ok) {
        expect(resolved.model).toBe(gatewayCandidates(tier)[0]);
        expect(resolved.provider).toBe(GATEWAY_PROVIDER_ID);
      }
    }
  });

  it("returns the catalog's spelling, not the list's", () => {
    const head = gatewayCandidates("daily")[0] as string;
    const resolved = resolveTierForCatalog("daily", [row(head.toUpperCase())]);
    expect(resolved.ok && resolved.model).toBe(head.toUpperCase());
  });

  it("skips a model the breaker holds down", () => {
    const [head, second] = gatewayCandidates("fast") as [string, string];
    markJobModelDown(head);
    const resolved = resolveTierForCatalog("fast", fullCatalog());
    expect(resolved.ok && resolved.model).toBe(second);
  });

  it("is unavailable when every candidate is held down, and never falls to another tier", () => {
    for (const id of gatewayCandidates("reasoning")) {
      markJobModelDown(id);
    }
    const resolved = resolveTierForCatalog("reasoning", fullCatalog());
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.error).toBe("tier_unavailable");
  });

  it("filters by input modality for an image run", () => {
    const [head, second] = gatewayCandidates("daily") as [string, string];
    const catalog = [row(head, TEXT), row(second, TEXT_IMAGE)];
    const asText = resolveTierForCatalog("daily", catalog, "text");
    const asImage = resolveTierForCatalog("daily", catalog, "image");
    expect(asText.ok && asText.model).toBe(head);
    expect(asImage.ok && asImage.model).toBe(second);
  });

  it("is unavailable for an image run when no listed candidate takes images", () => {
    expect(resolveTierForCatalog("daily", fullCatalog(TEXT), "image").ok).toBe(false);
  });
});

/**
 * A turn that carries a picture tries the models measured to misread one (`PICTURE_MISREADS`: the two Luna
 * models, 2026-11-13) after every other candidate of the tier. The lists, the order of everything else, the
 * Thinking of the tier and what the tier advertises do not move.
 */
describe("a turn that carries a picture", () => {
  const LUNAS = ["gpt-6-luna", "gpt-5.6-luna"];

  /** The first candidate of the tier that is not measured to misread a picture. */
  function firstUnmarked(tier: ModelTierId): string {
    return gatewayCandidates(tier).find((id) => !modelMisreadsPictures(id)) as string;
  }

  function picked(
    tier: ModelTierId,
    catalog: SelectableModel[],
    modality: InputModality,
    replaysPicture = false,
  ): string | undefined {
    const resolved = resolveTierForCatalog(tier, catalog, modality, replaysPicture);
    return resolved.ok ? resolved.model : undefined;
  }

  it("is the walk the tester measured: Daily, Fastest and Reasoning on an image run", () => {
    const catalog = fullCatalog(TEXT_IMAGE);
    // Daily's head is gpt-6-luna, which misread the picture; its next candidate is claude-sonnet-5-5.
    expect(gatewayCandidates("daily")[0]).toBe("gpt-6-luna");
    expect(picked("daily", catalog, "image")).toBe("claude-sonnet-5-5");
    // Fastest already leads with an unmarked model, and Reasoning has none.
    expect(picked("fast", catalog, "image")).toBe("deepseek-v4-1-flash");
    expect(picked("reasoning", catalog, "image")).toBe("claude-opus-5-5");
    for (const tier of MODEL_TIERS) {
      expect(picked(tier, catalog, "image"), tier).toBe(firstUnmarked(tier));
    }
  });

  it("leaves a text turn alone: Daily still answers from gpt-6-luna", () => {
    const catalog = fullCatalog(TEXT_IMAGE);
    expect(picked("daily", catalog, "text")).toBe("gpt-6-luna");
    expect(picked("daily", catalog, "text", false)).toBe("gpt-6-luna");
    for (const tier of MODEL_TIERS) {
      expect(picked(tier, catalog, "text"), tier).toBe(gatewayCandidates(tier)[0]);
    }
  });

  it("demotes the same way on a text turn whose thread replays an earlier picture", () => {
    const catalog = fullCatalog(TEXT_IMAGE);
    expect(picked("daily", catalog, "text", true)).toBe("claude-sonnet-5-5");
    expect(picked("fast", catalog, "text", true)).toBe("deepseek-v4-1-flash");
    expect(picked("reasoning", catalog, "text", true)).toBe("claude-opus-5-5");
  });

  it("does not demote a video run, even one whose catalog lists a Luna as taking video", () => {
    const luna = row("gpt-6-luna", ["text", "image", "video"]);
    const sonnet = row("claude-sonnet-5-5", ["text", "image", "video"]);
    expect(picked("daily", [luna, sonnet], "video")).toBe("gpt-6-luna");
    expect(picked("daily", [luna, sonnet], "video", true)).toBe("gpt-6-luna");
  });

  it("answers from the marked models, in the list's order, when they are all the tier has live", () => {
    for (const tier of ["daily", "fast"] as const) {
      const catalog = LUNAS.map((id) => row(id, TEXT_IMAGE));
      expect(picked(tier, catalog, "image"), tier).toBe("gpt-6-luna");
      expect(picked(tier, [row("gpt-5.6-luna", TEXT_IMAGE)], "image"), tier).toBe("gpt-5.6-luna");
    }
  });

  it("does not drop a marked model that is the only one left because the others are held down", () => {
    const catalog = fullCatalog(TEXT_IMAGE);
    for (const id of gatewayCandidates("fast").filter((candidate) => !modelMisreadsPictures(candidate))) {
      markJobModelDown(id);
    }
    expect(picked("fast", catalog, "image")).toBe("gpt-6-luna");
    markJobModelDown("gpt-6-luna");
    expect(picked("fast", catalog, "image")).toBe("gpt-5.6-luna");
  });

  it("keeps the order of the unmarked candidates, and the catalog's spelling", () => {
    const catalog = [
      row("GPT-6-Luna", TEXT_IMAGE),
      row("Claude-Sonnet-5-5", TEXT_IMAGE),
      row("DeepSeek-V4-1-Flash", TEXT_IMAGE),
    ];
    expect(picked("daily", catalog, "image")).toBe("Claude-Sonnet-5-5");
    markJobModelDown("claude-sonnet-5-5");
    expect(picked("daily", catalog, "image")).toBe("DeepSeek-V4-1-Flash");
    markJobModelDown("deepseek-v4-1-flash");
    expect(picked("daily", catalog, "image")).toBe("GPT-6-Luna");
  });

  it("keeps the Thinking of the tier and never falls to another tier", () => {
    const resolved = resolveTierForCatalog("daily", fullCatalog(TEXT_IMAGE), "image");
    expect(resolved.ok && resolved.thinking).toBe("default");
    const onlyDailyLuna = [row("gpt-6-luna", TEXT_IMAGE)];
    expect(resolveTierForCatalog("reasoning", onlyDailyLuna, "image").ok).toBe(false);
  });

  it("demotes the two marked ids and nothing else, on a picture turn only", () => {
    const text = tierLiveness(fullCatalog(TEXT_IMAGE), "text");
    const image = tierLiveness(fullCatalog(TEXT_IMAGE), "image");
    const replayed = tierLiveness(fullCatalog(TEXT_IMAGE), "text", true);
    const video = tierLiveness(fullCatalog(TEXT_IMAGE), "video", true);
    expect(text.demoted).toBeUndefined();
    expect(video.demoted).toBeUndefined();
    for (const liveness of [image, replayed]) {
      for (const id of [...new Set(MODEL_TIERS.flatMap((tier) => gatewayCandidates(tier)))]) {
        expect(liveness.demoted?.(GATEWAY_PROVIDER_ID, id), id).toBe(LUNAS.includes(id));
      }
    }
  });

  it("is still accepted when a person picks a marked model themselves", () => {
    for (const id of LUNAS) {
      expect(() => assertChatModelAcceptsModality(id, "image"), id).not.toThrow();
    }
  });

  it("does not change what a tier advertises: Daily still takes pictures, with or without a Luna as its only live model", () => {
    const lunaOnly = LUNAS.map((id) => row(id, TEXT_IMAGE, 128_000));
    const daily = tierCatalog(lunaOnly).find((entry) => entry.id === "daily");
    expect(daily).toEqual({ id: "daily", available: true, inputModalities: ["text", "image"], contextLength: 128_000 });
    const full = tierCatalog(fullCatalog(TEXT_IMAGE));
    expect(full.map((entry) => entry.inputModalities)).toEqual([
      ["text", "image"],
      ["text", "image"],
      ["text", "image"],
    ]);
    expect(full.every((entry) => entry.available)).toBe(true);
  });
});

describe("tierCatalog", () => {
  it("has one entry per tier, in MODEL_TIERS order, with exactly the four wire fields", () => {
    const entries = tierCatalog(fullCatalog());
    expect(entries.map((entry) => entry.id)).toEqual([...MODEL_TIERS]);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(["available", "contextLength", "id", "inputModalities"]);
      expect(entry.available).toBe(true);
    }
  });

  it("takes the context length from the model the tier resolves to", () => {
    const [head, second] = gatewayCandidates("daily") as [string, string];
    const entries = tierCatalog([row(head, TEXT, 200_000), row(second, TEXT, 1_000_000)]);
    expect(entries.find((entry) => entry.id === "daily")?.contextLength).toBe(200_000);
  });

  it("answers a null context length when the resolved model has none", () => {
    const entries = tierCatalog(fullCatalog());
    expect(entries.every((entry) => entry.contextLength === null)).toBe(true);
  });

  it("unions the modalities of every live candidate, so an image can be attached whenever a send could resolve", () => {
    const [head, second] = gatewayCandidates("daily") as [string, string];
    // The head takes text only and the second takes images: a text send resolves to the head, an
    // image send to the second, so the tier accepts both.
    const entries = tierCatalog([row(head, TEXT), row(second, TEXT_IMAGE)]);
    expect(entries.find((entry) => entry.id === "daily")?.inputModalities).toEqual(["text", "image"]);
    // A tier whose only listed candidate is text only offers text only.
    const [fastHead] = gatewayCandidates("fast") as [string];
    const textOnly = tierCatalog([row(fastHead, TEXT)]);
    expect(textOnly.find((entry) => entry.id === "fast")?.inputModalities).toEqual(["text"]);
  });

  it("keeps the modalities in the registry's order and never repeats one", () => {
    const [head] = gatewayCandidates("daily") as [string];
    const entries = tierCatalog([row(head, ["video", "image", "text"])]);
    const modalities = entries.find((entry) => entry.id === "daily")?.inputModalities ?? [];
    expect(modalities).toEqual(INPUT_MODALITIES.filter((modality) => modalities.includes(modality)));
    expect(new Set(modalities).size).toBe(modalities.length);
    expect(modalities).toEqual(["text", "image", "video"]);
  });

  it("leaves a modality out when the only candidate that takes it is held down", () => {
    const [head, second] = gatewayCandidates("daily") as [string, string];
    markJobModelDown(second);
    const entries = tierCatalog([row(head, TEXT), row(second, TEXT_IMAGE)]);
    expect(entries.find((entry) => entry.id === "daily")?.inputModalities).toEqual(["text"]);
  });

  it("marks a tier with no live candidate unavailable, text only, with no context length", () => {
    const [dailyHead] = gatewayCandidates("daily") as [string];
    const entries = tierCatalog([row(dailyHead, TEXT_IMAGE, 128_000)]);
    const reasoning = entries.find((entry) => entry.id === "reasoning");
    expect(reasoning).toEqual({ id: "reasoning", available: false, inputModalities: ["text"], contextLength: null });
    expect(entries.find((entry) => entry.id === "daily")?.available).toBe(true);
  });

  it("marks every tier unavailable for an empty catalog", () => {
    const entries = tierCatalog([]);
    expect(entries.map((entry) => entry.available)).toEqual([false, false, false]);
    expect(entries.every((entry) => entry.inputModalities.length === 1 && entry.inputModalities[0] === "text")).toBe(
      true,
    );
  });

  it("names no model id, label or provider anywhere in what it returns", () => {
    const catalog = fullCatalog(TEXT_IMAGE).map((model) => ({ ...model, contextLength: 128_000 }));
    const json = JSON.stringify(tierCatalogFields(catalog)).toLowerCase();
    for (const model of catalog) {
      expect(json, model.id).not.toContain(model.id.toLowerCase());
      expect(json, model.friendlyLabel).not.toContain(model.friendlyLabel.toLowerCase());
    }
    for (const provider of PROVIDER_IDS) {
      expect(json, provider).not.toContain(provider);
    }
  });

  it("does not change the catalog it reads", () => {
    const catalog = Object.freeze(fullCatalog().map((model) => Object.freeze(model)));
    expect(() => tierCatalog(catalog)).not.toThrow();
  });
});

describe("tierCatalogFields", () => {
  it("carries the tiers and the default tier, and nothing else", () => {
    const fields = tierCatalogFields(fullCatalog());
    expect(Object.keys(fields).sort()).toEqual(["defaultTier", "tiers"]);
    expect(fields.defaultTier).toBe("daily");
    expect(fields.defaultTier).toBe(DEFAULT_MODEL_TIER);
    expect(fields.tiers).toEqual(tierCatalog(fullCatalog()));
  });
});

describe("withTierFields", () => {
  it("adds the two fields and keeps every field of the body, unchanged", () => {
    const models = fullCatalog();
    const body = { models, defaultModel: "gpt-6-luna", modes: { image: [] }, defaults: { chat: "gpt-6-luna" } };
    const wired = withTierFields(body);
    expect(wired).toEqual({ ...body, ...tierCatalogFields(models) });
    expect(wired.models).toBe(models);
    expect(Object.keys(body)).toEqual(["models", "defaultModel", "modes", "defaults"]);
  });

  it("is applied by the handlers because selectable-models.ts must not import this file", () => {
    // This file reads the breaker in job-model-fallback.ts, which reads the catalog from
    // selectable-models.ts. An import back would make a cycle, and under a test that mocks
    // `./selectable-models` with `importOriginal` the cycle hands job-model-fallback.ts the real
    // `listSelectableModels` instead of the mock.
    const source = readFileSync(path.join(__dirname, "selectable-models.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["']\.\/tier-resolve["']/);
  });
});

describe("chooseTierRun", () => {
  const catalog = fullCatalog();

  function failure(body: unknown, modality: InputModality = "text", models = catalog): ApiError {
    try {
      chooseTierRun(body, modality, models);
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      return error as ApiError;
    }
    throw new Error("expected chooseTierRun to throw");
  }

  it("answers null, and does not look at the body further, when the body names no tier", () => {
    expect(chooseTierRun({ content: "hi" }, "text", catalog)).toBeNull();
    expect(chooseTierRun({ content: "hi", tier: null }, "text", catalog)).toBeNull();
    expect(chooseTierRun({ content: "hi", model: "anything", tier: undefined }, "text", catalog)).toBeNull();
    expect(chooseTierRun(undefined, "text", catalog)).toBeNull();
    expect(chooseTierRun(null, "text", catalog)).toBeNull();
    expect(chooseTierRun(["tier"], "text", catalog)).toBeNull();
    expect(chooseTierRun("fast", "text", catalog)).toBeNull();
  });

  it("refuses a tier together with a model before it looks at the tier", () => {
    const error = failure({ tier: "not-a-tier", model: "gpt-6-luna" });
    expect(error.code).toBe("tier_and_model");
    expect(error.status).toBe(400);
  });

  it("does not count a blank model as a model", () => {
    const resolved = chooseTierRun({ tier: "daily", model: "   " }, "text", catalog);
    expect(resolved?.tier).toBe("daily");
  });

  it("refuses a tier that is not one, never defaulting it", () => {
    for (const tier of ["Daily", "turbo", "", 7, true, {}, []]) {
      const error = failure({ tier });
      expect(error.code, JSON.stringify(tier)).toBe("unknown_tier");
      expect(error.status).toBe(400);
    }
  });

  it("answers tier_unavailable, 503, when no candidate is live, without naming a model", () => {
    const error = failure({ tier: "reasoning" }, "text", []);
    expect(error.code).toBe("tier_unavailable");
    expect(error.status).toBe(503);
    for (const id of gatewayCandidates("reasoning")) {
      expect(error.message).not.toContain(id);
    }
  });

  it("maps the Thinking of each tier to a reasoning choice", () => {
    expect(chooseTierRun({ tier: "fast" }, "text", catalog)?.reasoning).toEqual({ effort: "none", explicit: true });
    expect(chooseTierRun({ tier: "reasoning" }, "text", catalog)?.reasoning).toEqual({
      effort: "high",
      explicit: true,
    });
    expect(chooseTierRun({ tier: "daily" }, "text", catalog)?.reasoning).toEqual({
      effort: "medium",
      explicit: false,
    });
  });

  it("ignores thinking and reasoningEffort in the body, even a malformed one", () => {
    const resolved = chooseTierRun({ tier: "reasoning", thinking: false, reasoningEffort: 12 }, "text", catalog);
    expect(resolved?.reasoning).toEqual({ effort: "high", explicit: true });
  });

  it("returns the resolved model in the catalog's spelling", () => {
    const resolved = chooseTierRun({ tier: "daily" }, "text", [
      row(gatewayCandidates("daily")[0]?.toUpperCase() ?? ""),
    ]);
    expect(resolved?.model).toBe(gatewayCandidates("daily")[0]?.toUpperCase());
  });

  it("resolves an image run to a model that takes images", () => {
    const [head, second] = gatewayCandidates("daily") as [string, string];
    const resolved = chooseTierRun({ tier: "daily" }, "image", [row(head, TEXT), row(second, TEXT_IMAGE)]);
    expect(resolved?.model).toBe(second);
  });

  it("answers tier_unavailable for an image run when nothing listed takes images", () => {
    expect(failure({ tier: "daily" }, "image", fullCatalog(TEXT)).code).toBe("tier_unavailable");
  });

  it("sends a picture turn on Daily to claude-sonnet-5-5 and keeps the tier's Thinking", () => {
    const pictures = fullCatalog(TEXT_IMAGE);
    const image = chooseTierRun({ tier: "daily" }, "image", pictures);
    expect(image?.model).toBe("claude-sonnet-5-5");
    expect(image?.reasoning).toEqual({ effort: "medium", explicit: false });
    const followUp = chooseTierRun({ tier: "daily" }, "text", pictures, true);
    expect(followUp?.model).toBe("claude-sonnet-5-5");
    expect(chooseTierRun({ tier: "daily" }, "text", pictures)?.model).toBe("gpt-6-luna");
    expect(chooseTierRun({ tier: "fast" }, "image", pictures)?.model).toBe("deepseek-v4-1-flash");
  });

  it("still answers a picture turn when a marked model is all the tier has", () => {
    const resolved = chooseTierRun({ tier: "daily" }, "image", [row("gpt-6-luna", TEXT_IMAGE)]);
    expect(resolved?.model).toBe("gpt-6-luna");
  });
});
