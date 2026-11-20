/**
 * The team copy (`team`) exists in both languages with identical keys and no empty strings. The
 * rail's team labels live in `rail.json` and are covered by the account-locale parity test.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

describe("team copy", () => {
  const en = load("en", "team");
  const id = load("id", "team");

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
