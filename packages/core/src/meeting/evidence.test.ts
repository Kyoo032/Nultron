/**
 * Meeting mode: a decision or an action item has to quote the transcript, and the owner and the due date
 * have to be said where the quote is. Pure judges, so no model is needed.
 */
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_WINDOW_CHARS,
  judgeMinutesEvidence,
  markMinutesEvidence,
  MINUTES_EVIDENCE_WORDS,
  minutesItemId,
} from "./evidence";
import { meetingMinutesSchema, NEEDS_OWNER, type MeetingMinutes } from "./minutes";

const TRANSCRIPT = [
  "Dewi: we ship the checkout fix on Friday 14 March, and the call is at 15:30.",
  "Budi: I will update the runbook before 3 pm and send it to Sari.",
  "Dewi: good, nobody owns the vendor contract yet, so we leave that open.",
].join("\n");

function sheet(overrides: Record<string, unknown> = {}): MeetingMinutes {
  return meetingMinutesSchema.parse({ title: "Checkout weekly", summary: "Shipping the fix.", ...overrides });
}

const decision = (quote: string) => ({ statement: "Ship the checkout fix", provisional: false, context: "", quote });
const action = (overrides: Record<string, unknown> = {}) => ({
  task: "Update the runbook",
  owner: "Budi",
  due: "",
  firstStep: "",
  quote: "I will update the runbook before 3 pm",
  ...overrides,
});

function problemOf(minutes: MeetingMinutes, id: string, transcript = TRANSCRIPT): string {
  const found = judgeMinutesEvidence(minutes, transcript, "en").find((judgement) => judgement.id === id);
  if (!found || found.ok) {
    throw new Error(`expected ${id} to fail`);
  }
  return found.problem ?? "";
}

describe("minutesItemId", () => {
  it("numbers decisions and action items from 1, each kind on its own", () => {
    expect(minutesItemId("decision", 0)).toBe("decision-1");
    expect(minutesItemId("action", 2)).toBe("action-3");
  });
});

describe("judgeMinutesEvidence", () => {
  it("passes a decision whose quote is in the transcript", () => {
    const result = judgeMinutesEvidence(
      sheet({ decisions: [decision("we ship the checkout fix on Friday 14 March")] }),
      TRANSCRIPT,
      "en",
    );
    expect(result).toEqual([{ id: "decision-1", ok: true }]);
  });

  it("finds a quote that differs only in case, spacing, dashes and quote marks", () => {
    const minutes = sheet({ decisions: [decision("WE  SHIP the checkout   fix on Friday 14 March")] });
    expect(judgeMinutesEvidence(minutes, TRANSCRIPT, "en")).toEqual([{ id: "decision-1", ok: true }]);
  });

  it("fails an item with no quote, and says what to copy", () => {
    expect(problemOf(sheet({ decisions: [decision("")] }), "decision-1")).toMatch(/no quote/i);
    expect(problemOf(sheet({ actionItems: [action({ quote: "   " })] }), "action-1")).toMatch(/no quote/i);
  });

  it("fails a quote that is a paraphrase, naming the quote", () => {
    const problem = problemOf(
      sheet({ decisions: [decision("the team decided to release the checkout fix on Friday")] }),
      "decision-1",
    );
    expect(problem).toMatch(/not in the transcript/i);
    expect(problem).toContain("the team decided to release the checkout fix");
  });

  it("fails a quote too short to prove anything", () => {
    expect(problemOf(sheet({ decisions: [decision("we ship")] }), "decision-1")).toMatch(/too short/i);
  });

  it("checks every item and keeps their order and numbering", () => {
    const minutes = sheet({
      decisions: [decision("we ship the checkout fix on Friday 14 March"), decision("a thing nobody said at all")],
      actionItems: [action(), action({ quote: "" })],
    });
    expect(judgeMinutesEvidence(minutes, TRANSCRIPT, "en").map(({ id, ok }) => [id, ok])).toEqual([
      ["decision-1", true],
      ["decision-2", false],
      ["action-1", true],
      ["action-2", false],
    ]);
  });

  describe("the owner", () => {
    it("passes an owner named close to the quote, in the speaker label or in the words", () => {
      expect(judgeMinutesEvidence(sheet({ actionItems: [action({ owner: "Budi" })] }), TRANSCRIPT, "en")[0]?.ok).toBe(
        true,
      );
      expect(judgeMinutesEvidence(sheet({ actionItems: [action({ owner: "Sari" })] }), TRANSCRIPT, "en")[0]?.ok).toBe(
        true,
      );
    });

    it("lets the marker through, since nobody took the item on", () => {
      const minutes = sheet({ actionItems: [action({ owner: NEEDS_OWNER })] });
      expect(judgeMinutesEvidence(minutes, TRANSCRIPT, "en")[0]?.ok).toBe(true);
    });

    it("fails an owner named only far from the quote", () => {
      const far = `Rina: kick-off.\n${"We went over the budget line by line. ".repeat(14)}\nSam: I will write the design document tomorrow.`;
      expect(far.indexOf("Sam:") - far.indexOf("Rina")).toBeGreaterThan(EVIDENCE_WINDOW_CHARS * 2);
      const quote = "I will write the design document tomorrow";
      const problem = problemOf(sheet({ actionItems: [action({ owner: "Rina", quote })] }), "action-1", far);
      expect(problem).toContain("Rina");
      expect(problem).toContain(String(EVIDENCE_WINDOW_CHARS));
      expect(judgeMinutesEvidence(sheet({ actionItems: [action({ owner: "Sam", quote })] }), far, "en")[0]?.ok).toBe(
        true,
      );
    });
  });

  describe("the due date", () => {
    it("passes a due date said next to the quote, however it is written", () => {
      const quote = "we ship the checkout fix on Friday 14 March";
      for (const due of ["14 March", "March 14", "Friday", "15:30"]) {
        const minutes = sheet({ actionItems: [action({ owner: "Dewi", quote, due })] });
        expect(judgeMinutesEvidence(minutes, TRANSCRIPT, "en")[0]?.ok, due).toBe(true);
      }
    });

    it("fails a due date the passage does not say, even when another part of the meeting does", () => {
      const quote = "I will update the runbook before 3 pm";
      const longer = `${TRANSCRIPT}\n${"x ".repeat(400)}\nBudi: the audit is on 21 April.`;
      const problem = problemOf(sheet({ actionItems: [action({ quote, due: "21 April" })] }), "action-1", longer);
      expect(problem).toContain("21 April");
      expect(problem).toContain(String(EVIDENCE_WINDOW_CHARS));
      // The same words, but the passage right next to the quote says the date.
      const near = `${TRANSCRIPT}\nBudi: and the audit is on 21 April.`;
      expect(
        judgeMinutesEvidence(sheet({ actionItems: [action({ quote, due: "21 April" })] }), near, "en")[0]?.ok,
      ).toBe(true);
    });

    it("does not look at a due date the writer left empty", () => {
      expect(judgeMinutesEvidence(sheet({ actionItems: [action({ due: "" })] }), TRANSCRIPT, "en")[0]?.ok).toBe(true);
    });

    it("reports the owner and the due date together when both are wrong", () => {
      const problem = problemOf(sheet({ actionItems: [action({ owner: "Zed", due: "1 January" })] }), "action-1");
      expect(problem).toContain("Zed");
      expect(problem).toContain("1 January");
    });
  });
});

describe("a transcript the way the recogniser writes it", () => {
  // Bold speaker labels, and a model that quotes with curly apostrophes and the label itself.
  const SPOKEN = [
    "**Daniel Brooks**: Okay, let's get started. The checkout latency fix has to go to production on Friday the 14th.",
    "**Maya Chen**: I can take the release. I'll have the rollout plan ready by Wednesday.",
    "**Daniel Brooks**: Good. And nobody has picked up the vendor audit yet.",
  ].join("\n\n");

  it("verifies a quote with the label, curly apostrophes and different spacing, and the owner from the label", () => {
    const minutes = sheet({
      decisions: [
        decision(
          "Daniel Brooks: Okay, let’s get started. The checkout latency fix has to go to production on Friday the 14th.",
        ),
      ],
      actionItems: [
        action({
          task: "Prepare the rollout plan",
          owner: "Maya Chen",
          due: "Wednesday",
          quote: "I can take the release. I’ll have the rollout  plan ready by Wednesday.",
        }),
      ],
    });
    expect(judgeMinutesEvidence(minutes, SPOKEN, "en")).toEqual([
      { id: "decision-1", ok: true },
      { id: "action-1", ok: true },
    ]);
  });

  it("is lenient about the speaker beside the quote, and refuses a name that is nowhere near it", () => {
    const far = `${SPOKEN}\n\n${"Daniel Brooks: and so on and so forth about other matters. ".repeat(12)}\n**Maya Chen**: I will send the audit scope on Monday.`;
    const minutes = sheet({
      actionItems: [action({ owner: "Daniel Brooks", quote: "I will send the audit scope on Monday", due: "Monday" })],
    });
    // "Daniel Brooks" is the speaker of the filler before it, which is within the window: lenient by design.
    expect(judgeMinutesEvidence(minutes, far, "en")[0]?.ok).toBe(true);
    const unrelated = sheet({
      actionItems: [action({ owner: "Priya Nair", quote: "I will send the audit scope on Monday", due: "Monday" })],
    });
    expect(judgeMinutesEvidence(unrelated, far, "en")[0]?.ok).toBe(false);
  });
});

describe("markMinutesEvidence", () => {
  it("stamps each item verified or unverified, and leaves the rest of the sheet alone", () => {
    const minutes = sheet({
      decisions: [decision("we ship the checkout fix on Friday 14 March"), decision("")],
      actionItems: [action(), action({ owner: "Zed" })],
    });
    const marked = markMinutesEvidence(minutes, TRANSCRIPT, "en");
    expect(marked.decisions.map((item) => item.evidence)).toEqual(["verified", "unverified"]);
    expect(marked.actionItems.map((item) => item.evidence)).toEqual(["verified", "unverified"]);
    expect({ ...marked, decisions: [], actionItems: [] }).toEqual({ ...minutes, decisions: [], actionItems: [] });
  });

  it("returns a new sheet and does not touch the one it was given", () => {
    const minutes = sheet({ decisions: [decision("we ship the checkout fix on Friday 14 March")] });
    const marked = markMinutesEvidence(minutes, TRANSCRIPT, "en");
    expect(marked).not.toBe(minutes);
    expect(minutes.decisions[0]?.evidence).toBeUndefined();
  });

  it("marks minutes saved before quotes existed unverified, never verified", () => {
    const legacy = sheet({ decisions: [{ statement: "Ship it", provisional: false, context: "" }] });
    expect(legacy.decisions[0]?.quote).toBe("");
    expect(markMinutesEvidence(legacy, TRANSCRIPT, "en").decisions[0]?.evidence).toBe("unverified");
  });
});

describe("MINUTES_EVIDENCE_WORDS", () => {
  it("names the items in the fix and tells the writer what a quote is", () => {
    expect(MINUTES_EVIDENCE_WORDS.fix).toContain("{items}");
    expect(MINUTES_EVIDENCE_WORDS.fix).toContain("word for word");
    expect(MINUTES_EVIDENCE_WORDS.error).not.toBe("");
    expect(MINUTES_EVIDENCE_WORDS.why).not.toBe("");
  });
});
