import { describe, expect, it } from "vitest";
import { ApiError } from "../errors";
import { assertChatModelAcceptsModality, getModelModalities } from "./capabilities";
import { modelImageInput } from "./image-input";

/**
 * Every id here is a row of `docs/internal/gateway-model-selection.md`: its "Modality" column (section 6)
 * or its text-only list (section 1.8). The owner's report was `glm-5.3`, which the old prefix table
 * called vision-capable and the doc lists as text-only.
 */
describe("modelImageInput", () => {
  it("knows the models the gateway doc lists as reading images", () => {
    for (const id of [
      "gpt-4o",
      "gpt-4.1-mini",
      "gpt-5.6-luna",
      "gpt-6-luna",
      "gpt-6-sol",
      "gpt-6-astra",
      "o3",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-haiku-4-5-20251001",
      "gemini-3.5-flash",
      "gemini-3.1-pro-preview",
      "gemma-4-31b-it",
      "deepseek-v4-1-flash",
      "deepseek-v4-flash",
      "glm-5.3-flash",
      "kimi-k3",
      "kimi-k2.6",
      "MiniMax-M3",
      "qwen3.5-plus",
      "qwen3.7-plus",
      "qwen3.8-max",
      "doubao-seed-2-1-pro-260628",
      "seed-1.6",
      "default",
    ]) {
      expect(modelImageInput(id), id).toBe("yes");
    }
  });

  it("knows the models the gateway doc lists as text-only", () => {
    for (const id of [
      "glm-5.3",
      "glm-5.2",
      "glm-5.2-fast-preview",
      "deepseek-v4-pro",
      "gpt-oss-120b",
      "MiniMax-M2.5",
      "MiniMax-M2.7",
      "qwen3-max",
      "qwen3.6-max-preview",
      "qwen-flash",
      "qwen-flash-character",
      "qwen3-coder-flash",
      "o1",
    ]) {
      expect(modelImageInput(id), id).toBe("no");
    }
  });

  it("does not mistake a sibling of a text-only model for it", () => {
    // `glm-5.3-flash` reads images; `glm-5.3` does not.
    expect(modelImageInput("glm-5.3-flash")).toBe("yes");
    expect(modelImageInput("glm-5.3")).toBe("no");
    expect(modelImageInput("deepseek-v4-1-flash")).toBe("yes");
    expect(modelImageInput("deepseek-v4-pro")).toBe("no");
  });

  it("says unknown, not no, for a model it has no line for", () => {
    for (const id of ["hy3", "some-new-model-9", "glm-5.4", "qwen3.9-plus-preview"]) {
      expect(modelImageInput(id), id).toBe("unknown");
    }
    expect(modelImageInput("")).toBe("unknown");
  });

  it("reads past a vendor prefix and the case of the id", () => {
    expect(modelImageInput("openai/GPT-6-Luna")).toBe("yes");
    expect(modelImageInput("zhipu/GLM-5.3")).toBe("no");
  });

  it("says no for an id that is not a chat model at all", () => {
    for (const id of [
      "gpt-image-2",
      "doubao-seedance-2-0-260128",
      "text-embedding-3-small",
      "suno_music",
      "veo_3_1-fast",
    ]) {
      expect(modelImageInput(id), id).toBe("no");
    }
  });
});

describe("the capability table follows it", () => {
  it("lists image input only for a Chat model that is known to read images", () => {
    expect(getModelModalities("glm-5.3").image).toBe(false);
    expect(getModelModalities("deepseek-v4-pro").image).toBe(false);
    expect(getModelModalities("gpt-6-luna").image).toBe(true);
    // An unknown id with no prefix line stays off the capability list; Chat alone decides to try it (below).
    // An unknown id the old prefix list read, such as `glm-5.4`, keeps that answer: see capabilities.test.ts.
    expect(getModelModalities("hy3").image).toBe(false);
  });

  it("leaves a video generator's own answer alone: its image is the still it animates", () => {
    expect(getModelModalities("doubao-seedance-2-0-260128")).toMatchObject({ image: true, video: true });
  });
});

describe("assertChatModelAcceptsModality", () => {
  it("refuses an image for a model known to be text-only", () => {
    try {
      assertChatModelAcceptsModality("glm-5.3", "image");
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("model_missing_modality");
      expect((error as ApiError).status).toBe(400);
    }
  });

  it("lets an image through to a model it knows and to one it has no line for", () => {
    expect(() => assertChatModelAcceptsModality("gpt-6-luna", "image")).not.toThrow();
    expect(() => assertChatModelAcceptsModality("hy3", "image")).not.toThrow();
  });

  it("keeps the strict rule for video", () => {
    expect(() => assertChatModelAcceptsModality("gpt-4o-mini", "video")).toThrow(ApiError);
    expect(() => assertChatModelAcceptsModality("gemini-3.5-flash", "video")).not.toThrow();
  });
});
