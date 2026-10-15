import { describe, expect, it } from "vitest";
import en from "../locales/en/docpage.json";
import id from "../locales/id/docpage.json";

function keysOf(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    keysOf(child, prefix ? `${prefix}.${key}` : key),
  );
}

function leaves(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.values(value as Record<string, unknown>).flatMap(leaves);
}

function valueAt(tree: unknown, key: string): string {
  return key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], tree) as string;
}

const BRANDS = /Nultron|Toko Token|TokenKu|HYP AI|Hypey/i;

describe("docpage locale catalogs", () => {
  it("keeps en and id key trees aligned", () => {
    expect(keysOf(id).sort()).toEqual(keysOf(en).sort());
  });

  it("keeps the same placeholders in both languages", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of keysOf(en)) {
      expect(placeholders(valueAt(id, key)), key).toEqual(placeholders(valueAt(en, key)));
    }
  });

  it("has no empty string in either language", () => {
    for (const key of keysOf(en)) {
      expect(valueAt(en, key).trim(), key).not.toBe("");
      expect(valueAt(id, key).trim(), key).not.toBe("");
    }
  });

  it("names no brand, in either language", () => {
    expect(leaves(en).filter((text) => BRANDS.test(text))).toEqual([]);
    expect(leaves(id).filter((text) => BRANDS.test(text))).toEqual([]);
  });
});
