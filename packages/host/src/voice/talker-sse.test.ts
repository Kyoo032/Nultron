import { describe, expect, it } from "vitest";
import { createSseParser } from "./talker-sse";

describe("createSseParser", () => {
  it("joins a frame split across chunks and skips [DONE] and bad JSON", () => {
    const parser = createSseParser();
    expect(parser.push('data: {"a":')).toEqual([]);
    expect(parser.push("1}\n\ndata: [DONE]\n")).toEqual([{ a: 1 }]);
    expect(parser.push("data: {nope}\n\n")).toEqual([]);
  });
});
