import { describe, expect, it } from "vitest";
import en from "../locales/en/board.json";
import { BoardError } from "./board-client";
import { boardErrorMessage, mayArchive } from "./board-view";

describe("mayArchive (the Archive button)", () => {
  const card = { createdBy: "alice", assignee: { kind: "person" as const, userId: "ann" } };

  it("is offered to the creator, the assignee and an owner or admin", () => {
    expect(mayArchive(card, "alice", false)).toBe(true);
    expect(mayArchive(card, "ann", false)).toBe(true);
    expect(mayArchive(card, "bob", true)).toBe(true);
  });

  it("is not offered to another member", () => {
    expect(mayArchive(card, "bob", false)).toBe(false);
    expect(mayArchive({ createdBy: "alice", assignee: null }, "ann", false)).toBe(false);
  });
});

describe("boardErrorMessage for the refusals added in the K0 review", () => {
  for (const code of ["not_allowed", "card_limit", "comment_limit", "column_limit", "position_exhausted"] as const) {
    it(`shows the desk's own sentence for ${code}`, () => {
      expect(boardErrorMessage(new BoardError(code, "host text", 409))).toBe(en.errors[code]);
    });
  }

  it("never shows the host's English text for an unknown code", () => {
    expect(boardErrorMessage(new BoardError("something_new", "host text", 400))).toBe(en.errors.generic);
  });
});
