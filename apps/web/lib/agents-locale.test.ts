/**
 * The virtual agents copy (`agents`) and the harness copy (`harness`) exist in both languages with
 * identical keys, and every agent in the core registry has a tagline: `t()` builds that key at run
 * time (`agents.tagline.${id}`), so the literal-key scan cannot see it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRODUCT_MODE_IDS } from "@agentforge/core/product-modes";

const locales = join(dirname(fileURLToPath(import.meta.url)), "..", "locales");

type Node = Record<string, unknown>;

function load(locale: "en" | "id", namespace: string): Node {
  return JSON.parse(readFileSync(join(locales, locale, `${namespace}.json`), "utf8")) as Node;
}

function leaves(node: Node, prefix = ""): string[] {
  return Object.entries(node).flatMap(([key, value]) =>
    value && typeof value === "object" ? leaves(value as Node, `${prefix}${key}.`) : [`${prefix}${key}`],
  );
}

describe.each(["agents", "harness"])("%s copy", (namespace) => {
  const en = load("en", namespace);
  const id = load("id", namespace);

  it("has the same keys in English and Indonesian", () => {
    expect(leaves(id).sort()).toEqual(leaves(en).sort());
  });

  it("has no empty string in either language", () => {
    for (const catalog of [en, id]) {
      for (const key of leaves(catalog)) {
        const value = key.split(".").reduce<unknown>((node, part) => (node as Node)?.[part], catalog);
        expect(typeof value === "string" && value.trim().length > 0, key).toBe(true);
      }
    }
  });
});

describe("agent taglines", () => {
  it("covers every agent in the registry, in both languages", () => {
    for (const locale of ["en", "id"] as const) {
      const tagline = load(locale, "agents").tagline as Node;
      expect(Object.keys(tagline).sort()).toEqual([...PRODUCT_MODE_IDS].sort());
    }
  });
});
