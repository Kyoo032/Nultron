import { beforeEach, describe, expect, it } from "vitest";
import { BoardError, parseBoardSnapshot, type CardDetail } from "./board-client";
import { changeOf, draftOf, rebaseDraft } from "./board-draft";
import { boardErrorMessage, cardsByColumn, columnLabel, dropPlacement, personLabel } from "./board-view";
import { applyLocale, resetLocaleForTests } from "./i18n";

const base: CardDetail = {
  id: "c1",
  columnId: "todo-col",
  position: "V",
  title: "Plan",
  description: "first",
  assignee: null,
  dueAt: null,
  version: 3,
  createdBy: "u1",
  createdAt: 1,
  updatedAt: 1,
  commentCount: 0,
};

beforeEach(() => {
  resetLocaleForTests();
  applyLocale("en");
});

describe("card drafts", () => {
  it("sends only what the person changed, with the version they read", () => {
    expect(changeOf(base, draftOf(base))).toBeNull();
    expect(changeOf(base, { ...draftOf(base), title: "  Plan v2 " })).toEqual({ version: 3, title: "Plan v2" });
    expect(changeOf(base, { ...draftOf(base), assignee: "u2", columnId: "doing-col" })).toEqual({
      version: 3,
      assignee: { kind: "person", userId: "u2" },
      columnId: "doing-col",
      beforeId: null,
    });
  });

  it("keeps the person's edits and takes everyone else's on a newer card", () => {
    const mine = { ...draftOf(base), description: "my edit" };
    const theirs: CardDetail = { ...base, title: "Their title", version: 4 };
    const rebased = rebaseDraft(mine, base, theirs);
    expect(rebased).toEqual({ title: "Their title", description: "my edit", assignee: "", columnId: "todo-col" });
    // The save after a conflict carries the new version and only the person's own field.
    expect(changeOf(theirs, rebased)).toEqual({ version: 4, description: "my edit" });
  });
});

describe("board view helpers", () => {
  it("names built-in columns in the desk's language and custom ones by their name", () => {
    expect(columnLabel({ id: "a", kind: "todo", name: null, position: 0 })).toBe("To do");
    expect(columnLabel({ id: "b", kind: "custom", name: "QA", position: 1 })).toBe("QA");
    applyLocale("id");
    expect(columnLabel({ id: "a", kind: "done", name: null, position: 4 })).toBe("Selesai");
  });

  it("orders cards by their position key in code-point order", () => {
    const card = (id: string, position: string) => ({ ...base, id, position, columnId: "col" });
    const grouped = cardsByColumn(
      [{ id: "col", kind: "todo", name: null, position: 0 }],
      [card("lower-z", "z"), card("upper-Z", "Z"), card("digit", "9"), card("mid", "V0")],
    );
    expect(grouped.get("col")?.map((c) => c.id)).toEqual(["digit", "mid", "upper-Z", "lower-z"]);
  });

  it("marks the viewer and names a person who left", () => {
    const people = [{ userId: "u1", name: "Alice" }];
    expect(personLabel(people, "u1", "u1")).toBe("Alice (you)");
    expect(personLabel(people, "u1", "u2")).toBe("Alice");
    expect(personLabel(people, "gone", "u1")).toBe("Someone who left");
  });

  it("shows the desk's sentence for a known refusal and a generic one otherwise", () => {
    expect(boardErrorMessage(new BoardError("admin_only", "x", 403))).toBe(
      "Only an owner or admin can change the columns.",
    );
    expect(boardErrorMessage(new BoardError("weird", "x", 500))).toBe("The board could not be updated. Try again.");
    expect(boardErrorMessage(new Error("boom"))).toBe("The board could not be updated. Try again.");
  });

  it("words a conflict on a drag without talking about boxes the person never typed in", () => {
    const conflict = new BoardError("card_conflict", "x", 409);
    expect(boardErrorMessage(conflict, "move")).toMatch(/^Someone changed this card just before you moved it\./);
    expect(boardErrorMessage(conflict)).toMatch(/your edits are still in the boxes/);
    expect(boardErrorMessage(new BoardError("card_not_found", "x", 404), "move")).toBe(
      "This card is gone. Someone may have archived it.",
    );
  });

  it("drops a card above the target, at the end of an empty spot, and ignores a drop on itself", () => {
    expect(dropPlacement("a", "col", "b")).toEqual({ columnId: "col", beforeId: "b" });
    expect(dropPlacement("a", "col", null)).toEqual({ columnId: "col", beforeId: null });
    expect(dropPlacement("a", "col", "a")).toBeNull();
  });
});

describe("parseBoardSnapshot", () => {
  it("refuses an answer that is not a board", () => {
    expect(() => parseBoardSnapshot({ columns: "nope" })).toThrow(BoardError);
    expect(() => parseBoardSnapshot(null)).toThrow(BoardError);
  });

  it("reads a board the host sends", () => {
    const snapshot = parseBoardSnapshot({
      workspaceId: "w",
      cursor: 5,
      columns: [{ id: "c", kind: "todo", name: null, position: 0 }],
      cards: [{ ...base, columnId: "c" }],
      people: [{ userId: "u1", name: "Alice" }],
      me: { userId: "u1", canAdminister: true },
    });
    expect(snapshot.cursor).toBe(5);
    expect(snapshot.cards[0]?.title).toBe("Plan");
    expect(snapshot.me.canAdminister).toBe(true);
  });
});
