import { afterEach, describe, expect, it } from "vitest";
import en from "../locales/en/board.json";
import { BoardError, type BoardPerson } from "./board-client";
import { resetLocaleForTests } from "./i18n";
import { boardErrorMessage, mayArchive, personLabel } from "./board-view";

afterEach(() => {
  resetLocaleForTests();
});

describe("personLabel (the board's people, names only)", () => {
  const people: BoardPerson[] = [
    { userId: "0f1c2a3b-0000-4000-8000-00000000000a", name: "Ana Putri" },
    { userId: "0f1c2a3b-0000-4000-8000-00000000000b", name: null },
  ];
  const ana = people[0]?.userId ?? "";
  const unnamed = people[1]?.userId ?? "";

  it("shows a name as it is, and an unnamed colleague by the neutral label, never by the id", () => {
    expect(personLabel(people, ana, "someone-else")).toBe("Ana Putri");
    expect(personLabel(people, unnamed, "someone-else")).toBe("Colleague 0F1C2A");
  });

  it("marks the viewer's own row, with the same label", () => {
    expect(personLabel(people, ana, ana)).toBe("Ana Putri (you)");
    expect(personLabel(people, unnamed, unnamed)).toBe("Colleague 0F1C2A (you)");
  });
});

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
