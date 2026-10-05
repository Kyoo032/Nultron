/**
 * Education's Show task with no lesson says what to do and offers the way there.
 *
 * `40c8ef1` (2026-09-27) took the empty-desk blocks out of the studio and, with them, the only reader
 * of `education.presenterHint`. `/education?task=show` on a fresh desk then drew the header line
 * "Show the lesson with a voice.", the change link and an empty More, with no button and no word
 * that a lesson comes first (finding, `unreleased.md` 2026-10-01).
 *
 * The environment is node with no DOM: the studio is rendered to markup at its first state, which
 * is a desk with no lesson, no quiz and nothing read.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { EducationStudio } from "@/components/education-studio";
import enEducation from "../locales/en/education.json";
import idEducation from "../locales/id/education.json";
import { applyLocale, resetLocaleForTests } from "./i18n";

function desk(search: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/education${search}`]}>
      <EducationStudio />
    </MemoryRouter>,
  );
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

afterEach(() => resetLocaleForTests());

describe("Show with no lesson", () => {
  it("tells the reader to create a lesson first, in English", () => {
    applyLocale("en");
    const html = desk("?task=show");
    expect(html).toContain('data-testid="education-presenter-needs-lesson"');
    expect(html).toContain(enEducation.presenterHint);
    expect(html).toContain(">Create a lesson<");
  });

  it("offers a primary action that goes to the lesson task", () => {
    applyLocale("en");
    const html = desk("?task=show");
    const link = html.match(/<a [^>]*data-testid="education-presenter-create-lesson"[^>]*>/)?.[0] ?? "";
    expect(link).toContain('href="/education?task=lesson"');
    expect(link).toContain("btn-primary");
  });

  it("says the same in Bahasa Indonesia", () => {
    applyLocale("id");
    const html = desk("?task=show");
    expect(html).toContain(idEducation.presenterHint);
    expect(html).toContain(">Buat pelajaran<");
    expect(html).not.toContain(enEducation.presenterHint);
  });

  it("leaves no empty More and no empty prompt strip under it", () => {
    applyLocale("en");
    const html = desk("?task=show");
    expect(html).not.toContain('data-testid="education-more"');
    expect(html).not.toContain("sticky top-0");
    // No lesson, so no way to build a presenter plan yet.
    expect(html).not.toContain('data-testid="education-presenter-build"');
    expect(count(html, "education-presenter-needs-lesson")).toBe(1);
  });

  it("keeps the way back to the chooser", () => {
    expect(desk("?task=show")).toContain('data-testid="education-guide-change"');
  });
});

describe("Show with a lesson in memory", () => {
  // A lesson lives in component state, which a server render cannot set, so the gating is read from
  // the source: the prompt is the answer only when there is neither a plan nor a lesson, and the
  // prompt strip then still draws the one primary button.
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../components/education-studio.tsx"),
    "utf8",
  ).replace(/\s+/g, " ");

  it("shows the prompt only when there is no plan and no lesson", () => {
    expect(source).toContain(") : outline ? null : ( <PresenterNeedsLesson /> )");
  });

  it("keeps the build button for a lesson without a plan, and More only when it holds something", () => {
    expect(source).toContain('(task === "show" && Boolean(outline) && !presenter)');
    expect(source).toContain("const hasMore = Boolean(outline) ||");
    expect(source).toContain("{hasMore ? (");
    expect(source).toContain("{hasPromptBar ? (");
  });
});

describe("the other education desks are unchanged by it", () => {
  it("does not show the lesson prompt on the other tasks", () => {
    for (const task of ["lesson", "quiz", "page"]) {
      expect(desk(`?task=${task}`), task).not.toContain("education-presenter-needs-lesson");
    }
    expect(desk("")).not.toContain("education-presenter-needs-lesson");
  });

  it("still draws each task's own first control", () => {
    expect(desk("?task=lesson")).toContain('data-testid="education-lesson-topic"');
    expect(desk("?task=quiz")).toContain('data-testid="education-exam-topic"');
    expect(desk("?task=page")).toContain('data-testid="education-book-file"');
  });

  it("does not draw an empty More before there is anything to put in it", () => {
    for (const task of ["lesson", "quiz", "page"]) {
      expect(desk(`?task=${task}`), task).not.toContain('data-testid="education-more"');
    }
  });

  it("unknown task is still the lesson", () => {
    const html = desk("?task=nope");
    expect(html).toContain('data-testid="education-lesson-topic"');
    expect(html).not.toContain("education-presenter-needs-lesson");
  });
});
