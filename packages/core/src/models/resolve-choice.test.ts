import { describe, expect, it } from "vitest";
import { GATEWAY_PROVIDER_ID } from "../providers/gateway-id";
import type { InputModality } from "../tenancy/types";
import { CHOICE_PROFILES, type ChoiceProfile } from "./choice-profiles";
import { type ChoiceCatalogModel, type ResolveChoiceInput, type ResolveRequest, resolveChoice } from "./resolve-choice";

const EVERYDAY_IDS = ["deepseek-v4-1-flash", "gpt-6-luna", "gpt-5.6-luna", "deepseek-v4-flash", "claude-sonnet-5-5"];

const FAST_IDS = ["deepseek-v4-1-flash", "gpt-6-luna", "gpt-5.6-luna", "deepseek-v4-flash"];

const REASONING_IDS = ["claude-opus-5-5", "gpt-6-astra", "gpt-5.6-sol", "kimi-k3"];

function model(id: string, inputModalities: InputModality[] = ["text"]): ChoiceCatalogModel {
  return { id, inputModalities };
}

const LIVE_ALL: ChoiceCatalogModel[] = [...EVERYDAY_IDS, ...REASONING_IDS].map((id) => model(id));

const NONE_DOWN = (): boolean => false;

const opc = CHOICE_PROFILES.opc;

function heldDown(...ids: string[]): (id: string) => boolean {
  return (id) => ids.includes(id);
}

function run(request: ResolveRequest, overrides: Partial<ResolveChoiceInput> = {}) {
  return resolveChoice({
    request,
    profile: opc,
    catalog: LIVE_ALL,
    isDown: NONE_DOWN,
    modality: "text",
    ...overrides,
  });
}

describe("Everyday", () => {
  it("resolves to the first live candidate of the Everyday list, with its own effort", () => {
    expect(run({ kind: "everyday" })).toEqual({
      ok: true,
      ran: "everyday",
      model: "deepseek-v4-1-flash",
      effort: "none",
      crossedOver: false,
    });
  });

  it("skips a held-down candidate and takes the next one", () => {
    expect(run({ kind: "everyday" }, { isDown: heldDown("deepseek-v4-1-flash") })).toEqual({
      ok: true,
      ran: "everyday",
      model: "gpt-6-luna",
      effort: "none",
      crossedOver: false,
    });
  });

  it("walks past the whole fast list to the chat default head at medium", () => {
    expect(run({ kind: "everyday" }, { isDown: heldDown(...FAST_IDS) })).toEqual({
      ok: true,
      ran: "everyday",
      model: "claude-sonnet-5-5",
      effort: "medium",
      crossedOver: false,
    });
  });

  it("reports choice_unavailable when no Everyday model is in the catalog", () => {
    const reasoningOnly = REASONING_IDS.map((id) => model(id));
    expect(run({ kind: "everyday" }, { catalog: reasoningOnly })).toEqual({
      ok: false,
      error: "choice_unavailable",
    });
  });

  it("reports choice_unavailable when every Everyday candidate is held down, without crossing to Reasoning", () => {
    expect(run({ kind: "everyday" }, { isDown: heldDown(...EVERYDAY_IDS) })).toEqual({
      ok: false,
      error: "choice_unavailable",
    });
  });

  it("skips a candidate that cannot read the attached image and takes one that can", () => {
    const catalog = LIVE_ALL.map((entry) =>
      entry.id === "gpt-6-luna" ? model("gpt-6-luna", ["text", "image"]) : entry,
    );
    expect(run({ kind: "everyday" }, { catalog, modality: "image" })).toEqual({
      ok: true,
      ran: "everyday",
      model: "gpt-6-luna",
      effort: "none",
      crossedOver: false,
    });
  });

  it("reports choice_unavailable for a video when no Everyday candidate can read video", () => {
    expect(run({ kind: "everyday" }, { modality: "video" })).toEqual({
      ok: false,
      error: "choice_unavailable",
    });
  });

  it("returns the catalog's spelling of the model and asks the breaker with that same spelling", () => {
    const catalog = [model("GPT-6-Luna")];
    expect(run({ kind: "everyday" }, { catalog })).toEqual({
      ok: true,
      ran: "everyday",
      model: "GPT-6-Luna",
      effort: "none",
      crossedOver: false,
    });
    expect(run({ kind: "everyday" }, { catalog, isDown: heldDown("GPT-6-Luna") })).toEqual({
      ok: false,
      error: "choice_unavailable",
    });
  });

  it("coerces a candidate whose model cannot be turned off, so Off becomes its lowest level", () => {
    const floorProfile: ChoiceProfile = {
      id: "opc",
      lists: { everyday: { [GATEWAY_PROVIDER_ID]: [{ model: "gpt-6-astra", effort: "none" }] }, reasoning: {} },
    };
    expect(run({ kind: "everyday" }, { profile: floorProfile, catalog: [model("gpt-6-astra")] })).toEqual({
      ok: true,
      ran: "everyday",
      model: "gpt-6-astra",
      effort: "low",
      crossedOver: false,
    });
  });
});

describe("Reasoning", () => {
  it("resolves to the first live Reasoning candidate at high", () => {
    expect(run({ kind: "reasoning" })).toEqual({
      ok: true,
      ran: "reasoning",
      model: "claude-opus-5-5",
      effort: "high",
      crossedOver: false,
    });
  });

  it("skips a held-down Reasoning candidate and takes the next one", () => {
    expect(run({ kind: "reasoning" }, { isDown: heldDown("claude-opus-5-5") })).toEqual({
      ok: true,
      ran: "reasoning",
      model: "gpt-6-astra",
      effort: "high",
      crossedOver: false,
    });
  });

  it("reports choice_unavailable when no Reasoning model is in the catalog", () => {
    const everydayOnly = EVERYDAY_IDS.map((id) => model(id));
    expect(run({ kind: "reasoning" }, { catalog: everydayOnly })).toEqual({
      ok: false,
      error: "choice_unavailable",
    });
  });

  it("takes a Reasoning model that reads video when the attachment is a video", () => {
    const catalog = LIVE_ALL.map((entry) =>
      entry.id === "claude-opus-5-5" ? model("claude-opus-5-5", ["text", "image", "video"]) : entry,
    );
    expect(run({ kind: "reasoning" }, { catalog, modality: "video" })).toEqual({
      ok: true,
      ran: "reasoning",
      model: "claude-opus-5-5",
      effort: "high",
      crossedOver: false,
    });
  });
});

describe("Auto with a decided kind", () => {
  it("runs Everyday when Everyday is live, without a crossover", () => {
    expect(run({ kind: "auto", pick: "everyday" })).toEqual({
      ok: true,
      ran: "everyday",
      model: "deepseek-v4-1-flash",
      effort: "none",
      crossedOver: false,
    });
  });

  it("runs Reasoning when Reasoning is live, without a crossover", () => {
    expect(run({ kind: "auto", pick: "reasoning" })).toEqual({
      ok: true,
      ran: "reasoning",
      model: "claude-opus-5-5",
      effort: "high",
      crossedOver: false,
    });
  });

  it("crosses to Reasoning and says so when Everyday has no allowed live model", () => {
    expect(run({ kind: "auto", pick: "everyday" }, { isDown: heldDown(...EVERYDAY_IDS) })).toEqual({
      ok: true,
      ran: "reasoning",
      model: "claude-opus-5-5",
      effort: "high",
      crossedOver: true,
    });
  });

  it("crosses to Everyday and says so when Reasoning has no model in the catalog", () => {
    const everydayOnly = EVERYDAY_IDS.map((id) => model(id));
    expect(run({ kind: "auto", pick: "reasoning" }, { catalog: everydayOnly })).toEqual({
      ok: true,
      ran: "everyday",
      model: "deepseek-v4-1-flash",
      effort: "none",
      crossedOver: true,
    });
  });

  it("crosses to Reasoning for a video when no Everyday model can read video", () => {
    const catalog = LIVE_ALL.map((entry) =>
      entry.id === "claude-opus-5-5" ? model("claude-opus-5-5", ["text", "image", "video"]) : entry,
    );
    expect(run({ kind: "auto", pick: "everyday" }, { catalog, modality: "video" })).toEqual({
      ok: true,
      ran: "reasoning",
      model: "claude-opus-5-5",
      effort: "high",
      crossedOver: true,
    });
  });

  it("keeps Everyday for an image when the Everyday model reads images", () => {
    const catalog = LIVE_ALL.map((entry) =>
      entry.id === "gpt-6-luna" ? model("gpt-6-luna", ["text", "image"]) : entry,
    );
    expect(run({ kind: "auto", pick: "everyday" }, { catalog, modality: "image" })).toEqual({
      ok: true,
      ran: "everyday",
      model: "gpt-6-luna",
      effort: "none",
      crossedOver: false,
    });
  });

  it("reports choice_unavailable when neither kind resolves", () => {
    expect(run({ kind: "auto", pick: "everyday" }, { isDown: heldDown(...EVERYDAY_IDS, ...REASONING_IDS) })).toEqual({
      ok: false,
      error: "choice_unavailable",
    });
  });
});

describe("Custom", () => {
  it("resolves a listed model at the effort the person chose", () => {
    expect(run({ kind: "custom", model: "claude-opus-5-5", effort: "low" })).toEqual({
      ok: true,
      ran: "custom",
      model: "claude-opus-5-5",
      effort: "low",
      crossedOver: false,
    });
  });

  it("passes the model default through as the effort", () => {
    expect(run({ kind: "custom", model: "gpt-6-luna", effort: "default" })).toEqual({
      ok: true,
      ran: "custom",
      model: "gpt-6-luna",
      effort: "default",
      crossedOver: false,
    });
  });

  it("accepts low on a GPT-6 model, whose levels start at low", () => {
    expect(run({ kind: "custom", model: "gpt-6-astra", effort: "low" })).toEqual({
      ok: true,
      ran: "custom",
      model: "gpt-6-astra",
      effort: "low",
      crossedOver: false,
    });
  });

  it("returns the catalog's spelling when the request spells the model in capitals", () => {
    expect(run({ kind: "custom", model: "CLAUDE-OPUS-5-5", effort: "high" })).toEqual({
      ok: true,
      ran: "custom",
      model: "claude-opus-5-5",
      effort: "high",
      crossedOver: false,
    });
  });

  it("refuses a model that is not in the allowed catalog with custom_model_not_allowed", () => {
    expect(run({ kind: "custom", model: "kimi-k2", effort: "default" })).toEqual({
      ok: false,
      error: "custom_model_not_allowed",
    });
  });

  it("refuses a model outside the catalog before it reads the effort", () => {
    expect(run({ kind: "custom", model: "not-listed", effort: "high" })).toEqual({
      ok: false,
      error: "custom_model_not_allowed",
    });
  });

  it("refuses an effort the model does not take with custom_effort_invalid", () => {
    const catalog = [...LIVE_ALL, model("gpt-7-nova")];
    expect(run({ kind: "custom", model: "gpt-7-nova", effort: "high" }, { catalog })).toEqual({
      ok: false,
      error: "custom_effort_invalid",
    });
  });

  it("still accepts the model default on a model the policy table does not know", () => {
    const catalog = [...LIVE_ALL, model("gpt-7-nova")];
    expect(run({ kind: "custom", model: "gpt-7-nova", effort: "default" }, { catalog })).toEqual({
      ok: true,
      ran: "custom",
      model: "gpt-7-nova",
      effort: "default",
      crossedOver: false,
    });
  });

  it("reports a bad effort before a held-down model", () => {
    const catalog = [...LIVE_ALL, model("gpt-7-nova")];
    expect(
      run({ kind: "custom", model: "gpt-7-nova", effort: "high" }, { catalog, isDown: heldDown("gpt-7-nova") }),
    ).toEqual({ ok: false, error: "custom_effort_invalid" });
  });

  it("refuses a held-down model with custom_model_unavailable and never swaps it for a live one", () => {
    expect(
      run({ kind: "custom", model: "claude-opus-5-5", effort: "low" }, { isDown: heldDown("claude-opus-5-5") }),
    ).toEqual({ ok: false, error: "custom_model_unavailable" });
  });
});
