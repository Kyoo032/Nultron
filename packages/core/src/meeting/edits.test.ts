/**
 * Meeting mode: the owner's own changes to a decision or an action item, and what a regenerate keeps of them.
 */
import { describe, expect, it } from "vitest";
import {
  applyMinutesItemEdit,
  keepEditedItems,
  minutesItemEditSchema,
  MinutesEditError,
  userEditedText,
} from "./edits";
import { meetingMinutesSchema, type MeetingMinutes } from "./minutes";

const DECISION_QUOTE = "we ship the checkout fix on Friday 14 March";
const ACTION_QUOTE = "I will write the design document before Friday";

function sheet(overrides: Record<string, unknown> = {}): MeetingMinutes {
  return meetingMinutesSchema.parse({
    title: "Checkout weekly",
    summary: "The team ships the fix.",
    decisions: [
      { statement: "Ship the fix", provisional: false, context: "", quote: DECISION_QUOTE, evidence: "verified" },
    ],
    actionItems: [
      {
        task: "Write the design",
        owner: "Sam",
        due: "Friday",
        firstStep: "",
        quote: ACTION_QUOTE,
        evidence: "verified",
      },
    ],
    ...overrides,
  });
}

describe("minutesItemEditSchema", () => {
  it("takes a decision edit and an action edit, trimmed", () => {
    expect(minutesItemEditSchema.parse({ kind: "decision", index: 0, set: { statement: "  Ship it  " } })).toEqual({
      kind: "decision",
      index: 0,
      set: { statement: "Ship it" },
    });
    expect(minutesItemEditSchema.parse({ kind: "action", index: 1, set: { owner: " Rina ", due: "" } })).toEqual({
      kind: "action",
      index: 1,
      set: { owner: "Rina", due: "" },
    });
  });

  it("refuses an empty edit, a field the item does not have, the quote and the marks", () => {
    for (const bad of [
      { kind: "decision", index: 0, set: {} },
      { kind: "decision", index: 0, set: { owner: "Rina" } },
      { kind: "decision", index: 0, set: { quote: "made up words here" } },
      { kind: "action", index: 0, set: { evidence: "verified" } },
      { kind: "action", index: 0, set: { edited: false } },
      { kind: "action", index: -1, set: { task: "x" } },
      { kind: "action", index: 0, set: { task: "" } },
      { kind: "action", index: 0, set: { owner: "   " } },
      { kind: "risk", index: 0, set: { task: "x" } },
      { kind: "action", index: 0, set: { task: "x".repeat(2001) } },
    ]) {
      expect(minutesItemEditSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("applyMinutesItemEdit", () => {
  it("changes the fields given, marks the item edited, and keeps its quote and evidence", () => {
    const next = applyMinutesItemEdit(sheet(), { kind: "action", index: 0, set: { owner: "Rina", due: "21 April" } });
    expect(next.actionItems[0]).toEqual({
      task: "Write the design",
      owner: "Rina",
      due: "21 April",
      firstStep: "",
      quote: ACTION_QUOTE,
      evidence: "verified",
      edited: true,
    });
    expect(next.decisions[0]?.edited).toBeUndefined();
  });

  it("edits a decision, including its provisional mark", () => {
    const next = applyMinutesItemEdit(sheet(), {
      kind: "decision",
      index: 0,
      set: { statement: "Ship the fix on the 21st", provisional: true },
    });
    expect(next.decisions[0]).toMatchObject({ statement: "Ship the fix on the 21st", provisional: true, edited: true });
  });

  it("does not touch the sheet it was given", () => {
    const minutes = sheet();
    const next = applyMinutesItemEdit(minutes, { kind: "decision", index: 0, set: { context: "Depends on QA" } });
    expect(next).not.toBe(minutes);
    expect(minutes.decisions[0]?.context).toBe("");
    expect(minutes.decisions[0]?.edited).toBeUndefined();
  });

  it("refuses an item that is not there", () => {
    expect(() => applyMinutesItemEdit(sheet(), { kind: "action", index: 3, set: { task: "x" } })).toThrow(
      MinutesEditError,
    );
    expect(() => applyMinutesItemEdit(sheet(), { kind: "decision", index: 1, set: { context: "x" } })).toThrow(
      MinutesEditError,
    );
  });
});

describe("keepEditedItems", () => {
  const edited = () =>
    applyMinutesItemEdit(sheet(), { kind: "action", index: 0, set: { owner: "Rina", firstStep: "Open the doc" } });

  it("puts the owner's edited item over the regenerated one that quotes the same words", () => {
    const regenerated = sheet({
      actionItems: [
        {
          task: "Draft the design doc",
          owner: "Sam",
          due: "Friday",
          firstStep: "",
          quote: ACTION_QUOTE,
          evidence: "verified",
        },
      ],
    });
    const merged = keepEditedItems(edited(), regenerated);
    expect(merged.actionItems).toHaveLength(1);
    expect(merged.actionItems[0]).toMatchObject({
      task: "Write the design",
      owner: "Rina",
      firstStep: "Open the doc",
      edited: true,
    });
  });

  it("matches a quote the regenerate cut shorter or longer, and ignores case and spacing", () => {
    const regenerated = sheet({
      actionItems: [
        {
          task: "Draft it",
          owner: "Sam",
          due: "",
          firstStep: "",
          quote: "SAM: I will write the  design document before Friday, ok",
          evidence: "verified",
        },
      ],
    });
    expect(keepEditedItems(edited(), regenerated).actionItems).toHaveLength(1);
    expect(keepEditedItems(edited(), regenerated).actionItems[0]?.edited).toBe(true);
  });

  it("keeps the rest of the regenerated sheet exactly as it came", () => {
    const regenerated = sheet({ title: "Regenerated", summary: "A new summary." });
    const merged = keepEditedItems(edited(), regenerated);
    expect(merged.title).toBe("Regenerated");
    expect(merged.summary).toBe("A new summary.");
    expect(merged.decisions).toEqual(regenerated.decisions);
  });

  it("appends an edited item the regenerate no longer has, rather than losing the edit", () => {
    const regenerated = sheet({ actionItems: [] });
    const merged = keepEditedItems(edited(), regenerated);
    expect(merged.actionItems).toHaveLength(1);
    expect(merged.actionItems[0]).toMatchObject({ owner: "Rina", edited: true });
  });

  it("does not let one regenerated item stand in for two edits", () => {
    const previous = applyMinutesItemEdit(
      sheet({
        actionItems: [
          { task: "A", owner: "Sam", due: "", firstStep: "", quote: ACTION_QUOTE },
          { task: "B", owner: "Sam", due: "", firstStep: "", quote: ACTION_QUOTE },
        ],
      }),
      { kind: "action", index: 0, set: { owner: "Rina" } },
    );
    const both = applyMinutesItemEdit(previous, { kind: "action", index: 1, set: { owner: "Dewi" } });
    const merged = keepEditedItems(both, sheet());
    expect(merged.actionItems.map((item) => item.owner).sort()).toEqual(["Dewi", "Rina"]);
  });

  it("changes nothing when nothing was edited, or when there is no earlier sheet", () => {
    const regenerated = sheet();
    expect(keepEditedItems(sheet(), regenerated)).toEqual(regenerated);
    expect(keepEditedItems(null, regenerated)).toEqual(regenerated);
  });

  it("never matches items that have no quote", () => {
    const previous = applyMinutesItemEdit(
      sheet({ decisions: [{ statement: "Ship it", provisional: false, context: "", quote: "" }] }),
      { kind: "decision", index: 0, set: { statement: "Ship it Monday" } },
    );
    const regenerated = sheet({ decisions: [{ statement: "Ship it", provisional: false, context: "", quote: "" }] });
    expect(keepEditedItems(previous, regenerated).decisions.map((item) => item.statement)).toEqual([
      "Ship it",
      "Ship it Monday",
    ]);
  });
});

describe("userEditedText", () => {
  it("gathers the words of the edited items only", () => {
    const minutes = applyMinutesItemEdit(sheet(), {
      kind: "action",
      index: 0,
      set: { owner: "Zed", due: "1 January" },
    });
    const text = userEditedText(minutes);
    expect(text).toContain("Zed");
    expect(text).toContain("1 January");
    expect(text).not.toContain("Ship the fix");
    expect(userEditedText(sheet())).toBe("");
  });
});
