/**
 * What Meeting says about the checks its minutes still failed after the repair round.
 *
 * The host keeps the minutes either way and sends the verdicts with them (`checks` on the minutes
 * record, `packages/host/src/meeting/records.ts`). The note is calm, names what failed in plain words,
 * and renders nothing when everything passed or when an older record has no verdicts at all.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { MeetingMinutes } from "@agentforge/core/meeting";
import { MeetingChecksNote } from "@/components/meeting-checks-note";
import { MeetingMinutesPanel } from "@/components/meeting-minutes-panel";
import { applyLocale, resetLocaleForTests } from "./i18n";
import { meetingChecksNote } from "./meeting-checks";

const verdicts = (failed: string[]) =>
  ["minutes-shape", "action-owners", "quoted-dates", "summary-present", "minutes-evidence"].map((check) => ({
    check,
    ok: !failed.includes(check),
  }));

const MINUTES: MeetingMinutes = {
  title: "Checkout weekly",
  heldOn: "",
  summary: "The team agreed to ship the checkout fix on Friday.",
  attendees: [],
  decisions: [],
  actionItems: [],
  risks: [],
  openQuestions: [],
};

afterEach(() => resetLocaleForTests());

describe("meetingChecksNote", () => {
  it("is null when every check passed", () => {
    expect(meetingChecksNote({ passed: true, rounds: 0, verdicts: verdicts([]) })).toBeNull();
    expect(meetingChecksNote({ passed: true, rounds: 1, verdicts: verdicts([]) })).toBeNull();
  });

  it("is null for minutes saved before the checks existed", () => {
    expect(meetingChecksNote(undefined)).toBeNull();
    expect(meetingChecksNote(null)).toBeNull();
    expect(meetingChecksNote("passed")).toBeNull();
    expect(meetingChecksNote({})).toBeNull();
    expect(meetingChecksNote({ passed: false })).toBeNull();
    expect(meetingChecksNote({ passed: false, rounds: 1, verdicts: "none" })).toBeNull();
  });

  it("names each failed check once, in the order a reader should look", () => {
    const note = meetingChecksNote({
      passed: false,
      rounds: 1,
      verdicts: verdicts(["summary-present", "quoted-dates", "action-owners"]),
    });
    expect(note).toEqual({ failed: ["owners", "dates", "summary"] });
  });

  it("names the shape check too", () => {
    expect(meetingChecksNote({ passed: false, rounds: 1, verdicts: verdicts(["minutes-shape"]) })).toEqual({
      failed: ["shape"],
    });
  });

  it("names the evidence check, last: some items are not backed by the transcript", () => {
    expect(meetingChecksNote({ passed: false, rounds: 1, verdicts: verdicts(["minutes-evidence"]) })).toEqual({
      failed: ["evidence"],
    });
    expect(
      meetingChecksNote({ passed: false, rounds: 1, verdicts: verdicts(["minutes-evidence", "quoted-dates"]) }),
    ).toEqual({ failed: ["dates", "evidence"] });
  });

  it("ignores a check it has no words for, and a verdict that is not well formed", () => {
    const messy = {
      passed: false,
      rounds: 1,
      verdicts: [
        { check: "something-new", ok: false },
        null,
        { check: 7, ok: false },
        { check: "quoted-dates", ok: false },
      ],
    };
    expect(meetingChecksNote(messy)).toEqual({ failed: ["dates"] });
    expect(
      meetingChecksNote({ passed: false, rounds: 1, verdicts: [{ check: "something-new", ok: false }] }),
    ).toBeNull();
  });

  it("does not trust passed over the verdicts: a failed verdict is shown whatever the flag says", () => {
    expect(meetingChecksNote({ passed: true, rounds: 1, verdicts: verdicts(["quoted-dates"]) })).toEqual({
      failed: ["dates"],
    });
  });
});

describe("MeetingChecksNote", () => {
  it("renders nothing without a note", () => {
    expect(renderToStaticMarkup(<MeetingChecksNote note={null} />)).toBe("");
  });

  it("is a calm status that lists what failed in plain English", () => {
    applyLocale("en");
    const html = renderToStaticMarkup(<MeetingChecksNote note={{ failed: ["owners", "dates", "summary", "shape", "evidence"] }} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('data-testid="meeting-checks-note"');
    expect(html).not.toContain('role="alert"');
    expect(html).toContain("These minutes may need a second look");
    expect(html).toContain("The minutes are saved.");
    expect(html).toContain("Run again");
    for (const kind of ["owners", "dates", "summary", "shape", "evidence"]) {
      expect(html).toContain(`data-check="${kind}"`);
    }
    expect(html).toContain("owner the transcript never names");
    expect(html).toContain("date or time the transcript never says");
    expect(html).toContain("summary is empty");
    expect(html).toContain("not backed word for word by the transcript");
    // No raw key leaks into the page when a catalog string is missing.
    expect(html).not.toContain("meeting.checks");
  });

  it("says the same in Bahasa Indonesia", () => {
    applyLocale("id");
    const html = renderToStaticMarkup(<MeetingChecksNote note={{ failed: ["owners", "dates", "summary", "shape"] }} />);
    expect(html).toContain("Notulen ini mungkin perlu diperiksa lagi");
    expect(html).toContain("Notulen sudah tersimpan.");
    expect(html).toContain("Jalankan lagi");
    expect(html).toContain("tidak pernah disebut");
    expect(html).not.toContain("meeting.checks");
    expect(html).not.toContain("These minutes");
  });

  it("wraps long words instead of clipping them, so a narrow phone does not cut a line", () => {
    const html = renderToStaticMarkup(<MeetingChecksNote note={{ failed: ["owners"] }} />);
    expect(html).toContain("[overflow-wrap:anywhere]");
    expect(html).not.toContain("truncate");
  });
});

describe("MeetingMinutesPanel", () => {
  it("shows the note above the minutes when a check still failed after the repair", () => {
    applyLocale("en");
    const html = renderToStaticMarkup(
      <MeetingMinutesPanel
        record={{
          minutes: MINUTES,
          unverifiedNames: [],
          checks: { passed: false, rounds: 1, verdicts: verdicts(["quoted-dates"]) },
        }}
      />,
    );
    expect(html).toContain('data-testid="meeting-checks-note"');
    expect(html.indexOf("meeting-checks-note")).toBeLessThan(html.indexOf('data-testid="meeting-minutes"'));
    expect(html).toContain("Checkout weekly");
  });

  it("shows no note when the checks passed, or when the record has none", () => {
    for (const checks of [{ passed: true, rounds: 0, verdicts: verdicts([]) }, undefined, null]) {
      const html = renderToStaticMarkup(
        <MeetingMinutesPanel record={{ minutes: MINUTES, unverifiedNames: [], checks }} />,
      );
      expect(html).not.toContain("meeting-checks-note");
      expect(html).toContain('data-testid="meeting-minutes"');
    }
  });

  it("keeps the line about names the transcript never said", () => {
    applyLocale("en");
    const html = renderToStaticMarkup(
      <MeetingMinutesPanel record={{ minutes: MINUTES, unverifiedNames: ["Rudi"], checks: null }} />,
    );
    expect(html).toContain('data-testid="meeting-unverified"');
    expect(html).toContain("1 name(s) the transcript never said were removed");
  });
});
