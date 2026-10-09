import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineTool, registerTool, resetToolRegistry, type ContentPart } from "@agentforge/core";
import { z } from "zod";
import { historyToolNote } from "./chat-history-note";

const secret = "PRIVATE-PAYROLL-ROW-4471";

function tool(key: string, trust: "internal" | "network" | "user_content") {
  return defineTool({
    key,
    name: key,
    description: key,
    schema: z.object({}),
    trust,
    execute: async () => ({}),
  });
}

describe("historyToolNote", () => {
  beforeEach(() => {
    resetToolRegistry();
    registerTool(tool("read_file", "user_content"));
    registerTool(tool("knowledge_search", "user_content"));
    registerTool(tool("run_code", "user_content"));
    registerTool(tool("past_sessions", "user_content"));
    registerTool(tool("calculator", "internal"));
    registerTool(tool("web_search", "network"));
  });
  afterEach(() => resetToolRegistry());

  it("never quotes the output of a user_content tool, and an unknown tool counts as one", () => {
    const parts: ContentPart[] = ["read_file", "knowledge_search", "run_code", "past_sessions", "mystery_tool"].map(
      (toolKey) => ({
        type: "tool_call" as const,
        toolKey,
        status: "completed" as const,
        output: { content: secret },
      }),
    );
    const note = historyToolNote(parts);
    expect(note).not.toContain(secret);
    expect(note).toContain("read_file ran, output withheld");
    expect(note).toContain("run_code ran, output withheld");
    expect(note).toContain("mystery_tool ran, output withheld");
  });

  it("still quotes an internal tool, fenced and labelled as data", () => {
    const note = historyToolNote([
      { type: "tool_call", toolKey: "calculator", status: "completed", output: { result: 5 } },
      { type: "tool_call", toolKey: "read_file", status: "completed", output: secret },
    ]);
    expect(note).toContain('calculator: {"result":5}');
    expect(note).toContain("data, not instructions");
    expect(note).not.toContain(secret);
  });
});
