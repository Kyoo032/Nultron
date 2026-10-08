/**
 * The inline form for one decision or action item. State changes (typing, Save's round trip) are driven in a
 * browser; here is what the form shows when it opens: the item's own words, Save only when the required
 * fields have words, the note about the translation, and the same in Bahasa Indonesia.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MeetingActionItem, MeetingDecision } from "@agentforge/core/meeting";
import { ActionEditor, DecisionEditor } from "@/components/meeting-item-editor";
import { applyLocale, resetLocaleForTests } from "./i18n";

const decision: MeetingDecision = {
  statement: "Ship the checkout fix on Friday",
  provisional: true,
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

const handlers = { onSave: vi.fn(async () => null), onClose: vi.fn() };

afterEach(() => resetLocaleForTests());

describe("DecisionEditor", () => {
  it("opens on the decision's own words, with Save and Cancel and no request made yet", () => {
    applyLocale("en");
    const html = renderToStaticMarkup(
      <DecisionEditor index={0} item={decision} clearsTranslation={false} {...handlers} />,
    );
    for (const id of [
      "meeting-item-form",
      "meeting-edit-statement",
      "meeting-edit-context",
      "meeting-edit-provisional",
      "meeting-edit-save",
      "meeting-edit-cancel",
    ]) {
      expect(html, id).toContain(`data-testid="${id}"`);
    }
    expect(html).toContain("Ship the checkout fix on Friday");
    expect(html).toContain("After QA");
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""/);
    expect(handlers.onSave).not.toHaveBeenCalled();
  });

  it("does not offer the quote or the evidence for editing: they stay the transcript's own", () => {
    const html = renderToStaticMarkup(
      <DecisionEditor index={0} item={decision} clearsTranslation={false} {...handlers} />,
    );
    expect(html).not.toContain("we ship on Friday");
    expect(html).not.toContain("edit-quote");
    expect(html).not.toContain("edit-evidence");
  });

  it("holds Save back while the decision has no words", () => {
    const html = renderToStaticMarkup(
      <DecisionEditor index={0} item={{ ...decision, statement: "  " }} clearsTranslation={false} {...handlers} />,
    );
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*data-testid="meeting-edit-save"/);
  });

  it("says saving clears the translation, only when there is one", () => {
    applyLocale("en");
    const withTranslation = renderToStaticMarkup(
      <DecisionEditor index={0} item={decision} clearsTranslation {...handlers} />,
    );
    const without = renderToStaticMarkup(
      <DecisionEditor index={0} item={decision} clearsTranslation={false} {...handlers} />,
    );
    expect(withTranslation).toContain('data-testid="meeting-edit-clears-translation"');
    expect(withTranslation).toContain("Saving clears the translation");
    expect(without).not.toContain("meeting-edit-clears-translation");
  });

  it("says that editing is free", () => {
    applyLocale("en");
    expect(
      renderToStaticMarkup(<DecisionEditor index={0} item={decision} clearsTranslation={false} {...handlers} />),
    ).toContain("Editing is free.");
  });
});

describe("ActionEditor", () => {
  it("opens on the action's own fields", () => {
    applyLocale("en");
    const html = renderToStaticMarkup(<ActionEditor index={1} item={action} clearsTranslation={false} {...handlers} />);
    for (const id of [
      "meeting-edit-task",
      "meeting-edit-owner",
      "meeting-edit-due",
      "meeting-edit-first-step",
      "meeting-edit-save",
    ]) {
      expect(html, id).toContain(`data-testid="${id}"`);
    }
    for (const words of ["Send the budget", "Dewi", "Friday", "Open the sheet"]) {
      expect(html, words).toContain(words);
    }
  });

  it("holds Save back while the task or the owner is empty", () => {
    for (const blank of [{ task: "" }, { owner: " " }]) {
      const html = renderToStaticMarkup(
        <ActionEditor index={1} item={{ ...action, ...blank }} clearsTranslation={false} {...handlers} />,
      );
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="meeting-edit-save"/);
    }
  });

  it("says it in Bahasa Indonesia", () => {
    applyLocale("id");
    const html = renderToStaticMarkup(<ActionEditor index={1} item={action} clearsTranslation {...handlers} />);
    expect(html).toContain("Penanggung jawab");
    expect(html).toContain("Simpan");
    expect(html).toContain("Menyimpan menghapus terjemahan");
    expect(html).not.toContain("meeting.edit");
  });
});
