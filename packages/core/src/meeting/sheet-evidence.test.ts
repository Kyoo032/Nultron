/**
 * Meeting mode: quotes and evidence through the parse, the settle and the translation.
 */
import { describe, expect, it } from "vitest";
import {
  MEETING_MINUTES_SYSTEM,
  MEETING_REQUEST_MAX_CHARS,
  MEETING_TRANSLATE_SYSTEM,
  minutesPrompt,
  translatePrompt,
} from "./prompts";
import { meetingMinutesSchema, minutesForModel, withoutMarks, type MeetingMinutes } from "./minutes";
import { MeetingTranslationError, parseMeetingMinutes, settleMinutes, translateMeetingSheet } from "./sheet";
import { translationRetryNote } from "./copy";
import { applyMinutesItemEdit } from "./edits";

const TRANSCRIPT = [
  "Rina: we ship the checkout fix on Friday 14 March.",
  "Sam: I will write the design document before Friday.",
].join("\n");

const DECISION_QUOTE = "we ship the checkout fix on Friday 14 March";
const ACTION_QUOTE = "I will write the design document before Friday";

function sheet(overrides: Record<string, unknown> = {}): MeetingMinutes {
  return meetingMinutesSchema.parse({
    title: "Checkout weekly",
    summary: "The team ships the fix.",
    attendees: [{ name: "Rina", role: "" }],
    decisions: [{ statement: "Ship the fix", provisional: false, context: "", quote: DECISION_QUOTE }],
    actionItems: [{ task: "Write the design", owner: "Sam", due: "Friday", firstStep: "", quote: ACTION_QUOTE }],
    ...overrides,
  });
}

describe("parseMeetingMinutes", () => {
  it("drops an evidence verdict the writer sent, and does not fail on a made-up one", () => {
    const json = JSON.stringify({
      ...sheet(),
      decisions: [{ ...sheet().decisions[0], evidence: "verified" }],
      actionItems: [{ ...sheet().actionItems[0], evidence: "maybe" }],
    });
    const parsed = parseMeetingMinutes(json, "en");
    expect(parsed.decisions[0]?.evidence).toBeUndefined();
    expect(parsed.actionItems[0]?.evidence).toBeUndefined();
    expect(parsed.decisions[0]?.quote).toBe(DECISION_QUOTE);
  });

  it("reads minutes saved before quotes existed, with an empty quote and no evidence", () => {
    const legacy = {
      title: "Old",
      summary: "Old minutes.",
      decisions: [{ statement: "Ship it", provisional: true, context: "" }],
      actionItems: [{ task: "Do it", owner: "Sam", due: "", firstStep: "" }],
    };
    const parsed = meetingMinutesSchema.parse(legacy);
    expect(parsed.decisions[0]).toMatchObject({ quote: "", provisional: true });
    expect(parsed.decisions[0]?.evidence).toBeUndefined();
    expect(parsed.actionItems[0]).toMatchObject({ quote: "" });
    expect(parsed.actionItems[0]?.evidence).toBeUndefined();
  });
});

describe("withoutEvidence and minutesForModel", () => {
  it("removes only the evidence key and leaves everything else, including a missing list", () => {
    const marked = {
      title: "t",
      decisions: [{ statement: "s", quote: "q", evidence: "verified" }],
      actionItems: [{ task: "t", owner: "o", evidence: "unverified" }],
    };
    expect(withoutMarks(marked)).toEqual({
      title: "t",
      decisions: [{ statement: "s", quote: "q" }],
      actionItems: [{ task: "t", owner: "o" }],
    });
    expect(withoutMarks("not an object")).toBe("not an object");
    expect(withoutMarks({ title: "t" })).toMatchObject({ title: "t" });
  });

  it("gives the model a sheet with no verdicts on it", () => {
    const settled = settleMinutes(JSON.stringify(sheet()), TRANSCRIPT, "en").minutes;
    expect(settled.decisions[0]?.evidence).toBe("verified");
    const forModel = minutesForModel(settled);
    expect(forModel.decisions[0]?.evidence).toBeUndefined();
    expect(JSON.stringify(forModel)).not.toContain("evidence");
  });
});

describe("settleMinutes marks the evidence", () => {
  it("verifies items the transcript backs and marks the rest unverified, without dropping them", () => {
    const settled = settleMinutes(
      JSON.stringify(
        sheet({
          decisions: [
            { statement: "Ship the fix", provisional: false, context: "", quote: DECISION_QUOTE },
            {
              statement: "Hire two engineers",
              provisional: false,
              context: "",
              quote: "we will hire two engineers next month",
            },
          ],
        }),
      ),
      TRANSCRIPT,
      "en",
    );
    expect(settled.minutes.decisions.map((decision) => decision.evidence)).toEqual(["verified", "unverified"]);
    expect(settled.minutes.actionItems.map((item) => item.evidence)).toEqual(["verified"]);
    expect(settled.minutes.decisions).toHaveLength(2);
  });

  it("does not touch the quote when the guards rewrite figures and dates", () => {
    const settled = settleMinutes(
      JSON.stringify(
        sheet({
          summary: "Latency hit 99 ms.",
          decisions: [{ statement: "Ship on 14 March", provisional: false, context: "", quote: DECISION_QUOTE }],
        }),
      ),
      TRANSCRIPT,
      "en",
    );
    expect(settled.minutes.summary).toContain("[figure not said]");
    expect(settled.minutes.decisions[0]?.quote).toBe(DECISION_QUOTE);
  });
});

describe("the prompts", () => {
  it("ask for a quote on every decision and action item, copied and never translated", () => {
    expect(MEETING_MINUTES_SYSTEM).toContain('"quote": string');
    expect(MEETING_MINUTES_SYSTEM).toMatch(/word for word/i);
    expect(MEETING_MINUTES_SYSTEM).toMatch(/never translate/i);
    expect(MEETING_MINUTES_SYSTEM).not.toContain("evidence");
  });

  it("carry the owner's request into the minutes prompt as a steer, and say nothing without one", () => {
    const withRequest = minutesPrompt(TRANSCRIPT, { title: "Weekly", request: "Minutes and who does what" });
    expect(withRequest).toContain("What the owner asked for:\nMinutes and who does what");
    expect(withRequest.indexOf("What the owner asked for")).toBeLessThan(withRequest.indexOf("Transcript:"));
    expect(minutesPrompt(TRANSCRIPT, { title: "Weekly" })).not.toContain("asked for");
    expect(MEETING_MINUTES_SYSTEM).toMatch(/request[^\n]*never lets you skip a rule/i);
    expect(MEETING_REQUEST_MAX_CHARS).toBe(2000);
  });

  it("tell the translator to keep the quote exactly, and show it no verdicts", () => {
    expect(MEETING_TRANSLATE_SYSTEM).toMatch(/"quote"[^\n]*exactly/i);
    const prompt = translatePrompt(settleMinutes(JSON.stringify(sheet()), TRANSCRIPT, "en").minutes, "id");
    expect(prompt).toContain(DECISION_QUOTE);
    expect(prompt).not.toContain("evidence");
  });
});

describe("translateMeetingSheet and the quotes", () => {
  const translatedOk = (): string =>
    JSON.stringify({
      ...sheet(),
      title: "Rapat checkout mingguan",
      summary: "Tim merilis perbaikan.",
      decisions: [{ statement: "Rilis perbaikan", provisional: false, context: "", quote: DECISION_QUOTE }],
      actionItems: [{ task: "Tulis dokumen desain", owner: "Sam", due: "Friday", firstStep: "", quote: ACTION_QUOTE }],
    });

  it("accepts a translation that keeps the quotes, and carries the evidence over", async () => {
    const source = settleMinutes(JSON.stringify(sheet()), TRANSCRIPT, "en").minutes;
    const result = await translateMeetingSheet({
      transcript: TRANSCRIPT,
      source,
      locale: "id",
      ask: async () => translatedOk(),
    });
    expect(result.minutes.decisions[0]).toMatchObject({
      statement: "Rilis perbaikan",
      quote: DECISION_QUOTE,
      evidence: "verified",
    });
    expect(result.minutes.actionItems[0]).toMatchObject({ quote: ACTION_QUOTE, evidence: "verified" });
  });

  it("asks once more when the first translation translated a quote, then keeps the sheet", async () => {
    const source = settleMinutes(JSON.stringify(sheet()), TRANSCRIPT, "en").minutes;
    const prompts: string[] = [];
    const result = await translateMeetingSheet({
      transcript: TRANSCRIPT,
      source,
      locale: "id",
      ask: async (prompt) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          const wrong = JSON.parse(translatedOk()) as MeetingMinutes;
          return JSON.stringify({
            ...wrong,
            decisions: [{ ...wrong.decisions[0], quote: "kita rilis perbaikan checkout hari Jumat 14 Maret" }],
          });
        }
        return translatedOk();
      },
    });
    expect(prompts).toHaveLength(2);
    expect(result.minutes.decisions[0]?.quote).toBe(DECISION_QUOTE);
  });

  it("does not take the owner's own edit for an invented name, and keeps the edited mark", async () => {
    const settled = settleMinutes(JSON.stringify(sheet()), TRANSCRIPT, "en").minutes;
    const source = applyMinutesItemEdit(settled, { kind: "action", index: 0, set: { owner: "Zed", due: "1 January" } });
    const result = await translateMeetingSheet({
      transcript: TRANSCRIPT,
      source,
      locale: "id",
      ask: async () => {
        const translated = JSON.parse(translatedOk()) as MeetingMinutes;
        return JSON.stringify({
          ...translated,
          actionItems: [{ ...translated.actionItems[0], owner: "Zed", due: "1 January" }],
        });
      },
    });
    expect(result.minutes.actionItems[0]).toMatchObject({
      owner: "Zed",
      due: "1 January",
      quote: ACTION_QUOTE,
      evidence: "verified",
      edited: true,
    });
  });

  it("gives up after the second miss and keeps nothing", async () => {
    const source = settleMinutes(JSON.stringify(sheet()), TRANSCRIPT, "en").minutes;
    let calls = 0;
    await expect(
      translateMeetingSheet({
        transcript: TRANSCRIPT,
        source,
        locale: "id",
        ask: async () => {
          calls += 1;
          const wrong = JSON.parse(translatedOk()) as MeetingMinutes;
          return JSON.stringify({
            ...wrong,
            actionItems: [{ ...wrong.actionItems[0], quote: "saya akan menulis dokumen desainnya" }],
          });
        },
      }),
    ).rejects.toBeInstanceOf(MeetingTranslationError);
    expect(calls).toBe(2);
  });

  it("tells the retry to keep the quotes", () => {
    expect(translationRetryNote("en")).toMatch(/quote/i);
    expect(translationRetryNote("id")).toMatch(/kutipan/i);
  });
});
