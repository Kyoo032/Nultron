import { describe, expect, it } from "vitest";
import { readRetryTurn, turnIsStored } from "./chat-retry";

const turn = [{ type: "text", text: "hello" }];
const earlier = [{ type: "text", text: "earlier" }];
const answer = [{ type: "text", text: "an answer" }];

describe("readRetryTurn", () => {
  it("is true only for a body that says retry: true", () => {
    expect(readRetryTurn({ content: "hello", retry: true })).toBe(true);
    expect(readRetryTurn({ content: "hello" })).toBe(false);
    expect(readRetryTurn({ content: "hello", retry: false })).toBe(false);
    expect(readRetryTurn({ content: "hello", retry: "true" })).toBe(false);
    expect(readRetryTurn(null)).toBe(false);
    expect(readRetryTurn("retry")).toBe(false);
  });
});

describe("turnIsStored", () => {
  it("is true when the newest stored message is this same user turn", () => {
    const rows = [
      { role: "user", content: earlier },
      { role: "assistant", content: answer },
      { role: "user", content: turn },
    ];
    expect(turnIsStored(rows, turn)).toBe(true);
  });

  it("is false when the newest message is an answer, so a turn after a partial reply is sent again", () => {
    const rows = [
      { role: "user", content: turn },
      { role: "assistant", content: answer },
    ];
    expect(turnIsStored(rows, turn)).toBe(false);
  });

  it("is false when the newest user message says something else", () => {
    const rows = [{ role: "user", content: earlier }];
    expect(turnIsStored(rows, turn)).toBe(false);
  });

  it("is false for an empty thread", () => {
    expect(turnIsStored([], turn)).toBe(false);
  });
});
