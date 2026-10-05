import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const localesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../locales");

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

function leaves(value: unknown, prefix = ""): Array<[string, string]> {
  if (typeof value === "string") {
    return [[prefix, value]];
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leaves(child, prefix ? `${prefix}.${key}` : key),
  );
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe("folder locale JSON", () => {
  it("keeps en and id key trees aligned", () => {
    expect(keys(load("id", "folder.json")).sort()).toEqual(keys(load("en", "folder.json")).sort());
  });

  it("is not empty: the namespace was registered before it had any copy", () => {
    expect(keys(load("en", "folder.json")).length).toBeGreaterThan(30);
  });

  it("fills every string, in both languages", () => {
    for (const locale of ["en", "id"] as const) {
      for (const [key, text] of leaves(load(locale, "folder.json"))) {
        expect(text.trim().length, `${locale} folder.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("uses the same {placeholders} in both languages for every string", () => {
    const en = new Map(leaves(load("en", "folder.json")));
    for (const [key, text] of leaves(load("id", "folder.json"))) {
      expect(placeholders(text), `folder.${key}`).toEqual(placeholders(en.get(key) ?? ""));
    }
  });

  it("carries a sentence for each error code the host can send for the folder calls", () => {
    for (const locale of ["en", "id"] as const) {
      const folder = load(locale, "folder.json") as { error?: Record<string, unknown> };
      for (const code of ["folder_mount_refused", "folder_mount_ipc_only", "folder_unavailable"]) {
        expect(typeof folder.error?.[code], `${locale} folder.error.${code}`).toBe("string");
      }
    }
  });

  it("carries a sentence for each way an approval can end", () => {
    for (const locale of ["en", "id"] as const) {
      const folder = load(locale, "folder.json") as { outcome?: Record<string, unknown> };
      for (const name of ["applied", "appliedDelete", "stale", "failedDenied", "failedIo", "rejected", "gone"]) {
        expect(typeof folder.outcome?.[name], `${locale} folder.outcome.${name}`).toBe("string");
      }
    }
  });

  it("names a file only in the accessible names of the row buttons", () => {
    const folder = load("en", "folder.json");
    const withPath = leaves(folder)
      .filter(([, text]) => text.includes("{path}"))
      .map(([key]) => key)
      .sort();
    expect(withPath).toEqual(["proposals.approveNamed", "proposals.dismissNamed", "proposals.rejectNamed"]);
  });
});
