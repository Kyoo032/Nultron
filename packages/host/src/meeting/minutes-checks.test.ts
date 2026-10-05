/**
 * Meeting mode — the checks the minutes must pass. Each one gets the verdict it must give, spelled
 * out in full, for a draft that passes and for a draft that does not.
 */
import { describe, expect, it } from "vitest";
import type { CheckVerdict } from "@agentforge/core/harness";
import { NEEDS_OWNER, type MeetingMinutes } from "@agentforge/core/meeting";
import {
  actionOwnersCheck,
  buildMinutesChecks,
  findDateTimeMentions,
  MINUTES_CHECK_IDS,
  minutesParseError,
  minutesRepairPrompt,
  minutesShapeCheck,
  parseMinutesDraft,
  quotedDatesCheck,
  summarizeMinutesChecks,
  summaryPresentCheck,
  TRIVIAL_TRANSCRIPT_WORDS,
  type MinutesDraft,
} from "./minutes-checks";

const TRANSCRIPT = [
  "Dewi: we ship the checkout fix on Friday 14 March, and the call is at 15:30.",
  "Budi: I will update the runbook before 3 pm and send it to Sari.",
  "Dewi: good, nobody owns the vendor contract yet, so we leave that open.",
].join("\n");

function minutes(overrides: Partial<MeetingMinutes> = {}): MeetingMinutes {
  return {
    title: "Checkout weekly",
    heldOn: "",
    summary: "The team agreed to ship the checkout fix.",
    attendees: [{ name: "Dewi", role: "" }],
    decisions: [],
    actionItems: [],
    risks: [],
    openQuestions: [],
    ...overrides,
  };
}

function draftOf(value: MeetingMinutes): MinutesDraft {
  return { raw: JSON.stringify(value), model: "m", parsed: { ok: true, minutes: value } };
}

function failed(verdict: CheckVerdict) {
  if (verdict.ok) {
    throw new Error("expected a failing verdict");
  }
  return verdict;
}

describe("parseMinutesDraft", () => {
  it("reads the minutes out of a fenced answer", () => {
    const parsed = parseMinutesDraft(`\`\`\`json\n${JSON.stringify(minutes())}\n\`\`\``);
    expect(parsed).toEqual({ ok: true, minutes: expect.objectContaining({ title: "Checkout weekly" }) });
  });

  it("keeps the error code and message the run threw before the checks existed", () => {
    expect(parseMinutesDraft("   ")).toMatchObject({
      ok: false,
      code: "generation_failed",
      message: "The model returned no minutes",
      detail: "the answer was empty",
    });
    expect(parseMinutesDraft("no json here")).toMatchObject({
      ok: false,
      code: "invalid_minutes",
      message: "The model returned invalid JSON for the minutes",
    });
    expect(parseMinutesDraft("{ not json }")).toMatchObject({ ok: false, code: "invalid_minutes" });
  });

  it("names the field that failed validation in the detail, and not in the message", () => {
    const parsed = parseMinutesDraft(JSON.stringify({ title: "x", summary: "" }));
    if (parsed.ok) {
      throw new Error("expected a parse failure");
    }
    expect(parsed.code).toBe("invalid_minutes");
    expect(parsed.message.startsWith("Minutes failed validation: ")).toBe(true);
    expect(parsed.message).not.toContain("summary:");
    expect(parsed.detail).toContain("summary: ");
    const error = minutesParseError(parsed);
    expect(error).toMatchObject({ code: "invalid_minutes", status: 502, message: parsed.message });
  });
});

describe("minutes-shape", () => {
  it("passes minutes that parsed", () => {
    expect(minutesShapeCheck.run(draftOf(minutes()))).toEqual({ ok: true });
  });

  it("fails an answer that is not the JSON object, and says how to fix it", () => {
    const parsed = parseMinutesDraft("Here are your minutes: ...");
    const verdict = failed(minutesShapeCheck.run({ raw: "Here are your minutes: ...", model: "m", parsed }));
    expect(verdict.check).toBe("minutes-shape");
    expect(verdict.error).toBe("The minutes could not be read: the answer is not a single JSON object.");
    expect(verdict.fix).toBe(
      'Return only the JSON object in the required shape, with no fences or commentary. "title" and "summary" are non-empty strings, and every action item has a non-empty "task" and "owner".',
    );
    expect(verdict.why).not.toBe("");
  });

  it("fails an empty answer", () => {
    const verdict = failed(minutesShapeCheck.run({ raw: "", model: "m", parsed: parseMinutesDraft("") }));
    expect(verdict.error).toBe("The minutes could not be read: the answer was empty.");
  });
});

describe("action-owners", () => {
  const check = actionOwnersCheck(TRANSCRIPT);
  const item = (task: string, owner: string) => ({ task, owner, due: "", firstStep: "" });

  it("passes owners the transcript names, in any case, and the explicit marker", () => {
    const value = minutes({
      actionItems: [
        item("Update the runbook", "Budi"),
        item("Ship the checkout fix", "DEWI"),
        item("Own the vendor contract", NEEDS_OWNER),
      ],
    });
    expect(check.run(draftOf(value))).toEqual({ ok: true });
  });

  it("passes a draft with no action items, and one that did not parse", () => {
    expect(check.run(draftOf(minutes()))).toEqual({ ok: true });
    expect(check.run({ raw: "", model: "m", parsed: parseMinutesDraft("") })).toEqual({ ok: true });
  });

  it("fails an owner the transcript never names, naming the item to fix", () => {
    const value = minutes({
      actionItems: [item("Update the runbook", "Budi"), item("Renegotiate the vendor contract", "Rudi")],
    });
    const verdict = failed(check.run(draftOf(value)));
    expect(verdict.check).toBe("action-owners");
    expect(verdict.error).toBe(
      'action item 2 ("Renegotiate the vendor contract") is owned by "Rudi", a name the transcript never says.',
    );
    expect(verdict.fix).toBe(
      'Fix action item 2 ("Renegotiate the vendor contract"): give each a task, and set the owner to a person who speaks or is named in the transcript, or to exactly "[needs owner]" when nobody took it on.',
    );
  });

  it("fails a blank task and a blank owner, one line each", () => {
    const value = minutes({ actionItems: [item("  ", "Dewi"), item("Send the notes", "  ")] });
    const verdict = failed(check.run(draftOf(value)));
    expect(verdict.error).toBe('action item 1 has no task; action item 2 ("Send the notes") has no owner.');
    expect(verdict.fix).toContain('Fix action item 1, action item 2 ("Send the notes"):');
  });

  it("leaves an owner with no usable word alone, as the guard does", () => {
    const value = minutes({ actionItems: [item("Review the numbers", "QA")] });
    expect(check.run(draftOf(value))).toEqual({ ok: true });
  });
});

describe("findDateTimeMentions", () => {
  const read = (text: string) =>
    findDateTimeMentions(text).map(({ kind, text: quote, numbers, month, year }) => ({
      kind,
      quote,
      numbers,
      month,
      year,
    }));

  it("reads a day and a month in either order, with an optional year", () => {
    expect(read("Ship on 14 March 2026, review March 20th.")).toEqual([
      { kind: "date", quote: "14 March 2026", numbers: [14, 2026], month: 3, year: null },
      { kind: "date", quote: "March 20th", numbers: [20], month: 3, year: null },
    ]);
  });

  it("reads Indonesian months", () => {
    expect(read("Tenggat 5 Agustus dan Mei 3")).toEqual([
      { kind: "date", quote: "5 Agustus", numbers: [5], month: 8, year: null },
      { kind: "date", quote: "Mei 3", numbers: [3], month: 5, year: null },
    ]);
  });

  it("reads numeric dates", () => {
    expect(read("on 2026-03-14 or 14/03/2026")).toEqual([
      { kind: "numeric-date", quote: "2026-03-14", numbers: [3, 14], month: null, year: 2026 },
      { kind: "numeric-date", quote: "14/03/2026", numbers: [14, 3], month: null, year: 2026 },
    ]);
  });

  it("reads clock times with a colon or an am/pm, and the Indonesian pukul/jam", () => {
    expect(read("at 3:30 pm, again at 15:00, at 9am, jam 15.30 and pukul 9")).toEqual([
      { kind: "clock", quote: "jam 15.30", numbers: [15, 30], month: null, year: null },
      { kind: "clock", quote: "pukul 9", numbers: [9, 0], month: null, year: null },
      { kind: "clock", quote: "3:30 pm", numbers: [3, 30], month: null, year: null },
      { kind: "clock", quote: "15:00", numbers: [15, 0], month: null, year: null },
      { kind: "clock", quote: "9am", numbers: [9, 0], month: null, year: null },
    ]);
  });

  it("does not read the verbs may and march, decimals, plain numbers, weekdays or relative dates", () => {
    expect(
      read("we may 5 times march 3 steps; budget 3.5 million, 12 people, ratio 3:1, by Friday, next week, in Q3 2026"),
    ).toEqual([]);
  });

  it("does not read a day out of a clock time that follows a month", () => {
    expect(read("14 March 15:00")).toEqual([
      { kind: "date", quote: "14 March", numbers: [14], month: 3, year: null },
      { kind: "clock", quote: "15:00", numbers: [15, 0], month: null, year: null },
    ]);
  });
});

describe("quoted-dates", () => {
  const check = quotedDatesCheck(TRANSCRIPT);
  const item = (task: string, due = "", firstStep = "") => ({ task, owner: "Dewi", due, firstStep });
  const decision = (statement: string, context = "") => ({ statement, provisional: false, context });

  it("passes dates and times the transcript says, in either 12- or 24-hour form", () => {
    const value = minutes({
      decisions: [decision("Ship the fix on 14 March", "the call is at 3:30 pm")],
      actionItems: [item("Update the runbook", "before 15:00")],
    });
    expect(check.run(draftOf(value))).toEqual({ ok: true });
  });

  it("passes a date written in the other language than the transcript's", () => {
    const indonesian = quotedDatesCheck("Dewi: kita rilis pada 14 Maret, lalu kumpul lagi 20 Maret nanti.");
    const value = minutes({ decisions: [decision("Release on March 14 and March 20")] });
    expect(indonesian.run(draftOf(value))).toEqual({ ok: true });
  });

  it("passes a numeric date whose day, month name and year the transcript says, and fails one whose year it does not", () => {
    const said = quotedDatesCheck("Dewi: we ship on 14 March 2026.");
    expect(said.run(draftOf(minutes({ decisions: [decision("Ship on 14/03/2026")] })))).toEqual({ ok: true });
    expect(said.run(draftOf(minutes({ decisions: [decision("Ship on 2026-03-14")] })))).toEqual({ ok: true });
    expect(failed(said.run(draftOf(minutes({ decisions: [decision("Ship on 14/03/2027")] })))).error).toBe(
      'decision 1 ("Ship on 14/03/2027") quotes "14/03/2027", which the transcript never says.',
    );
  });

  it("passes items with no date or time in them, and a draft that did not parse", () => {
    const value = minutes({ decisions: [decision("Ship by Friday")], actionItems: [item("Send it next week")] });
    expect(check.run(draftOf(value))).toEqual({ ok: true });
    expect(check.run({ raw: "", model: "m", parsed: parseMinutesDraft("") })).toEqual({ ok: true });
  });

  it("fails a date the transcript never says, naming the decision", () => {
    const value = minutes({ decisions: [decision("Ship the fix on 21 March")] });
    const verdict = failed(check.run(draftOf(value)));
    expect(verdict.check).toBe("quoted-dates");
    expect(verdict.error).toBe(
      'decision 1 ("Ship the fix on 21 March") quotes "21 March", which the transcript never says.',
    );
    expect(verdict.fix).toBe(
      'In decision 1 ("Ship the fix on 21 March"), replace each such date or time with what the transcript says, or take it out (leave "due" empty) when nobody stated one. Change nothing else.',
    );
  });

  it("fails a time the transcript never says, in an action item's due and first step", () => {
    const value = minutes({
      actionItems: [item("Update the runbook", "9:45 am"), item("Send the notes", "", "call at 11 pm")],
    });
    const verdict = failed(check.run(draftOf(value)));
    expect(verdict.error).toBe(
      'action item 1 ("Update the runbook") quotes "9:45 am"; action item 2 ("Send the notes") quotes "11 pm", which the transcript never says.',
    );
    expect(verdict.fix).toContain('In action item 1 ("Update the runbook"), action item 2 ("Send the notes"),');
  });

  it("fails a month the transcript never names even when the day number appears", () => {
    // "14" is in the transcript, but only with March.
    const value = minutes({ decisions: [decision("Ship the fix on 14 June")] });
    expect(failed(check.run(draftOf(value))).error).toContain('quotes "14 June"');
  });

  it("flags digits the transcript only spells out in words, a known miss that costs one repair round", () => {
    const spelled = quotedDatesCheck("Dewi: we meet at three pm on the fourteenth of March");
    const value = minutes({ decisions: [decision("Meet at 3 pm on 14 March")] });
    expect(failed(spelled.run(draftOf(value))).error).toContain('"14 March"');
  });
});

describe("summary-present", () => {
  const words = (count: number) => Array.from({ length: count }, (_, index) => `w${index}`).join(" ");

  it("passes a real summary", () => {
    expect(summaryPresentCheck(words(60)).run(draftOf(minutes()))).toEqual({ ok: true });
  });

  it("fails a blank or punctuation-only summary on a transcript past the threshold", () => {
    expect(TRIVIAL_TRANSCRIPT_WORDS).toBe(20);
    const verdict = failed(summaryPresentCheck(words(21)).run(draftOf(minutes({ summary: " " }))));
    expect(verdict.check).toBe("summary-present");
    expect(verdict.error).toBe("The summary is empty, but the transcript is 21 words long.");
    expect(verdict.fix).toBe(
      'Fill "summary" with two or three sentences on what the meeting covered and what it settled, using only what the transcript says.',
    );
    expect(summaryPresentCheck(words(60)).run(draftOf(minutes({ summary: "—" }))).ok).toBe(false);
  });

  it("lets a trivial transcript through with a blank summary", () => {
    expect(summaryPresentCheck(words(20)).run(draftOf(minutes({ summary: " " })))).toEqual({ ok: true });
    expect(summaryPresentCheck("").run(draftOf(minutes({ summary: " " })))).toEqual({ ok: true });
  });
});

describe("the set", () => {
  it("runs the four checks in a fixed order", () => {
    expect(buildMinutesChecks(TRANSCRIPT).map((check) => check.id)).toEqual([
      "minutes-shape",
      "action-owners",
      "quoted-dates",
      "summary-present",
    ]);
    expect(Object.values(MINUTES_CHECK_IDS)).toEqual([
      "minutes-shape",
      "action-owners",
      "quoted-dates",
      "summary-present",
    ]);
  });

  it("passes ordinary minutes of the transcript it was built for", () => {
    const value = minutes({
      heldOn: "14 March",
      decisions: [{ statement: "Ship the checkout fix on 14 March", provisional: false, context: "" }],
      actionItems: [{ task: "Update the runbook", owner: "Budi", due: "3 pm", firstStep: "" }],
    });
    const verdicts = buildMinutesChecks(TRANSCRIPT).map((check) => check.run(draftOf(value)));
    expect(verdicts).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: true }]);
  });

  it("summarises a run as ids and pass/fail, never the minutes text", () => {
    const checks = buildMinutesChecks(TRANSCRIPT);
    const summary = summarizeMinutesChecks(checks, {
      verdicts: [
        { ok: true },
        { ok: false, check: "action-owners", error: "secret client name", why: "w", fix: "f" },
        { ok: true },
        { ok: true },
      ],
      rounds: 1,
      passed: false,
    });
    expect(summary).toEqual({
      passed: false,
      rounds: 1,
      verdicts: [
        { check: "minutes-shape", ok: true },
        { check: "action-owners", ok: false },
        { check: "quoted-dates", ok: true },
        { check: "summary-present", ok: true },
      ],
    });
    expect(JSON.stringify(summary)).not.toContain("secret");
  });

  it("puts the failed draft and the note into the repair prompt", () => {
    expect(minutesRepairPrompt("BASE", '{"title":"x"}', "NOTE")).toBe(
      'BASE\n\nYour previous answer:\n\n{"title":"x"}\n\nNOTE',
    );
    expect(minutesRepairPrompt("BASE", "  ", "NOTE")).toBe("BASE\n\nYour previous answer:\n\n(empty)\n\nNOTE");
  });
});
