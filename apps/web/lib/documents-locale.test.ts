import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const localesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../locales");

function load(locale: "en" | "id"): unknown {
  return JSON.parse(readFileSync(resolve(localesDir, locale, "documents.json"), "utf8"));
}

function keys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    keys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("documents locale JSON", () => {
  it("keeps en and id key trees aligned", () => {
    expect(keys(load("id")).sort()).toEqual(keys(load("en")).sort());
  });

  it("keeps the checks strings, with the same placeholders in both languages", () => {
    const en = load("en") as { checks: Record<string, string> };
    const id = load("id") as { checks: Record<string, string> };
    const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const group of ["checks"] as const) {
      expect(Object.keys(en[group]).length, group).toBeGreaterThan(0);
      for (const [key, value] of Object.entries(en[group])) {
        expect(value.trim(), `en ${group}.${key}`).not.toBe("");
        expect(id[group][key]?.trim(), `id ${group}.${key}`).toBeTruthy();
        expect(placeholders(id[group][key] ?? ""), `${group}.${key}`).toEqual(placeholders(value));
      }
    }
    expect(placeholders(en.checks.groundingHint ?? "")).toEqual(["action"]);
    expect(placeholders(en.checks.grounding ?? "")).toEqual(["count"]);
  });

  it("keeps brand names untranslated in id", () => {
    const raw = readFileSync(resolve(localesDir, "id", "documents.json"), "utf8");
    expect(raw).toMatch(/Toko Token/);
    expect(raw).not.toMatch(/TokenKu/);
  });
});
