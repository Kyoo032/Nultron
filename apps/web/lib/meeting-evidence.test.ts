/**
 * What the Minutes tab says about the evidence for each decision and action item.
 *
 * Only code sets `evidence` (`packages/core/src/meeting/evidence.ts`): "verified" when the quote is in the
 * transcript, the owner is named near it and the due date is said there. The page reads the verdicts and
 * never decides one itself.
 */
import { describe, expect, it } from "vitest";
import type { MeetingMinutes } from "@agentforge/core/meeting";
import { evidenceSummary } from "./meeting-evidence";

const base: MeetingMinutes = {
  title: "Checkout weekly",
  heldOn: "",
  summary: "Shipping on Friday.",
  attendees: [],
  decisions: [],
  actionItems: [],
  risks: [],
  openQuestions: [],
};

const decision = (evidence?: "verified" | "unverified") => ({
  statement: "Ship on Friday",
  provisional: false,
  context: "",
  quote: "we ship on Friday",
  ...(evidence ? { evidence } : {}),
});

const action = (evidence?: "verified" | "unverified") => ({
  task: "Send the budget",
  owner: "Dewi",
  due: "",
  firstStep: "",
  quote: "Dewi will send the budget",
  ...(evidence ? { evidence } : {}),
});

describe("evidenceSummary", () => {
  it("is null for minutes saved before evidence existed", () => {
    expect(evidenceSummary({ ...base, decisions: [decision()], actionItems: [action()] })).toBeNull();
  });

  it("is null when there is nothing to back", () => {
    expect(evidenceSummary(base)).toBeNull();
  });

  it("is verified when every judged item is", () => {
    expect(evidenceSummary({ ...base, decisions: [decision("verified")], actionItems: [action("verified")] })).toEqual({
      status: "verified",
      verified: 2,
      unverified: 0,
    });
  });

  it("is unverified as soon as one item is, and counts both kinds", () => {
    expect(
      evidenceSummary({
        ...base,
        decisions: [decision("verified"), decision("unverified")],
        actionItems: [action("unverified")],
      }),
    ).toEqual({ status: "unverified", verified: 1, unverified: 2 });
  });

  it("does not count an item with no verdict", () => {
    expect(evidenceSummary({ ...base, decisions: [decision("verified"), decision()] })).toEqual({
      status: "verified",
      verified: 1,
      unverified: 0,
    });
  });
});
