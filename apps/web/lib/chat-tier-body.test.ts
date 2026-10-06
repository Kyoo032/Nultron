import { afterEach, describe, expect, it } from "vitest";
import { MODEL_TIERS } from "@agentforge/core/tiers";
import { applyLocale, resetLocaleForTests } from "./i18n";
import { buildChatRunBody, tierErrorMessage } from "./chat-tier-body";

afterEach(() => resetLocaleForTests());

describe("buildChatRunBody", () => {
  it("is the content and the tier, and nothing else", () => {
    const body = buildChatRunBody("hello", "reasoning");
    expect(body).toEqual({ content: "hello", tier: "reasoning" });
    expect(Object.keys(body).sort()).toEqual(["content", "tier"]);
  });

  it("never carries a model, a thinking flag or a reasoning level", () => {
    for (const tier of MODEL_TIERS) {
      const json = JSON.parse(JSON.stringify(buildChatRunBody("hi", tier))) as Record<string, unknown>;
      expect(json).not.toHaveProperty("model");
      expect(json).not.toHaveProperty("thinking");
      expect(json).not.toHaveProperty("reasoningEffort");
      expect(json.tier).toBe(tier);
    }
  });

  it("carries a parts array untouched, for an image or a clip", () => {
    const parts = [
      { type: "text", text: "What is in this image?" },
      { type: "image_url", image_url: { url: "/media/a.png", detail: "high" } },
    ];
    const body = buildChatRunBody(parts, "fast");
    expect(body.content).toBe(parts);
    expect(Object.keys(body).sort()).toEqual(["content", "tier"]);
  });

  it("is a new object each time, so a caller cannot change what another sent", () => {
    const first = buildChatRunBody("a", "daily");
    const second = buildChatRunBody("a", "daily");
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
  });
});

describe("tierErrorMessage", () => {
  it("says tier_unavailable in the catalog's words, in the desk's language", () => {
    const body = { error: { code: "tier_unavailable", message: "no candidate: gpt-6-luna, claude-opus-5-5" } };
    expect(tierErrorMessage(body)).toBe("That choice is not available right now. Pick another one and send again.");
    applyLocale("id");
    expect(tierErrorMessage(body)).toBe("Pilihan itu sedang tidak tersedia. Pilih yang lain lalu kirim lagi.");
  });

  it("never lets the host's sentence, which can name a model, reach the screen for a tier error", () => {
    const text = tierErrorMessage({ error: { code: "tier_unavailable", message: "claude-opus-5-5 is down" } });
    expect(text).not.toContain("claude-opus-5-5");
  });

  it("answers nothing for any other error, so the caller keeps the path it already had", () => {
    expect(tierErrorMessage({ error: { code: "gateway_blocked", message: "x" } })).toBeNull();
    expect(tierErrorMessage({ error: { code: "unknown_tier", message: "x" } })).toBeNull();
    expect(tierErrorMessage({ error: { message: "plain" } })).toBeNull();
    expect(tierErrorMessage({ error: "oops" })).toBeNull();
    expect(tierErrorMessage({})).toBeNull();
    expect(tierErrorMessage(null)).toBeNull();
    expect(tierErrorMessage(undefined)).toBeNull();
    expect(tierErrorMessage("tier_unavailable")).toBeNull();
  });
});
