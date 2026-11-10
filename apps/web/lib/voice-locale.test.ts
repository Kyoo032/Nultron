/**
 * The `voice` catalog: the same keys in `en` and `id`, every key the code uses present in both, and no
 * key left over that nothing uses. The code's keys are read from its own source, so a key added to a
 * component without a line in the catalog (or a line left behind by a removed one) fails here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VOICE_END_REASONS, VOICE_STATES } from "@agentforge/core/voice";
import { afterEach, describe, expect, it } from "vitest";
import { applyLocale, resetLocaleForTests, t } from "./i18n";
import { VOICE_ERROR_CODES } from "./voice-view-state";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");

function load(locale: "en" | "id"): Record<string, unknown> {
  return JSON.parse(readFileSync(join(web, "locales", locale, "voice.json"), "utf8")) as Record<string, unknown>;
}

function flatten(value: unknown, prefix = ""): Record<string, string> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>(
      (all, [key, child]) => Object.assign(all, flatten(child, prefix ? `${prefix}.${key}` : key)),
      {},
    );
  }
  return typeof value === "string" ? { [prefix]: value } : {};
}

const en = flatten(load("en"));
const id = flatten(load("id"));

/** The files that draw the voice view, as source: components under `components/voice` and `lib/voice-*`. */
function voiceSources(): Array<{ file: string; text: string }> {
  const dirs = [join(web, "components", "voice"), join(web, "lib")];
  const files: string[] = [];
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      const isVoice = dir.endsWith("voice") || name.startsWith("voice-");
      if (isVoice && /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
        files.push(join(dir, name));
      }
    }
  }
  return files.map((file) => ({ file, text: readFileSync(file, "utf8") }));
}

/** Keys written out whole, and the prefixes of keys built from a value (`voice.state.${...}`). */
function usedKeys(): { literal: Set<string>; prefixes: Set<string> } {
  const literal = new Set<string>();
  const prefixes = new Set<string>();
  for (const { text } of voiceSources()) {
    for (const match of text.matchAll(/["'`]voice\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)["'`]/g)) {
      literal.add(match[1] as string);
    }
    for (const match of text.matchAll(/`voice\.([A-Za-z0-9_.]*)\$\{/g)) {
      prefixes.add(match[1] as string);
    }
  }
  return { literal, prefixes };
}

/** What each built key can be: the values the code builds it from. */
const FAMILIES: Record<string, readonly string[]> = {
  "state.": VOICE_STATES,
  "ended.": VOICE_END_REASONS,
  "error.": VOICE_ERROR_CODES,
};

function expandedKeys(): Set<string> {
  const { literal, prefixes } = usedKeys();
  const all = new Set(literal);
  for (const prefix of prefixes) {
    const family = FAMILIES[prefix];
    expect(family, `the code builds a key from voice.${prefix}\${...}, which this test does not know`).toBeDefined();
    for (const value of family ?? []) {
      all.add(`${prefix}${value}`);
    }
  }
  return all;
}

const placeholders = (value: string) => (value.match(/\{[A-Za-z]+\}/g) ?? []).sort();

afterEach(() => resetLocaleForTests());

describe("the voice catalog", () => {
  it("has the same keys in en and id", () => {
    expect(Object.keys(id).sort()).toEqual(Object.keys(en).sort());
  });

  it("has a non-empty line for every key, in both", () => {
    for (const [key, value] of [...Object.entries(en), ...Object.entries(id)]) {
      expect(value.trim(), key).not.toBe("");
    }
  });

  it("keeps the same placeholders in both languages", () => {
    for (const key of Object.keys(en)) {
      expect(placeholders(id[key] ?? ""), key).toEqual(placeholders(en[key] ?? ""));
    }
  });

  it("every key the code uses exists in both languages", () => {
    const missing: string[] = [];
    for (const key of expandedKeys()) {
      if (!(key in en)) {
        missing.push(`en: ${key}`);
      }
      if (!(key in id)) {
        missing.push(`id: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("has no key that nothing uses", () => {
    const used = expandedKeys();
    expect(Object.keys(en).filter((key) => !used.has(key))).toEqual([]);
  });

  it("has an ended line for every end reason, a state word for every state, and an error for every failure", () => {
    for (const reason of VOICE_END_REASONS) {
      expect(en[`ended.${reason}`], reason).toBeTruthy();
    }
    for (const value of VOICE_STATES) {
      expect(en[`state.${value}`], value).toBeTruthy();
    }
    for (const code of VOICE_ERROR_CODES) {
      expect(en[`error.${code}`], code).toBeTruthy();
    }
  });

  it("translates the Indonesian lines, except the assistant's own name", () => {
    const same = Object.keys(en).filter((key) => en[key] === id[key] && key !== "view.assistant");
    expect(same).toEqual([]);
  });

  it("names the gateway through its placeholder and never types a gateway's name", () => {
    expect(en["error.gateway_blocked"]).toContain("{gatewayName}");
    expect(id["error.gateway_blocked"]).toContain("{gatewayName}");
    for (const value of [...Object.values(en), ...Object.values(id)]) {
      expect(value).not.toContain("Toko Token");
    }
  });

  it("takes the state word as a placeholder in the live announcement", () => {
    expect(placeholders(en["a11y.stateLive"] ?? "")).toEqual(["{state}"]);
    expect(placeholders(id["a11y.stateLive"] ?? "")).toEqual(["{state}"]);
  });

  it("is registered, so the translator finds it in each language", () => {
    applyLocale("en");
    expect(t("voice.mic.start")).toBe(en["mic.start"]);
    applyLocale("id");
    expect(t("voice.mic.start")).toBe(id["mic.start"]);
    expect(t("voice.state.speaking")).toBe(id["state.speaking"]);
  });
});
