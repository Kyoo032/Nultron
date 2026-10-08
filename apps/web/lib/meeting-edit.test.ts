/**
 * The owner's inline edit of one decision or action item.
 *
 * The page sends only what changed, because the host refuses an edit that sets nothing and the item keeps
 * every field the owner left alone. The quote and the evidence are never editable, so they are never sent.
 */
import { describe, expect, it, vi } from "vitest";
import type { MeetingActionItem, MeetingDecision } from "@agentforge/core/meeting";
import { actionEdit, decisionEdit, submitEdit } from "./meeting-edit";

const decision: MeetingDecision = {
  statement: "Ship on Friday",
  provisional: false,
  context: "After QA",
  quote: "we ship on Friday",
  evidence: "verified",
};

const action: MeetingActionItem = {
  task: "Send the budget",
  owner: "Dewi",
  due: "Friday",
  firstStep: "Open the sheet",
  quote: "Dewi will send the budget",
  evidence: "unverified",
};

describe("decisionEdit", () => {
  it("is null when nothing changed", () => {
    expect(
      decisionEdit(2, decision, { statement: "Ship on Friday", context: "After QA", provisional: false }),
    ).toBeNull();
  });

  it("sends only the fields that changed, at the item's index", () => {
    expect(
      decisionEdit(2, decision, { statement: "Ship on Monday", context: "After QA", provisional: false }),
    ).toEqual({ kind: "decision", index: 2, set: { statement: "Ship on Monday" } });
    expect(
      decisionEdit(0, decision, { statement: "Ship on Friday", context: "After QA", provisional: true }),
    ).toEqual({ kind: "decision", index: 0, set: { provisional: true } });
  });

  it("does not send a statement that was emptied: the host requires one", () => {
    expect(decisionEdit(0, decision, { statement: "   ", context: "After QA", provisional: false })).toBeNull();
  });

  it("lets the owner clear the context", () => {
    expect(decisionEdit(0, decision, { statement: "Ship on Friday", context: "", provisional: false })).toEqual({
      kind: "decision",
      index: 0,
      set: { context: "" },
    });
  });

  it("never sends the quote or the evidence", () => {
    const edit = decisionEdit(0, decision, { statement: "Changed", context: "x", provisional: true });
    expect(Object.keys(edit?.set ?? {}).sort()).toEqual(["context", "provisional", "statement"]);
  });

  it("compares trimmed words, so stray spaces are not an edit", () => {
    expect(
      decisionEdit(0, decision, { statement: "  Ship on Friday ", context: "After QA  ", provisional: false }),
    ).toBeNull();
  });
});

describe("actionEdit", () => {
  const same = { task: "Send the budget", owner: "Dewi", due: "Friday", firstStep: "Open the sheet" };

  it("is null when nothing changed", () => {
    expect(actionEdit(1, action, same)).toBeNull();
  });

  it("sends only what changed", () => {
    expect(actionEdit(1, action, { ...same, owner: "Rina", due: "Monday" })).toEqual({
      kind: "action",
      index: 1,
      set: { owner: "Rina", due: "Monday" },
    });
  });

  it("does not send an emptied task or owner: the host requires both", () => {
    expect(actionEdit(1, action, { ...same, task: "", owner: " " })).toBeNull();
  });

  it("lets the owner clear the due date and the first step", () => {
    expect(actionEdit(1, action, { ...same, due: "", firstStep: "" })).toEqual({
      kind: "action",
      index: 1,
      set: { due: "", firstStep: "" },
    });
  });
});

describe("submitEdit", () => {
  const edit = { kind: "action", index: 0, set: { owner: "Rina" } } as const;

  it("closes without a request when nothing changed", async () => {
    const save = vi.fn(async () => null);
    expect(await submitEdit(null, save)).toEqual({ done: true });
    expect(save).not.toHaveBeenCalled();
  });

  it("is done when the host took the edit", async () => {
    const save = vi.fn(async () => null);
    expect(await submitEdit(edit, save)).toEqual({ done: true });
    expect(save).toHaveBeenCalledWith(edit);
  });

  it("keeps the form open with the host's sentence when it refused", async () => {
    expect(await submitEdit(edit, async () => "That item is gone.")).toEqual({
      done: false,
      message: "That item is gone.",
    });
  });
});
