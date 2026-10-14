import { describe, expect, it } from "vitest";
import en from "../locales/en/board.json";
import id from "../locales/id/board.json";

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

const BRANDS = /Nultron|Toko Token|TokenKu|HYP AI|Hypey/i;

describe("board locale catalogs", () => {
  it("keeps en and id key trees aligned", () => {
    expect(keysOf(id).sort()).toEqual(keysOf(en).sort());
  });

  it("keeps the same placeholders in both languages", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of keysOf(en)) {
      const pick = (tree: unknown) =>
        key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], tree) as string;
      expect(placeholders(pick(id)), key).toEqual(placeholders(pick(en)));
    }
  });

  it("names no brand, in either language", () => {
    expect(leaves(en).filter((text) => BRANDS.test(text))).toEqual([]);
    expect(leaves(id).filter((text) => BRANDS.test(text))).toEqual([]);
  });

  it("has a sentence for every refusal the host sends", () => {
    for (const code of [
      "card_conflict",
      "card_not_found",
      "column_not_found",
      "admin_only",
      "builtin_column",
      "column_not_empty",
      "invalid_card",
      "invalid_comment",
      "invalid_column",
      "not_allowed",
      "card_limit",
      "comment_limit",
      "column_limit",
      "position_exhausted",
    ]) {
      expect(en.errors[code as keyof typeof en.errors], code).toBeTruthy();
    }
    expect(id.columns.todo).toBe("Akan dikerjakan");
  });
});
