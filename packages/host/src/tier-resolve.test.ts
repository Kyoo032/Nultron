import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError, INPUT_MODALITIES, availableProviders, type InputModality } from "@agentforge/core";
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

function tokoCandidates(tier: ModelTierId): readonly string[] {
  return TIER_DEFINITIONS[tier].candidates.toko ?? [];
}

/** A catalog that lists every Toko Token candidate of every tier, text only. */
function fullCatalog(modalities: InputModality[] = TEXT): SelectableModel[] {
  const ids = [...new Set(MODEL_TIERS.flatMap((tier) => tokoCandidates(tier)))];
  return ids.map((id) => row(id, modalities));
}

describe("tierLiveness", () => {
  it("offers the providers the registry allows, which off the hosted server is Toko Token alone", () => {
    expect(tierLiveness(fullCatalog()).providers).toEqual(availableProviders());
    expect(tierLiveness(fullCatalog()).providers).toEqual(["toko"]);
  });

  it("lists a candidate under the catalog's own spelling, ignoring letter case", () => {
    const liveness = tierLiveness([row("GPT-6-Luna")]);
    expect(liveness.listedAs("toko", "gpt-6-luna")).toBe("GPT-6-Luna");
    expect(liveness.listedAs("toko", "gpt-6-sol")).toBeUndefined();
  });

  it("supports no provider but toko at M1", () => {
    const liveness = tierLiveness(fullCatalog());
    for (const provider of ["openai", "anthropic", "google", "openrouter"] as const) {
      expect(liveness.listedAs(provider, "gpt-6-luna"), provider).toBeUndefined();
    }
  });

  it("asks the breaker by model alone, whatever the provider and whatever the case", () => {
    const liveness = tierLiveness(fullCatalog());
    expect(liveness.isDown("toko", "gpt-6-luna")).toBe(false);
    markJobModelDown("GPT-6-LUNA");
    expect(liveness.isDown("toko", "gpt-6-luna")).toBe(true);
    expect(liveness.isDown("openai", "gpt-6-luna")).toBe(true);
  });

  it("requires the row to take the modality for image and video, and not for text", () => {
    const catalog = [row("text-only", TEXT), row("sees", TEXT_IMAGE)];
    const text = tierLiveness(catalog, "text");
    const image = tierLiveness(catalog, "image");
    const video = tierLiveness(catalog, "video");
    expect(text.listedAs("toko", "text-only")).toBe("text-only");
    expect(image.listedAs("toko", "text-only")).toBeUndefined();
    expect(image.listedAs("toko", "sees")).toBe("sees");
    expect(video.listedAs("toko", "sees")).toBeUndefined();
  });
});

describe("resolveTierForCatalog", () => {
  it("resolves the head of each tier when the catalog lists every candidate", () => {
    const catalog = fullCatalog();
    for (const tier of MODEL_TIERS) {
      const resolved = resolveTierForCatalog(tier, catalog);
      expect(resolved.ok, tier).toBe(true);
      if (resolved.ok) {
        expect(resolved.model).toBe(tokoCandidates(tier)[0]);
        expect(resolved.provider).toBe("toko");
      }
    }
  });

  it("returns the catalog's spelling, not the list's", () => {
    const head = tokoCandidates("daily")[0] as string;
    const resolved = resolveTierForCatalog("daily", [row(head.toUpperCase())]);
    expect(resolved.ok && resolved.model).toBe(head.toUpperCase());
  });

  it("skips a model the breaker holds down", () => {
    const [head, second] = tokoCandidates("fast") as [string, string];
    markJobModelDown(head);
    const resolved = resolveTierForCatalog("fast", fullCatalog());
    expect(resolved.ok && resolved.model).toBe(second);
  });

  it("is unavailable when every candidate is held down, and never falls to another tier", () => {
    for (const id of tokoCandidates("reasoning")) {
      markJobModelDown(id);
    }
    const resolved = resolveTierForCatalog("reasoning", fullCatalog());
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.error).toBe("tier_unavailable");
  });

  it("filters by input modality for an image run", () => {
    const [head, second] = tokoCandidates("daily") as [string, string];
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
    const [head, second] = tokoCandidates("daily") as [string, string];
    const entries = tierCatalog([row(head, TEXT, 200_000), row(second, TEXT, 1_000_000)]);
    expect(entries.find((entry) => entry.id === "daily")?.contextLength).toBe(200_000);
  });

  it("answers a null context length when the resolved model has none", () => {
    const entries = tierCatalog(fullCatalog());
    expect(entries.every((entry) => entry.contextLength === null)).toBe(true);
  });

  it("unions the modalities of every live candidate, so an image can be attached whenever a send could resolve", () => {
    const [head, second] = tokoCandidates("daily") as [string, string];
    // The head takes text only and the second takes images: a text send resolves to the head, an
    // image send to the second, so the tier accepts both.
    const entries = tierCatalog([row(head, TEXT), row(second, TEXT_IMAGE)]);
    expect(entries.find((entry) => entry.id === "daily")?.inputModalities).toEqual(["text", "image"]);
    // A tier whose only listed candidate is text only offers text only.
    const [fastHead] = tokoCandidates("fast") as [string];
    const textOnly = tierCatalog([row(fastHead, TEXT)]);
    expect(textOnly.find((entry) => entry.id === "fast")?.inputModalities).toEqual(["text"]);
  });

  it("keeps the modalities in the registry's order and never repeats one", () => {
    const [head] = tokoCandidates("daily") as [string];
    const entries = tierCatalog([row(head, ["video", "image", "text"])]);
    const modalities = entries.find((entry) => entry.id === "daily")?.inputModalities ?? [];
    expect(modalities).toEqual(INPUT_MODALITIES.filter((modality) => modalities.includes(modality)));
    expect(new Set(modalities).size).toBe(modalities.length);
    expect(modalities).toEqual(["text", "image", "video"]);
  });

  it("leaves a modality out when the only candidate that takes it is held down", () => {
    const [head, second] = tokoCandidates("daily") as [string, string];
    markJobModelDown(second);
    const entries = tierCatalog([row(head, TEXT), row(second, TEXT_IMAGE)]);
    expect(entries.find((entry) => entry.id === "daily")?.inputModalities).toEqual(["text"]);
  });

  it("marks a tier with no live candidate unavailable, text only, with no context length", () => {
    const [dailyHead] = tokoCandidates("daily") as [string];
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
    for (const provider of ["toko", "openai", "anthropic", "google", "openrouter"]) {
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
    for (const id of tokoCandidates("reasoning")) {
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
    const resolved = chooseTierRun({ tier: "daily" }, "text", [row(tokoCandidates("daily")[0]?.toUpperCase() ?? "")]);
    expect(resolved?.model).toBe(tokoCandidates("daily")[0]?.toUpperCase());
  });

  it("resolves an image run to a model that takes images", () => {
    const [head, second] = tokoCandidates("daily") as [string, string];
    const resolved = chooseTierRun({ tier: "daily" }, "image", [row(head, TEXT), row(second, TEXT_IMAGE)]);
    expect(resolved?.model).toBe(second);
  });

  it("answers tier_unavailable for an image run when nothing listed takes images", () => {
    expect(failure({ tier: "daily" }, "image", fullCatalog(TEXT)).code).toBe("tier_unavailable");
  });
});
