/**
 * The harness copy covers everything the host can send: a line for every skill of every mode spec and
 * for every tool a spec binds (Chat's set, Market's, Edit's, Data's) plus `research_dossier` and `delegate`,
 * which only a virtual agent's conversation adds. The lookups fall back to the host's own words for anything newer.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MODE_HARNESS_SPECS } from "@agentforge/core/harness";
import { applyLocale, resetLocaleForTests } from "@/lib/i18n";
import { callsLine, loopLine, repairLine, skillLabel, stepsLine, toolLabel } from "@/lib/harness-copy";

const locales = join(dirname(fileURLToPath(import.meta.url)), "..", "locales");

type Node = Record<string, unknown>;

function load(locale: "en" | "id"): Node {
  return JSON.parse(readFileSync(join(locales, locale, "harness.json"), "utf8")) as Node;
}

function at(catalog: Node, ...path: string[]): unknown {
  return path.reduce<unknown>((node, part) => (node as Node | undefined)?.[part], catalog);
}

const specs = Object.values(MODE_HARNESS_SPECS);
const toolKeys = [...new Set([...specs.flatMap((spec) => spec.tools), "research_dossier", "delegate"])];

afterEach(() => {
  resetLocaleForTests();
});

describe.each(["en", "id"] as const)("harness catalog (%s)", (locale) => {
  const catalog = load(locale);

  it("names every skill of every mode spec", () => {
    for (const spec of specs) {
      for (const skill of spec.skills) {
        const line = at(catalog, "skills", spec.mode, skill.id);
        expect(typeof line === "string" && line.length > 0, `${spec.mode}.${skill.id}`).toBe(true);
      }
    }
  });

  it("names every tool a spec binds, research_dossier and delegate", () => {
    expect(toolKeys).toContain("run_code");
    expect(toolKeys).toContain("research_dossier");
    expect(toolKeys).toContain("delegate");
    for (const key of toolKeys) {
      const line = at(catalog, "tools", key);
      expect(typeof line === "string" && line.length > 0, key).toBe(true);
    }
  });

  it("has a sentence for every loop kind", () => {
    for (const loop of ["agent", "pipeline", "media", "none"]) {
      expect(typeof at(catalog, "loop", loop)).toBe("string");
    }
  });
});

describe("skillLabel", () => {
  it("reads the catalog line in the desk's language", () => {
    applyLocale("en");
    expect(skillLabel("research", { id: "write-dossier", name: "Write the dossier" })).toBe("Write the dossier");
    applyLocale("id");
    expect(skillLabel("research", { id: "write-dossier", name: "Write the dossier" })).toBe("Menulis laporan");
  });

  it("falls back to the host's name for a skill the catalog lacks", () => {
    applyLocale("en");
    expect(skillLabel("research", { id: "brand-new-skill", name: "A brand new skill" })).toBe("A brand new skill");
  });
});

describe("toolLabel", () => {
  it("reads the catalog line, and spaces out a key it does not know", () => {
    applyLocale("en");
    expect(toolLabel("web_search")).toBe("Web search");
    expect(toolLabel("run_code")).toBe("Run code in a sandbox");
    expect(toolLabel("research_dossier")).toBe("Research dossier");
    expect(toolLabel("some_future_tool")).toBe("some future tool");
  });
});

describe("limit and check lines", () => {
  it("counts, with a singular and a plain line when nothing is repaired", () => {
    applyLocale("en");
    expect(stepsLine(6)).toBe("6 model steps a turn");
    expect(stepsLine(1)).toBe("1 model step a turn");
    expect(callsLine(60)).toBe("60 tool calls a turn");
    expect(repairLine(2)).toBe("2 repair rounds before it stops");
    expect(repairLine(1)).toBe("1 repair round before it stops");
    expect(repairLine(0)).toBe("Checks report; nothing is repaired automatically.");
  });

  it("says how each loop works", () => {
    applyLocale("en");
    expect(loopLine("agent")).toContain("decides which tools");
    expect(loopLine("pipeline")).toContain("fixed stages");
  });
});
