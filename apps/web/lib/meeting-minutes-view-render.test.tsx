/**
 * The minutes as the Minutes tab draws them (doc-flow, 2026-10-05): each decision and action item shows
 * the words behind it, says when the transcript does not back it, and can be edited in place.
 *
 * The environment is node with no DOM, so the view is rendered to markup with its first state (nothing
 * being edited). What pressing the pencil does is wiring in the component and is driven in a browser; the
 * request it makes and the diff it sends are pinned in `meeting-request.test.ts` and `meeting-edit.test.ts`.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { MeetingMinutes } from "@agentforge/core/meeting";
import { MeetingMinutesPanel } from "@/components/meeting-minutes-panel";
import { MeetingMinutesView } from "@/components/meeting-minutes-view";
import { applyLocale, resetLocaleForTests } from "./i18n";

const count = (html: string, needle: string) => html.split(needle).length - 1;

const MINUTES: MeetingMinutes = {
  title: "Checkout weekly",
  heldOn: "",
  summary: "The team agreed to ship the fix on Friday.",
  attendees: [{ name: "Rina", role: "" }],
  decisions: [
    {
      statement: "Ship the checkout fix on Friday",
      provisional: false,
      context: "After QA signs off",
      quote: "we ship the checkout fix on Friday",
      evidence: "verified",
    },
    {
      statement: "Move the review to Monday",
      provisional: true,
      context: "",
      quote: "maybe the review moves to Monday",
      evidence: "unverified",
      edited: true,
    },
  ],
  actionItems: [
    {
      task: "Send the budget",
      owner: "Dewi",
      due: "Friday",
      firstStep: "Open the sheet",
      quote: "Dewi will send the budget by Friday",
      evidence: "unverified",
    },
    { task: "Book the room", owner: "[needs owner]", due: "", firstStep: "", quote: "", evidence: "verified" },
  ],
  risks: [],
  openQuestions: [],
};

const EDITING = {
  disabled: false,
  clearsTranslation: false,
  onSave: async () => null,
};

afterEach(() => resetLocaleForTests());

describe("the quote behind each item", () => {
  it("is on every decision and action item that has one, closed until it is asked for", () => {
    applyLocale("en");
    const html = renderToStaticMarkup(<MeetingMinutesView minutes={MINUTES} testId="meeting-minutes" />);
    expect(count(html, 'data-testid="meeting-quote"')).toBe(3);
    expect(html).toContain("we ship the checkout fix on Friday");
    expect(html).toContain("Dewi will send the budget by Friday");
    expect(html).toContain("What was said");
    // A native disclosure: collapsed by default, no script needed to open it.
    expect(html).not.toMatch(/<details[^>]* open/);
  });

  it("has no quote control for an item that carries none (minutes saved before quotes existed)", () => {
    const html = renderToStaticMarkup(
      <MeetingMinutesView
        minutes={{
          ...MINUTES,
          decisions: [{ statement: "Old decision", provisional: false, context: "", quote: "" }],
          actionItems: [{ task: "Old task", owner: "Rina", due: "", firstStep: "", quote: "" }],
        }}
        testId="meeting-minutes"
      />,
    );
    expect(html).not.toContain('data-testid="meeting-quote"');
    expect(html).not.toContain("meeting-evidence-unverified");
    expect(html).toContain("Old decision");
    expect(html).toContain("Old task");
  });
});

describe("the unverified marker", () => {
  it("is on each item the code could not back, and not on a verified one", () => {
    applyLocale("en");
    const html = renderToStaticMarkup(<MeetingMinutesView minutes={MINUTES} testId="meeting-minutes" />);
    expect(count(html, 'data-testid="meeting-evidence-unverified"')).toBe(2);
    expect(html).toContain("Unverified");
    expect(html).toContain("The transcript does not back this item word for word.");
  });

  it("is said in Bahasa Indonesia too", () => {
    applyLocale("id");
    const html = renderToStaticMarkup(<MeetingMinutesView minutes={MINUTES} testId="meeting-minutes" />);
    expect(html).toContain("Belum terverifikasi");
    expect(html).toContain("Yang diucapkan");
    expect(html).not.toContain("meeting.evidence");
  });
});

describe("editing", () => {
  it("offers a pencil on every decision and action item when the minutes are editable", () => {
    applyLocale("en");
    const html = renderToStaticMarkup(
      <MeetingMinutesView minutes={MINUTES} testId="meeting-minutes" editing={EDITING} />,
    );
    expect(count(html, 'data-testid="meeting-item-edit"')).toBe(4);
    expect(html).toContain('aria-label="Edit this item"');
  });

  it("offers no pencil on a read-only view, such as the translation", () => {
    const html = renderToStaticMarkup(<MeetingMinutesView minutes={MINUTES} testId="meeting-translation" />);
    expect(html).not.toContain('data-testid="meeting-item-edit"');
  });

  it("locks the pencils while a job runs", () => {
    const html = renderToStaticMarkup(
      <MeetingMinutesView minutes={MINUTES} testId="meeting-minutes" editing={{ ...EDITING, disabled: true }} />,
    );
    expect(count(html, "disabled")).toBeGreaterThanOrEqual(4);
  });

  it("says an item was edited by the owner, only on an item that was", () => {
    applyLocale("en");
    const html = renderToStaticMarkup(<MeetingMinutesView minutes={MINUTES} testId="meeting-minutes" />);
    expect(count(html, 'data-testid="meeting-item-edited"')).toBe(1);
    expect(html).toContain("Edited by you");
  });

  it("says it in Bahasa Indonesia", () => {
    applyLocale("id");
    const html = renderToStaticMarkup(<MeetingMinutesView minutes={MINUTES} testId="meeting-minutes" />);
    expect(html).toContain("Diubah oleh Anda");
  });

  it("keeps the action table's columns and its owner marker", () => {
    applyLocale("en");
    const html = renderToStaticMarkup(<MeetingMinutesView minutes={MINUTES} testId="meeting-minutes" />);
    expect(html).toContain('data-testid="meeting-minutes-actions"');
    expect(html).toContain("[needs owner]");
    expect(html).toContain("Send the budget");
    expect(html).toContain("Open the sheet");
  });

  it("keys two items that read the same without dropping either", () => {
    const html = renderToStaticMarkup(
      <MeetingMinutesView
        minutes={{
          ...MINUTES,
          decisions: [
            { statement: "Ship", provisional: false, context: "", quote: "a" },
            { statement: "Ship", provisional: false, context: "", quote: "b" },
          ],
        }}
        testId="meeting-minutes"
      />,
    );
    expect(count(html, "Ship")).toBe(2);
  });
});

describe("MeetingMinutesPanel evidence line", () => {
  it("says every item is backed when all are, with the status for a driver to read", () => {
    applyLocale("en");
    const html = renderToStaticMarkup(
      <MeetingMinutesPanel
        record={{
          minutes: { ...MINUTES, decisions: MINUTES.decisions.slice(0, 1), actionItems: MINUTES.actionItems.slice(1) },
          unverifiedNames: [],
          checks: null,
        }}
      />,
    );
    expect(html).toContain('data-testid="meeting-minutes-evidence"');
    expect(html).toContain('data-status="verified"');
    expect(html).toContain("Every decision and action is backed by words in the transcript.");
  });

  it("counts what is not matched, and says where to look", () => {
    applyLocale("en");
    const html = renderToStaticMarkup(
      <MeetingMinutesPanel record={{ minutes: MINUTES, unverifiedNames: [], checks: null }} />,
    );
    expect(html).toContain('data-status="unverified"');
    expect(html).toContain("Checked against the transcript: 2 backed, 2 unverified.");
  });

  it("draws nothing for minutes with no verdicts", () => {
    const html = renderToStaticMarkup(
      <MeetingMinutesPanel
        record={{
          minutes: {
            ...MINUTES,
            decisions: [{ statement: "Old", provisional: false, context: "", quote: "" }],
            actionItems: [],
          },
          unverifiedNames: [],
          checks: null,
        }}
      />,
    );
    expect(html).not.toContain("meeting-minutes-evidence");
  });

  it("sits between the checks note and the minutes", () => {
    const html = renderToStaticMarkup(
      <MeetingMinutesPanel
        record={{
          minutes: MINUTES,
          unverifiedNames: [],
          checks: { passed: false, rounds: 1, verdicts: [{ check: "minutes-evidence", ok: false }] },
        }}
      />,
    );
    const note = html.indexOf('data-testid="meeting-checks-note"');
    const evidence = html.indexOf('data-testid="meeting-minutes-evidence"');
    const minutes = html.indexOf('data-testid="meeting-minutes"');
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(evidence);
    expect(evidence).toBeLessThan(minutes);
    expect(html).toContain('data-check="evidence"');
  });
});
