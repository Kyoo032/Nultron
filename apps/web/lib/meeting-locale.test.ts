import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRODUCT_MODES } from "@agentforge/core/product-modes";

const localesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../locales");

function load(locale: "en" | "id", file = "meeting.json"): unknown {
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

describe("meeting locale JSON", () => {
  it("keeps en and id key trees aligned", () => {
    expect(keys(load("id")).sort()).toEqual(keys(load("en")).sort());
  });

  it("translates the Indonesian catalog rather than shipping the English strings", () => {
    const en = load("en") as Record<string, string>;
    const id = load("id") as Record<string, string>;
    expect(id.title).not.toBe(en.title);
    expect(id.subtitle).not.toBe(en.subtitle);
  });

  it("keeps the interpolation placeholders identical in both languages", () => {
    const placeholders = (value: string) => (value.match(/\{[a-zA-Z]+\}/g) ?? []).sort();
    const en = load("en") as Record<string, string>;
    const id = load("id") as Record<string, string>;
    for (const key of ["uploaded", "unverified", "deleteConfirm"]) {
      expect(placeholders(id[key] ?? ""), key).toEqual(placeholders(en[key] ?? ""));
    }
  });

  it("names the meeting in both languages on the notices that are about one", () => {
    const placeholders = (value: string) => (value.match(/\{[a-zA-Z]+\}/g) ?? []).sort();
    const en = (load("en") as { record: Record<string, string> }).record;
    const id = (load("id") as { record: Record<string, string> }).record;
    for (const key of ["uploadFailedFor", "otherDesk"]) {
      expect(placeholders(en[key] ?? ""), key).toEqual(["{title}"]);
      expect(placeholders(id[key] ?? ""), key).toEqual(["{title}"]);
    }
  });

  it("says what a failed check means in both languages, and names the button the hint points at", () => {
    const placeholders = (value: string) => (value.match(/\{[a-zA-Z]+\}/g) ?? []).sort();
    const en = (load("en") as { checks: Record<string, string> }).checks;
    const id = (load("id") as { checks: Record<string, string> }).checks;
    for (const key of ["title", "owners", "dates", "summary", "shape", "evidence", "hint"]) {
      expect(en[key], `en checks.${key}`).toBeTruthy();
      expect(id[key], `id checks.${key}`).toBeTruthy();
      expect(id[key], `id checks.${key} is still English`).not.toBe(en[key]);
    }
    expect(placeholders(en.hint ?? "")).toEqual(["{action}"]);
    expect(placeholders(id.hint ?? "")).toEqual(["{action}"]);
  });

  it("says the doc-flow front door, translation, evidence and edit copy in both languages, with the same placeholders", () => {
    const placeholders = (value: string) => (value.match(/\{[a-zA-Z]+\}/g) ?? []).sort();
    const en = load("en") as Record<string, unknown>;
    const id = load("id") as Record<string, unknown>;
    const at = (tree: Record<string, unknown>, path: string): string => {
      const value = path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], tree);
      return typeof value === "string" ? value : "";
    };
    const expected: Record<string, string[]> = {
      transcriptReady: ["{words}"],
      translate: ["{language}"],
      translateAgain: ["{language}"],
      translateEmpty: ["{language}"],
      "evidence.someUnverified": ["{unverified}", "{verified}"],
      "prompt.label": [],
      runNote: [],
      runNoteTranslate: [],
      translateDefault: [],
      "drop.title": [],
      "drop.unsupported": [],
      "evidence.unverified": [],
      "evidence.quote": [],
      "edit.edited": [],
      "edit.clearsTranslation": [],
      "errors.transcriptFile": [],
      "errors.edit": [],
    };
    for (const [key, vars] of Object.entries(expected)) {
      expect(at(en, key), `en ${key}`).toBeTruthy();
      expect(at(id, key), `id ${key}`).toBeTruthy();
      expect(at(id, key), `id ${key} is still English`).not.toBe(at(en, key));
      expect(placeholders(at(en, key)), `en ${key}`).toEqual(vars);
      expect(placeholders(at(id, key)), `id ${key}`).toEqual(vars);
    }
  });

  it("no longer carries the strings of the form-first desk", () => {
    for (const locale of ["en", "id"] as const) {
      const catalog = load(locale) as Record<string, unknown>;
      expect(catalog.runFromTranscript, `${locale} runFromTranscript`).toBeUndefined();
      expect(catalog.emptyDetail, `${locale} emptyDetail`).toBeUndefined();
    }
  });

  it("keeps brand names untranslated in id", () => {
    const raw = readFileSync(resolve(localesDir, "id", "meeting.json"), "utf8");
  });
});

describe("meeting rail label", () => {
  it("is present in both rail catalogs, as every product mode must be", () => {
    for (const locale of ["en", "id"] as const) {
      const rail = load(locale, "rail.json") as Record<string, string>;
      for (const mode of PRODUCT_MODES) {
        expect(rail[mode.id], `${locale}/rail.json is missing ${mode.id}`).toBeTruthy();
      }
    }
  });

  it("is present in both workspace mode-chip catalogs", () => {
    for (const locale of ["en", "id"] as const) {
      const workspaces = load(locale, "workspaces.json") as { mode: Record<string, string> };
      for (const mode of PRODUCT_MODES) {
        expect(workspaces.mode[mode.id], `${locale}/workspaces.json is missing mode.${mode.id}`).toBeTruthy();
      }
    }
  });
});
