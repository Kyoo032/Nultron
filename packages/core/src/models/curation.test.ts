import { describe, expect, it } from "vitest";
import { applyCuration, curateModel, friendlyModelLabel, isEverydayModel } from "./curation";

describe("curateModel", () => {
  it("marks the Recommended set of 2026-09-30", () => {
    const everydayIds = [
      "gpt-6-luna",
      "openai/gpt-6-luna",
      "claude-sonnet-5-5",
      "deepseek-v4-1-flash",
      "gemini-3.5-flash",
      "gpt-6-sol",
      "glm-5.3-flash",
      "qwen3.7-plus",
    ];
    for (const id of everydayIds) {
      expect(curateModel(id).tier, id).toBe("everyday");
      expect(isEverydayModel(id), id).toBe(true);
    }
  });

  it("moved the 2026-09-13 everyday set that is no longer recommended to advanced", () => {
    for (const id of [
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "openai/gpt-5.6-luna",
      "claude-sonnet-5",
      "MiniMax-M3",
      "minimax-m3",
      "doubao-seed-2-1-turbo-260628",
    ]) {
      expect(curateModel(id).tier, id).toBe("advanced");
      expect(isEverydayModel(id), id).toBe(false);
    }
  });

  it("does not treat older or specialty brand cousins as everyday", () => {
    const advancedIds = [
      "gpt-4o-mini",
      "openai/gpt-4o-mini",
      "gpt-5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "claude-sonnet-4-6",
      "claude-opus-5",
      "claude-haiku-4-5",
      "gemini-2.5-flash",
      "gemini-3-pro",
      "gemini-embedding-001",
      "deepseek-v4-pro",
      "MiniMax-M2.1",
      "minimax-m2",
      "grok-3",
      "gpt-5.6-sol",
      "kimi-k3",
      "gemini-3-flash",
      "deepseek-v4-flash",
      "gpt-6-astra",
      "claude-opus-5-5",
      "hy3",
    ];
    for (const id of advancedIds) {
      expect(curateModel(id).tier, id).toBe("advanced");
      expect(isEverydayModel(id), id).toBe(false);
    }
  });

  it("marks obscure specialty ids as advanced", () => {
    const meta = curateModel("acme-quantum-embed-v9");
    expect(meta.tier).toBe("advanced");
    expect(isEverydayModel("acme-quantum-embed-v9")).toBe(false);
    expect(meta.bestFor).toBe("General chat");
  });

  it("strips vendor prefixes and dates from friendlyLabel", () => {
    expect(curateModel("openai/gpt-5.6-sol").friendlyLabel).toBe("GPT 5.6 Sol");
    expect(curateModel("claude-sonnet-5-20250514").friendlyLabel).toMatch(/Claude Sonnet 5/);
    expect(curateModel("deepseek-v4-flash").friendlyLabel).toBe("DeepSeek V4 Flash");
  });

  it("writes a dashed version as a dotted one, and leaves a dashed date alone", () => {
    // The picker showed these as "Claude Opus 5 5" and "Claude Haiku 4 5" (found driving webdev,
    // 2026-09-29): an id has no dots to keep, so two short numbers in a row are one version.
    expect(curateModel("claude-opus-5-5").friendlyLabel).toBe("Claude Opus 5.5");
    expect(curateModel("claude-haiku-4-5").friendlyLabel).toBe("Claude Haiku 4.5");
    expect(curateModel("claude-haiku-4-5-20251001").friendlyLabel).toBe("Claude Haiku 4.5");
    expect(curateModel("claude-opus-4-5-20251101").friendlyLabel).toBe("Claude Opus 4.5");
    expect(curateModel("grok-4-1-fast-reasoning").friendlyLabel).toBe("Grok 4.1 Fast Reasoning");
    expect(curateModel("gemini-2-5-flash").friendlyLabel).toBe("Gemini 2.5 Flash");
    expect(curateModel("doubao-seed-1-6-thinking").friendlyLabel).toBe("Doubao Seed 1.6 Thinking");
    // A version that already has its dot, and a lone number, are untouched.
    expect(curateModel("gpt-5.6-luna").friendlyLabel).toBe("GPT 5.6 Luna");
    expect(curateModel("claude-sonnet-5").friendlyLabel).toBe("Claude Sonnet 5");
    // 2025-12-01 is a date, not version 12.01.
    expect(curateModel("qwen3-omni-flash-2025-12-01").friendlyLabel).toBe("Qwen3 Omni Flash 2025 12 01");
    expect(curateModel("o3-mini-2025-01-31").friendlyLabel).toBe("O3 Mini 2025 01 31");
  });

  // Found driving webdev on 2026-10-01: the Recommended group read "Glm 5.3 Flash" and
  // "DeepSeek V4 1 Flash". A label is the id read aloud, so brand and unit words keep their own case
  // and a dashed version is one dotted number.
  it.each([
    // Acronyms keep their capitals.
    ["glm-5.3-flash", "GLM 5.3 Flash"],
    ["glm-5.2-fast-preview", "GLM 5.2 Fast"],
    ["glm-5-turbo", "GLM 5 Turbo"],
    ["gpt-4o-mini-tts", "GPT 4o Mini TTS"],
    ["gpt-5.6-sol", "GPT 5.6 Sol"],
    ["qwen-mt-turbo", "Qwen MT Turbo"],
    ["qwen3-vl-embedding", "Qwen3 VL Embedding"],
    ["qwen3.5-ocr", "Qwen3.5 OCR"],
    ["acme-ai-chat", "Acme AI Chat"],
    ["glm4-5", "GLM4.5"],
    // Parameter counts are units.
    ["qwen3.5-27b", "Qwen3.5 27B"],
    ["qwen3.5-35b-a3b", "Qwen3.5 35B A3B"],
    ["gpt-oss-120b", "GPT OSS 120B"],
    ["gemma-4-31b-it", "Gemma 4 31B IT"],
    // A version split by the dashes of an id is one dotted number, and a dotted one is left alone.
    ["deepseek-v4-1-flash", "DeepSeek V4.1 Flash"],
    ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash"],
    ["deepseek-v4-1-flash-260910", "DeepSeek V4.1 Flash 260910"],
    ["deepseek-v4-flash", "DeepSeek V4 Flash"],
    ["kimi-k2-6", "Kimi K2.6"],
    ["kimi-k2.6", "Kimi K2.6"],
    ["mistral-7b-instruct-v0-3", "Mistral 7B Instruct V0.3"],
    // Not versions: a date, a lone letter-number name, a name that merely ends in a digit.
    ["o3-mini-2025-01-31", "O3 Mini 2025 01 31"],
    ["o3-mini", "O3 Mini"],
    ["MiniMax-M3", "MiniMax M3"],
    ["hy3", "Hy3"],
    ["openai/gpt-6-luna", "GPT 6 Luna"],
  ])("writes %s as %s", (id, label) => {
    expect(friendlyModelLabel(id)).toBe(label);
    expect(curateModel(id).friendlyLabel).toBe(label);
  });

  it("picks bestFor from the gateway catalog, not id keywords", () => {
    expect(curateModel("gpt-5.6-terra").bestFor).toBe("Everyday chat");
    expect(curateModel("gpt-5.6-sol").bestFor).toBe("Deep reasoning");
    expect(curateModel("gpt-5.6-luna").bestFor).toBe("Fast drafts");
    // The 2026-09-30 recommendations.
    expect(curateModel("gpt-6-luna").bestFor).toBe("Fast drafts");
    expect(curateModel("gpt-6-sol").bestFor).toBe("Everyday chat");
    expect(curateModel("gpt-6-astra").bestFor).toBe("Deep reasoning");
    expect(curateModel("claude-sonnet-5-5").bestFor).toBe("Everyday chat");
    expect(curateModel("claude-opus-5-5").bestFor).toBe("Deep reasoning");
    expect(curateModel("deepseek-v4-1-flash").bestFor).toBe("Fast drafts");
    expect(curateModel("gemini-3.5-flash").bestFor).toBe("Everyday chat");
    expect(curateModel("MiniMax-M3").bestFor).toBe("Everyday chat");
    expect(curateModel("gpt-5.5-pro").bestFor).toBe("Deep reasoning");
    expect(curateModel("claude-haiku-4-5").bestFor).toBe("Fast drafts");
    expect(curateModel("unknown-lab-model").bestFor).toBe("General chat");
    // First Section 6 role can say Everyday chat without putting the id in the 1.1 set.
    expect(curateModel("claude-opus-5").bestFor).toBe("Everyday chat");
    expect(curateModel("claude-opus-5").tier).toBe("advanced");
  });
});

describe("media models are not called General chat", () => {
  it("says Image for image generators the role table has no line for", () => {
    for (const id of ["gpt-image-1", "gpt-image-1-mini", "gpt-image-1.5", "gpt-image-2.5-flare-token", "dall-e-3"]) {
      expect(curateModel(id).bestFor, id).toBe("Image");
    }
  });

  it("says Video for video generators the role table has no line for", () => {
    for (const id of ["seedance-2.0", "sora-2", "kling-v2", "veo_3_2"]) {
      expect(curateModel(id).bestFor, id).toBe("Video");
    }
  });

  it("says Audio for speech and music ids, and keeps the role table's word when it has one", () => {
    expect(curateModel("gpt-4o-mini-tts").bestFor).toBe("Audio");
    expect(curateModel("gpt-audio-mini").bestFor).toBe("Audio");
    expect(curateModel("suno_music").bestFor).toBe("Audio");
    // A role-table line beats the guess from the id.
    expect(curateModel("qwen-mt-turbo").bestFor).toBe("Translation");
    expect(curateModel("seedance-2.5").bestFor).toBe("Video");
  });

  it("leaves a chat id nobody described as General chat", () => {
    expect(curateModel("acme-chat-9").bestFor).toBe("General chat");
    expect(curateModel("hy3").bestFor).toBe("General chat");
  });
});

describe("applyCuration", () => {
  it("merges curation meta onto each model", () => {
    const curated = applyCuration([
      { id: "gpt-5.6-sol", provider: "openai" },
      { id: "weird-lab-model", provider: "custom" },
    ]);
    expect(curated).toHaveLength(2);
    expect(curated[0]).toMatchObject({
      id: "gpt-5.6-sol",
      provider: "openai",
      tier: "advanced",
      friendlyLabel: "GPT 5.6 Sol",
    });
    expect(curated[1]?.tier).toBe("advanced");
    expect(curated[1]?.id).toBe("weird-lab-model");
  });
});
