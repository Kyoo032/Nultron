import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { filesErrorKeys, type PathProblem } from "./files-model";

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = resolve(here, "../locales");

function load(locale: "en" | "id", file: string): unknown {
  return JSON.parse(readFileSync(resolve(localesDir, locale, file), "utf8"));
}

function keys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    keys(child, prefix ? `${prefix}.${key}` : key),
  );
}

/** Every `files.*` key written as a literal inside a `t("…")` call in the Files UI. */
function literalKeys(): string[] {
  const dir = resolve(here, "../components/files");
  const sources = readdirSync(dir)
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => readFileSync(resolve(dir, name), "utf8"));
  return [
    ...new Set(sources.flatMap((source) => [...source.matchAll(/\bt\("(files\.[A-Za-z.]+)"/g)].map((m) => m[1]))),
  ];
}

describe("files locale JSON", () => {
  it("keeps en and id key trees aligned", () => {
    expect(keys(load("id", "files.json")).sort()).toEqual(keys(load("en", "files.json")).sort());
  });

  it("is not empty and carries no empty string in either language", () => {
    for (const locale of ["en", "id"] as const) {
      const raw = load(locale, "files.json") as Record<string, unknown>;
      expect(keys(raw).length).toBeGreaterThan(40);
      const flat = JSON.stringify(raw);
      expect(flat).not.toContain('""');
    }
  });

  it("keeps the same placeholders in both languages for every string", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const walk = (en: unknown, id: unknown, path: string): void => {
      if (typeof en === "string") {
        expect(placeholders(String(id)), path).toEqual(placeholders(en));
        return;
      }
      for (const [key, child] of Object.entries(en as Record<string, unknown>)) {
        walk(child, (id as Record<string, unknown>)[key], `${path}.${key}`);
      }
    };
    walk(load("en", "files.json"), load("id", "files.json"), "files");
  });

  it("has every key the Files components name literally", () => {
    const have = new Set(keys(load("en", "files.json")).map((key) => `files.${key}`));
    const used = literalKeys();
    expect(used.length).toBeGreaterThan(30);
    for (const key of used) {
      expect(have.has(key), key).toBe(true);
    }
  });

  it("has a message for each host error code the screen maps and each path slip it catches", () => {
    const have = new Set(keys(load("en", "files.json")).map((key) => `files.${key}`));
    for (const key of filesErrorKeys()) {
      expect(have.has(key), key).toBe(true);
    }
    const problems: PathProblem[] = ["empty", "absolute", "backslash", "dots", "emptyPart", "tooLong", "tooDeep"];
    for (const problem of problems) {
      expect(have.has(`files.pathErrors.${problem}`), problem).toBe(true);
    }
    for (const reason of ["tooLarge", "binary", "readFailed"]) {
      expect(have.has(`files.upload.${reason}`), reason).toBe(true);
    }
  });

  it("is registered as a namespace, so t() reads it", () => {
    const source = readFileSync(resolve(here, "i18n.ts"), "utf8");
    expect(source).toContain('import enFiles from "../locales/en/files.json"');
    expect(source).toContain('import idFiles from "../locales/id/files.json"');
  });
});
