import { describe, expect, it } from "vitest";
import { DEFAULT_CHAT_TOOLS } from "../agents/default-chat";
import { PRODUCT_MODE_IDS, type ProductMode } from "../agents/product-modes";
import { MARKET_HARNESS } from "../market/harness";
import { EDIT_TOOLS } from "../tools/edit/tools";
import { DEFAULT_MAX_STEPS, DEFAULT_MAX_TOOL_CALLS } from "./defaults";
import { MODE_HARNESSES } from "./mode-skills";
import { MODE_HARNESS_SPECS, harnessSpecFor } from "./specs";
import type { HarnessLoop } from "./spec";

const LOOPS: Record<ProductMode, HarnessLoop> = {
  chat: "agent",
  documents: "pipeline",
  research: "pipeline",
  finance: "pipeline",
  data: "agent",
  market: "pipeline",
  legal: "pipeline",
  meeting: "pipeline",
  images: "media",
  videos: "media",
  music: "media",
  edit: "agent",
  presentations: "pipeline",
  education: "none",
};

const REPAIR_ROUNDS: Record<ProductMode, number> = {
  chat: 0,
  documents: 1,
  research: 1,
  finance: 1,
  data: 1,
  market: 1,
  legal: 3,
  meeting: 1,
  images: 0,
  videos: 0,
  music: 0,
  edit: 0,
  presentations: 1,
  education: 1,
};

describe("mode harness specs", () => {
  it("declares one spec per product mode, keyed by its own id", () => {
    expect(Object.keys(MODE_HARNESS_SPECS)).toEqual(PRODUCT_MODE_IDS);
    for (const mode of PRODUCT_MODE_IDS) {
      expect(MODE_HARNESS_SPECS[mode].mode).toBe(mode);
      expect(harnessSpecFor(mode)).toBe(MODE_HARNESS_SPECS[mode]);
    }
  });

  it("keeps Knowledge out of the specs, because it is a page and not a product mode", () => {
    expect(Object.keys(MODE_HARNESS_SPECS)).not.toContain("knowledge");
  });

  it("records how each mode drives the model today", () => {
    const loops = Object.fromEntries(PRODUCT_MODE_IDS.map((mode) => [mode, MODE_HARNESS_SPECS[mode].loop]));
    expect(loops).toEqual(LOOPS);
  });

  it("records the check-and-repair rounds each mode has today", () => {
    const rounds = Object.fromEntries(PRODUCT_MODE_IDS.map((mode) => [mode, MODE_HARNESS_SPECS[mode].repairRounds]));
    expect(rounds).toEqual(REPAIR_ROUNDS);
  });

  it("gives Chat twelve steps, every other mode six, and each a positive integer tool-call ceiling", () => {
    expect(DEFAULT_MAX_STEPS).toBe(6);
    expect(DEFAULT_MAX_TOOL_CALLS).toBe(60);
    expect(MODE_HARNESS_SPECS.chat.budget).toMatchObject({ maxSteps: 12, maxToolCalls: 40 });
    for (const mode of PRODUCT_MODE_IDS) {
      const { budget } = MODE_HARNESS_SPECS[mode];
      expect(budget.maxSteps, mode).toBe(mode === "chat" ? 12 : 6);
      expect(Number.isInteger(budget.maxToolCalls) && budget.maxToolCalls > 0, mode).toBe(true);
    }
  });

  it("keeps every per-tool cap a positive integer for a tool the mode may bind, under the total", () => {
    for (const mode of PRODUCT_MODE_IDS) {
      const spec = MODE_HARNESS_SPECS[mode];
      for (const [tool, cap] of Object.entries(spec.budget.perTool ?? {})) {
        expect(spec.tools, `${mode} ${tool}`).toContain(tool);
        expect(Number.isInteger(cap) && cap > 0 && cap <= spec.budget.maxToolCalls, `${mode} ${tool}`).toBe(true);
      }
    }
    expect(MODE_HARNESS_SPECS.data.budget.perTool).toEqual({ run_sql: 8, run_code: 4 });
    expect(MODE_HARNESS_SPECS.chat.budget.perTool).toEqual({
      write_file: 20,
      edit_file: 20,
      delete_file: 10,
      web_fetch: 8,
      run_code: 6,
      self_check: 4,
      build_deck: 4,
      query_data_source: 8,
    });
  });

  it("names tools as non-empty, unique strings", () => {
    for (const mode of PRODUCT_MODE_IDS) {
      const { tools } = MODE_HARNESS_SPECS[mode];
      for (const key of tools) {
        expect(typeof key === "string" && key.trim() === key && key.length > 0, `${mode} "${key}"`).toBe(true);
      }
      expect(new Set(tools).size, mode).toBe(tools.length);
    }
  });

  it("lets only Chat, Data, Market and Edit bind tools", () => {
    const withTools = PRODUCT_MODE_IDS.filter((mode) => MODE_HARNESS_SPECS[mode].tools.length > 0);
    expect(withTools).toEqual(["chat", "data", "market", "edit"]);
  });

  it("gives Chat the default chat tools: knowledge, fetch and the six file tools included", () => {
    expect(MODE_HARNESS_SPECS.chat.tools).toEqual([...DEFAULT_CHAT_TOOLS]);
    expect(MODE_HARNESS_SPECS.chat.tools).toEqual([
      "calculator",
      "datetime",
      "web_search",
      "image_generate",
      "video_generate",
      "past_sessions",
      "web_fetch",
      "knowledge_search",
      "list_files",
      "read_file",
      "write_file",
      "edit_file",
      "search_files",
      "delete_file",
      "run_code",
      "self_check",
      "build_deck",
      "query_data_source",
    ]);
  });

  it("gives Data the SQL tool, the calculator and the code sandbox", () => {
    expect(MODE_HARNESS_SPECS.data.tools).toEqual(["run_sql", "calculator", "run_code"]);
  });

  it("gives Edit every edit tool and nothing else", () => {
    expect(MODE_HARNESS_SPECS.edit.tools).toEqual(EDIT_TOOLS.map((tool) => tool.key));
    expect(MODE_HARNESS_SPECS.edit.tools).toContain("split_clip");
    expect(MODE_HARNESS_SPECS.edit.tools).toContain("export");
  });

  it("lets Market bind every tool any of its desks binds", () => {
    const marketBinding = (key: string) => (key === "calculator" ? key : `market_${key}`);
    for (const harness of Object.values(MARKET_HARNESS)) {
      for (const key of harness.tools) {
        expect(MODE_HARNESS_SPECS.market.tools, `${harness.specialist} ${key}`).toContain(marketBinding(key));
      }
    }
    expect(MODE_HARNESS_SPECS.market.tools).toEqual([
      "market_quotes",
      "market_history",
      "market_technical",
      "market_macro",
      "market_news",
      "calculator",
      "web_search",
      "web_fetch",
    ]);
  });

  it("carries five uniquely named skills per mode, and the catalog reads them from the specs", () => {
    for (const mode of PRODUCT_MODE_IDS) {
      const { skills } = MODE_HARNESS_SPECS[mode];
      expect(skills, mode).toHaveLength(5);
      expect(new Set(skills.map((skill) => skill.id)).size, mode).toBe(5);
      expect(MODE_HARNESSES.find((harness) => harness.id === mode)?.skills, mode).toBe(skills);
    }
  });

  it("keeps each catalog route equal to the mode's href", () => {
    expect(MODE_HARNESSES.map((harness) => harness.route)).toEqual([
      "/chat",
      "/documents",
      "/research",
      "/finance",
      "/data",
      "/market",
      "/legal",
      "/meeting",
      "/images",
      "/videos",
      "/music",
      "/edit",
      "/presentations",
      "/education",
      "/knowledge",
    ]);
  });
});
