import { describe, expect, it } from "vitest";
import { minutesAgree } from "./agree";
import { meetingMinutesSchema, type MeetingMinutes } from "./minutes";

function sheet(overrides: Record<string, unknown> = {}): MeetingMinutes {
  return meetingMinutesSchema.parse({
    title: "Checkout weekly",
    summary: "The team ships on Friday.",
    attendees: [{ name: "Rina", role: "" }],
    decisions: [
      { statement: "Ship on Friday", provisional: false, context: "", quote: "we ship the checkout fix on Friday" },
    ],
    actionItems: [
      {
        task: "Write the design",
        owner: "Rina",
        due: "Friday",
        firstStep: "",
        quote: "I will write the design this week",
      },
    ],
    ...overrides,
  });
}

describe("minutesAgree and the quotes", () => {
  it("agrees when the words change and the quotes do not", () => {
    const translated = sheet({
      title: "Rapat checkout mingguan",
      summary: "Tim merilis hari Jumat.",
      decisions: [
        { statement: "Rilis hari Jumat", provisional: false, context: "", quote: "we ship the checkout fix on Friday" },
      ],
      actionItems: [
        {
          task: "Tulis desainnya",
          owner: "Rina",
          due: "Friday",
          firstStep: "",
          quote: "I will write the design this week",
        },
      ],
    });
    expect(minutesAgree(sheet(), translated)).toEqual({ ok: true });
  });

  it("refuses a translated decision quote", () => {
    const translated = sheet({
      decisions: [
        {
          statement: "Rilis hari Jumat",
          provisional: false,
          context: "",
          quote: "kita rilis perbaikan checkout hari Jumat",
        },
      ],
    });
    expect(minutesAgree(sheet(), translated)).toEqual({ ok: false, reason: "quotes" });
  });

  it("refuses a changed action item quote, even by one character", () => {
    const translated = sheet({
      actionItems: [
        {
          task: "Write the design",
          owner: "Rina",
          due: "Friday",
          firstStep: "",
          quote: "I will write the design this week.",
        },
      ],
    });
    expect(minutesAgree(sheet(), translated)).toEqual({ ok: false, reason: "quotes" });
  });

  it("refuses a quote that was added or dropped", () => {
    const dropped = sheet({
      decisions: [{ statement: "Ship on Friday", provisional: false, context: "", quote: "" }],
    });
    expect(minutesAgree(sheet(), dropped)).toEqual({ ok: false, reason: "quotes" });
  });

  it("still agrees on minutes saved before quotes existed, where every quote is empty", () => {
    const legacy = sheet({
      decisions: [{ statement: "Ship on Friday", provisional: false, context: "" }],
      actionItems: [{ task: "Write the design", owner: "Rina", due: "Friday", firstStep: "" }],
    });
    expect(minutesAgree(legacy, legacy)).toEqual({ ok: true });
  });

  it("keeps the older reasons first: a dropped decision is a counts miss, not a quotes miss", () => {
    expect(minutesAgree(sheet(), sheet({ decisions: [] }))).toEqual({ ok: false, reason: "counts" });
  });
});
