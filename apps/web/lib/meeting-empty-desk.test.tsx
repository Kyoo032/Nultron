/**
 * An empty Meeting desk opens on the prompt box and shows the character once.
 *
 * 2026-09-29 sweep: the recordings list and the main pane both drew the character and both said the
 * "create one, add the recording" sentence. 2026-10-05, prompt first: the desk opens on the prompt box and
 * the drop zone, which say what to do, so the sentence is gone; the character sits under them, once, where
 * every other prompt-first desk puts it (`StudioEmptyDesk`). The list keeps one line, "No meetings yet.".
 *
 * The environment is node with no DOM: the studio is rendered to markup with its first state (no
 * meetings, none selected), which is the empty desk.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { MeetingStudio } from "@/components/meeting-studio";
import { applyLocale, resetLocaleForTests } from "./i18n";

const count = (html: string, needle: string) => html.split(needle).length - 1;

function emptyDesk(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <MeetingStudio />
    </MemoryRouter>,
  );
}

afterEach(() => resetLocaleForTests());

describe("the empty Meeting desk", () => {
  it("draws the character once, under the front door and the list", () => {
    const html = emptyDesk();
    expect(count(html, 'data-placement="empty"')).toBe(1);
    const list = html.slice(html.indexOf('data-testid="meeting-list"'));
    const afterList = list.slice(list.indexOf("</aside>"));
    expect(list.slice(0, list.indexOf("</aside>"))).not.toContain("chat-mascot");
    expect(afterList).toContain('data-testid="chat-mascot"');
  });

  it("opens on the prompt box, the drop zone and Run, with no form up front", () => {
    applyLocale("en");
    const html = emptyDesk();
    for (const id of ["meeting-prompt", "meeting-drop", "meeting-run", "meeting-more"]) {
      expect(html, id).toContain(`data-testid="${id}"`);
    }
    for (const id of ["meeting-title", "meeting-locale", "meeting-create"]) {
      // Present in the DOM under the closed More disclosure, never as a form of their own above it.
      expect(html.indexOf(`data-testid="${id}"`), id).toBeGreaterThan(html.indexOf('data-testid="meeting-more"'));
    }
    expect(html.indexOf('data-testid="meeting-prompt"')).toBeLessThan(html.indexOf('data-testid="meeting-more"'));
    expect(html).toContain("Minutes and who does what");
  });

  it("keeps the list's own line, and drops the old create-a-meeting sentence", () => {
    applyLocale("en");
    const html = emptyDesk();
    expect(html).toContain('data-testid="meeting-empty"');
    expect(html).toContain("No meetings yet.");
    expect(html).not.toContain("Create one, add the recording, and the minutes follow.");
  });

  it("does the same in Bahasa Indonesia", () => {
    applyLocale("id");
    const html = emptyDesk();
    expect(count(html, 'data-placement="empty"')).toBe(1);
    expect(html).toContain("Belum ada rapat.");
    expect(html).toContain("Notulen beserta siapa mengerjakan apa");
    expect(html).not.toContain("Buat satu, tambahkan rekamannya, dan notulen menyusul.");
  });

  it("offers no result tabs, no pencil and no translate button before there are minutes", () => {
    const html = emptyDesk();
    for (const id of ["meeting-tabs", "meeting-item-edit", "meeting-translate", "meeting-cancel"]) {
      expect(html, id).not.toContain(`data-testid="${id}"`);
    }
  });
});
