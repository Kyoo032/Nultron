import { describe, expect, it } from "vitest";
import { hasModelVisibleContent, modelHistoryParts, thinkingTextFromParts, toolResultNote, visibleAnswerText } from "./transcript";
import type { ContentPart } from "./types";

const parts: ContentPart[] = [
  { type: "thinking", text: "I'll add them." },
  { type: "tool_call", toolKey: "calculator", status: "completed", input: { expression: "2 + 3" }, output: { result: 5 } },
  { type: "text", text: "2 + 3 = 5" },
];

describe("transcript helpers", () => {
  it("keeps the answer separate from thinking", () => {
    expect(visibleAnswerText(parts)).toBe("2 + 3 = 5");
    expect(thinkingTextFromParts(parts)).toBe("I'll add them.");
    expect(visibleAnswerText(parts)).not.toContain("I'll add them.");
  });

  it("strips thinking and tools before sending history to the model", () => {
    expect(modelHistoryParts(parts)).toEqual([{ type: "text", text: "2 + 3 = 5" }]);
    expect(hasModelVisibleContent(parts)).toBe(true);
  });
});

describe("toolResultNote", () => {
  it("names what a finished turn's tools returned, so a follow-up does not run them again", () => {
    const note = toolResultNote(parts);
    expect(note).toContain("calculator");
    expect(note).toContain('"result":5');
  });

  it("is empty when no tool finished, and is clipped", () => {
    expect(toolResultNote([{ type: "text", text: "hi" }])).toBe("");
    const big: ContentPart[] = [{ type: "tool_call", toolKey: "t", status: "completed", output: "x".repeat(5000) }];
    expect(toolResultNote(big, 200).length).toBeLessThanOrEqual(200);
  });
});
