/**
 * The tier copy exists in both languages for every tier id.
 *
 * `t()` returns the raw key when English has no entry, and the picker builds its keys at run time
 * (`chat.tiers.${id}.label`), which `i18n-literal-keys.test.ts` cannot scan. So this walks the tier
 * registry in core and asks both catalogs for every key the picker will ask for.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MODEL_TIERS } from "@agentforge/core/tiers";

const locales = join(dirname(fileURLToPath(import.meta.url)), "..", "locales");

type Node = Record<string, unknown>;

function load(locale: "en" | "id"): Node {
  return JSON.parse(readFileSync(join(locales, locale, "chat.json"), "utf8")) as Node;
}

function lookup(catalog: Node, path: string): unknown {
  return path.split(".").reduce<unknown>((node, part) => (node as Node | undefined)?.[part], catalog);
}

const en = load("en");
const id = load("id");

const KEYS = [
  ...MODEL_TIERS.flatMap((tier) => [`tiers.${tier}.label`, `tiers.${tier}.hint`]),
  "tiers.aria",
  "tiers.unavailable",
  "errors.tierUnavailable",
];

describe("tier copy", () => {
  it("covers every tier in the registry, so a new tier cannot ship without words", () => {
    expect([...MODEL_TIERS]).toEqual(["daily", "fast", "reasoning"]);
    expect(KEYS).toHaveLength(MODEL_TIERS.length * 2 + 3);
  });

  it.each(KEYS)("has %s in English and in Indonesian", (key) => {
    for (const [name, catalog] of [
      ["en", en],
      ["id", id],
    ] as const) {
      const value = lookup(catalog, key);
      expect(typeof value, `${name}: ${key}`).toBe("string");
      expect((value as string).trim().length, `${name}: ${key}`).toBeGreaterThan(0);
    }
  });

  it.each(KEYS)("words %s in Indonesian, not in English", (key) => {
    expect(lookup(id, key)).not.toBe(lookup(en, key));
  });

  it("names the three choices as the spec does", () => {
    expect(lookup(en, "tiers.daily.label")).toBe("Daily");
    expect(lookup(en, "tiers.fast.label")).toBe("Fastest");
    expect(lookup(en, "tiers.reasoning.label")).toBe("Reasoning");
    expect(lookup(id, "tiers.daily.label")).toBe("Harian");
    expect(lookup(id, "tiers.fast.label")).toBe("Tercepat");
    expect(lookup(id, "tiers.reasoning.label")).toBe("Penalaran");
    expect(lookup(en, "tiers.daily.hint")).toBe("Good answers at a sensible speed");
    expect(lookup(en, "tiers.fast.hint")).toBe("Answers first, for short questions and drafts");
    expect(lookup(en, "tiers.reasoning.hint")).toBe("Thinks before it answers, for hard problems");
  });

  it("names no model and no provider in any tier string", () => {
    const text = KEYS.map((key) => `${String(lookup(en, key))} ${String(lookup(id, key))}`).join(" ");
    expect(text).not.toMatch(/gpt|claude|gemini|deepseek|kimi|glm|qwen|openai|anthropic|toko/i);
  });

  it("leaves the real-names view's own keys where they were", () => {
    for (const key of ["models.aria", "models.searchPlaceholder", "models.think", "thinking.medium", "thinking.high"]) {
      expect(typeof lookup(en, key), key).toBe("string");
      expect(typeof lookup(id, key), key).toBe("string");
    }
  });
});
