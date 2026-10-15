import { describe, expect, it } from "vitest";
import {
  CHOICE_REQUEST_ERRORS,
  CUSTOM_EFFORTS,
  DEFAULT_MODEL_CHOICE,
  legacyTierToChoice,
  MODEL_CHOICES,
  PRESET_CHOICES,
  RAN_CHOICES,
  readChoiceRequest,
} from "./model-choice";

describe("model choice ids", () => {
  it("lists the four choices in the order the picker shows them", () => {
    expect(MODEL_CHOICES).toEqual(["auto", "everyday", "reasoning", "custom"]);
  });

  it("defaults to Auto", () => {
    expect(DEFAULT_MODEL_CHOICE).toBe("auto");
  });

  it("has three preset choices and no custom one", () => {
    expect(PRESET_CHOICES).toEqual(["auto", "everyday", "reasoning"]);
  });

  it("lists the Custom effort set: model default, low, medium, high", () => {
    expect(CUSTOM_EFFORTS).toEqual(["default", "low", "medium", "high"]);
  });

  it("names the run labels Everyday, Reasoning and Custom", () => {
    expect(RAN_CHOICES).toEqual(["everyday", "reasoning", "custom"]);
  });

  it("names the three request errors the parser can return", () => {
    expect(CHOICE_REQUEST_ERRORS).toEqual(["unknown_choice", "custom_model_required", "custom_effort_invalid"]);
  });
});

describe("readChoiceRequest with a preset", () => {
  it.each(["auto", "everyday", "reasoning"])("accepts %s as its own kind", (value) => {
    expect(readChoiceRequest(value)).toEqual({ ok: true, request: { kind: value } });
  });

  it("reads a missing choice as Auto", () => {
    expect(readChoiceRequest(undefined)).toEqual({ ok: true, request: { kind: "auto" } });
  });

  it("reads a JSON null as Auto", () => {
    expect(readChoiceRequest(null)).toEqual({ ok: true, request: { kind: "auto" } });
  });

  it("refuses a capitalised preset: the match is exact", () => {
    expect(readChoiceRequest("Everyday")).toEqual({ ok: false, error: "unknown_choice" });
  });

  it("refuses a retired tier name", () => {
    expect(readChoiceRequest("fast")).toEqual({ ok: false, error: "unknown_choice" });
  });

  it("refuses a number", () => {
    expect(readChoiceRequest(3)).toEqual({ ok: false, error: "unknown_choice" });
  });

  it("refuses an object whose kind is a preset: presets are sent as strings", () => {
    expect(readChoiceRequest({ kind: "everyday" })).toEqual({ ok: false, error: "unknown_choice" });
  });

  it("refuses an array", () => {
    expect(readChoiceRequest([])).toEqual({ ok: false, error: "unknown_choice" });
  });

  it("refuses an object with no kind", () => {
    expect(readChoiceRequest({ model: "claude-opus-5-5", effort: "low" })).toEqual({
      ok: false,
      error: "unknown_choice",
    });
  });

  it("refuses the bare string custom, because a Custom choice needs a model", () => {
    expect(readChoiceRequest("custom")).toEqual({ ok: false, error: "custom_model_required" });
  });
});

describe("readChoiceRequest with a custom choice", () => {
  it("reads a model and an effort and trims the model", () => {
    expect(readChoiceRequest({ kind: "custom", model: "  claude-opus-5-5 ", effort: "high" })).toEqual({
      ok: true,
      request: { kind: "custom", model: "claude-opus-5-5", effort: "high" },
    });
  });

  it("accepts the model default as an effort", () => {
    expect(readChoiceRequest({ kind: "custom", model: "gpt-6-luna", effort: "default" })).toEqual({
      ok: true,
      request: { kind: "custom", model: "gpt-6-luna", effort: "default" },
    });
  });

  it("refuses a missing model", () => {
    expect(readChoiceRequest({ kind: "custom", effort: "low" })).toEqual({
      ok: false,
      error: "custom_model_required",
    });
  });

  it("refuses an empty model after trimming", () => {
    expect(readChoiceRequest({ kind: "custom", model: "   ", effort: "low" })).toEqual({
      ok: false,
      error: "custom_model_required",
    });
  });

  it("refuses a model that is not a string", () => {
    expect(readChoiceRequest({ kind: "custom", model: 7, effort: "low" })).toEqual({
      ok: false,
      error: "custom_model_required",
    });
  });

  it("refuses a missing effort, because the effort is never assumed", () => {
    expect(readChoiceRequest({ kind: "custom", model: "gpt-6-luna" })).toEqual({
      ok: false,
      error: "custom_effort_invalid",
    });
  });

  it("refuses Off as an effort: Custom offers only the model default, low, medium and high", () => {
    expect(readChoiceRequest({ kind: "custom", model: "gpt-6-luna", effort: "none" })).toEqual({
      ok: false,
      error: "custom_effort_invalid",
    });
  });

  it("refuses an effort above high", () => {
    expect(readChoiceRequest({ kind: "custom", model: "claude-opus-5-5", effort: "xhigh" })).toEqual({
      ok: false,
      error: "custom_effort_invalid",
    });
  });

  it("reports a missing model before a bad effort", () => {
    expect(readChoiceRequest({ kind: "custom", effort: "none" })).toEqual({
      ok: false,
      error: "custom_model_required",
    });
  });
});

describe("legacyTierToChoice", () => {
  it("maps the saved daily tier to Auto", () => {
    expect(legacyTierToChoice("daily")).toBe("auto");
  });

  it("maps the saved fast tier to Everyday", () => {
    expect(legacyTierToChoice("fast")).toBe("everyday");
  });

  it("maps the saved reasoning tier to Reasoning", () => {
    expect(legacyTierToChoice("reasoning")).toBe("reasoning");
  });

  it("maps nothing else, and never the names of object properties", () => {
    expect(legacyTierToChoice("Daily")).toBeUndefined();
    expect(legacyTierToChoice("constructor")).toBeUndefined();
    expect(legacyTierToChoice(undefined)).toBeUndefined();
    expect(legacyTierToChoice(null)).toBeUndefined();
  });
});
