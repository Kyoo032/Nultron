import { describe, expect, it } from "vitest";
import { DEFAULT_CHAT_TOOLS } from "../../agents/default-chat";
import { chatHarnessSpec } from "./chat";

describe("chat harness spec", () => {
  it("is an agent loop over exactly the default chat tools", () => {
    expect(chatHarnessSpec.mode).toBe("chat");
    expect(chatHarnessSpec.loop).toBe("agent");
    expect(chatHarnessSpec.tools).toEqual([...DEFAULT_CHAT_TOOLS]);
    expect(chatHarnessSpec.tools).toEqual([
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
      "build_deck",
    ]);
  });

  it("sizes the budget for read, edit and re-read loops", () => {
    expect(chatHarnessSpec.budget).toEqual({
      maxSteps: 12,
      maxToolCalls: 40,
      perTool: { write_file: 20, edit_file: 20, delete_file: 10, web_fetch: 8, run_code: 6, build_deck: 4 },
    });
  });

  it("caps only tools Chat binds, each under the run total", () => {
    for (const [tool, cap] of Object.entries(chatHarnessSpec.budget.perTool ?? {})) {
      expect(chatHarnessSpec.tools, tool).toContain(tool);
      expect(cap, tool).toBeLessThanOrEqual(chatHarnessSpec.budget.maxToolCalls);
    }
  });

  it("never asks the model again: the turn check settles the saved reply in code", () => {
    expect(chatHarnessSpec.repairRounds).toBe(0);
  });
});
