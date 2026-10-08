import { describe, expect, it } from "vitest";
import { ApiError } from "../errors";
import { assertAgentSupportsModality, assertModelSupportsModality, getModelModalities } from "./capabilities";
import { chatModelFromId } from "./catalog";
import { modelImageInput } from "./image-input";

describe("getModelModalities", () => {
  it("gives the gateway default text, image, and video", () => {
    expect(getModelModalities("default")).toEqual({
      text: true,
      image: true,
      video: true,
    });
  });

  it("gives gemini text image and video", () => {
    expect(getModelModalities("gemini-3.6-flash")).toEqual({
      text: true,
      image: true,
      video: true,
    });
  });

  it("gives gpt-5 image but not video", () => {
    expect(getModelModalities("gpt-5-mini")).toMatchObject({ image: true, video: false });
    expect(getModelModalities("gpt-5.6-sol")).toMatchObject({ text: true, image: true, video: false });
  });

  it("gives gemma image but not video", () => {
    expect(getModelModalities("gemma-4-31b-it")).toMatchObject({ image: true, video: false });
  });

  it("gives Seedance text image and video", () => {
    expect(getModelModalities("doubao-seedance-2-0-260128")).toEqual({
      text: true,
      image: true,
      video: true,
    });
  });

  it("gives the DeepSeek, Kimi and GLM models that read images image but not video", () => {
    expect(getModelModalities("deepseek-v4-flash")).toMatchObject({ image: true, video: false });
    expect(getModelModalities("kimi-k3")).toMatchObject({ image: true, video: false });
    expect(getModelModalities("glm-5.3-flash")).toMatchObject({ image: true, video: false });
  });

  it("does not give the text-only DeepSeek and GLM models image input", () => {
    // The gateway doc lists both as text-only. The prefix table used to say otherwise, so Chat sent an
    // image to GLM 5.3 and the model never saw it.
    expect(getModelModalities("deepseek-v4-pro")).toMatchObject({ image: false, video: false });
    expect(getModelModalities("glm-5.3")).toMatchObject({ image: false, video: false });
  });

  it("gives Claude image but not video", () => {
    expect(getModelModalities("claude-sonnet-5")).toMatchObject({ image: true, video: false });
  });

  it("keeps the old prefix answer for a model the image rule has no line for", () => {
    // `modelImageInput` says "unknown" for each of these. Documents, Presentation and Finance regenerate a
    // section on a model the person hand-picked, and check this table with the strict rule; before the
    // image rule these ids passed it, and a regeneration with an attachment must not start to be refused.
    for (const id of ["glm-5.4", "deepseek-v5-preview", "doubao-1-5-pro-32k-250115", "ep-20260101-abcde"]) {
      expect(modelImageInput(id), id).toBe("unknown");
      expect(getModelModalities(id).image, id).toBe(true);
      expect(() => assertModelSupportsModality(id, "image"), id).not.toThrow();
    }
  });

  it("still says no for an unknown model with no prefix line, and for a known text-only model", () => {
    expect(modelImageInput("hy3")).toBe("unknown");
    expect(getModelModalities("hy3").image).toBe(false);
    // A known "no" beats a prefix that says yes.
    for (const id of ["glm-5.3", "glm-5.2", "deepseek-v4-pro"]) {
      expect(getModelModalities(id).image, id).toBe(false);
      expect(() => assertModelSupportsModality(id, "image"), id).toThrow(ApiError);
    }
  });

  it("offers image on the picker for an unknown model the prefix list reads, and not for a known text-only one", () => {
    expect(chatModelFromId("glm-5.4", "GLM 5.4", "openai").inputModalities).toContain("image");
    expect(chatModelFromId("glm-5.3", "GLM 5.3", "openai").inputModalities).not.toContain("image");
  });
});

describe("assertModelSupportsModality", () => {
  it("throws model_missing_modality for video on gpt-4o", () => {
    try {
      assertModelSupportsModality("gpt-4o-mini", "video");
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("model_missing_modality");
    }
  });
});

describe("assertAgentSupportsModality", () => {
  it("throws modality_not_enabled when image is not listed", () => {
    try {
      assertAgentSupportsModality(["text"], "image");
      throw new Error("expected throw");
    } catch (error) {
      expect((error as ApiError).code).toBe("modality_not_enabled");
    }
  });
});
