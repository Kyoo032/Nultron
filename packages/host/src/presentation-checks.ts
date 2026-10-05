/**
 * The structure checks a Nultron presentation outline must pass before it is called done.
 *
 * Each check is a pure function of the outline. `presentation-generate.ts` hands them to
 * `runChecked`, so a failure goes back to the model as an ERROR / WHY / FIX note naming the exact
 * slides, and what is still failing after the repair round travels to the studio as a short note
 * (`PresentationCheckNote`, a code and slide numbers, never English: the renderer writes the copy).
 *
 * Open Slide does not use these. Its deck is pages of free-placed blocks with no heading or
 * bullets, so "a title and a bullet" and "no shared title" have nothing to look at.
 *
 * Slide numbers are 1-based positions in `outline.slides`. The title slide is not in that list, so
 * the studio's filmstrip number for item `n` is `n + 1`.
 */
import type { OutputCheck } from "@agentforge/core/harness";
import {
  resolvePresentationSlideLayout,
  type PresentationOutline,
  type PresentationSlide,
} from "./presentation-outline";

/** The most content slides the outline prompt allows ("max 14"). The title slide is extra. */
export const MAX_OUTLINE_SLIDES = 14;

/** A request's total slide count, title slide included. Two is a title and one slide. */
export const MIN_REQUESTED_SLIDES = 2;
export const MAX_REQUESTED_SLIDES = MAX_OUTLINE_SLIDES + 1;

export type PresentationCheckCode = "slide_count" | "slide_content" | "duplicate_title" | "slide_fit";

/** What the studio is told about a check the outline still fails. Codes and numbers only. */
export type PresentationCheckNote = {
  readonly check: PresentationCheckCode;
  /** 1-based positions in `outline.slides`. Empty for `slide_count`. */
  readonly slides: number[];
  /** `slide_count` only: content slides asked for (absent when the request set none) and found. */
  readonly expected?: number;
  readonly found?: number;
};

/**
 * Geometry the exported slide assumes, from `addContentSlide` in `presentation-pptx.ts`: inches,
 * points, and the 12 pt gap after each bullet. If a box changes there, change it here.
 */
type Box = { readonly width: number; readonly height: number; readonly font: number; readonly bold?: boolean };

const BODY_GAP_IN = 12 / 72;
const BULLET_INDENT_IN = 0.25;
const BOX_INSET_IN = 0.2;
const REGULAR_EM = 0.5;
const BOLD_EM = 0.55;
const LINE_HEIGHT = 1.2;

const HEADING: Box = { width: 11.9, height: 0.85, font: 26, bold: true };
const SUBHEAD: Box = { width: 11.9, height: 0.4, font: 14 };
const SECTION_HEADING: Box = { width: 11.4, height: 1.6, font: 32, bold: true };
const SECTION_SUBHEAD: Box = { width: 11.4, height: 1.1, font: 18 };
const BODY: Box = { width: 11.7, height: 5.2, font: 16 };
const SPLIT_BODY: Box = { width: 6.6, height: 5.1, font: 16 };
const ASIDE: Box = { width: 4.4, height: 4.1, font: 16 };

function charsPerLine(box: Box, indent = 0): number {
  const glyph = (box.font * (box.bold ? BOLD_EM : REGULAR_EM)) / 72;
  return Math.max(1, Math.floor((box.width - BOX_INSET_IN - indent) / glyph));
}

function lineHeight(box: Box): number {
  return (box.font * LINE_HEIGHT) / 72;
}

function linesFor(text: string, perLine: number): number {
  return Math.max(1, Math.ceil(text.trim().length / perLine));
}

/** Text that runs more than half a line past what its box holds. */
function textOverflows(text: string, box: Box): boolean {
  if (!text.trim()) {
    return false;
  }
  const rows = Math.max(1, Math.round(box.height / lineHeight(box)));
  return linesFor(text, charsPerLine(box)) > rows;
}

function bulletsOverflow(bullets: readonly string[], box: Box): boolean {
  const shown = bullets.filter((bullet) => bullet.trim());
  if (shown.length === 0) {
    return false;
  }
  const perLine = charsPerLine(box, BULLET_INDENT_IN);
  const used = shown.reduce((sum, bullet) => sum + linesFor(bullet, perLine) * lineHeight(box), 0);
  return used + (shown.length - 1) * BODY_GAP_IN > box.height;
}

/** The parts of one slide that do not fit its exported box. The layout is the one the export draws. */
function overflowingParts(slide: PresentationSlide): string[] {
  const parts: string[] = [];
  const section = slide.kind === "section";
  if (textOverflows(slide.heading, section ? SECTION_HEADING : HEADING)) {
    parts.push("heading");
  }
  if (textOverflows(slide.subhead, section ? SECTION_SUBHEAD : SUBHEAD)) {
    parts.push("subhead");
  }
  if (bulletsOverflow(slide.bullets, slide.kind === "split" ? SPLIT_BODY : BODY)) {
    parts.push("bullets");
  }
  if (slide.kind === "split" && textOverflows(slide.aside, ASIDE)) {
    parts.push("aside");
  }
  return parts;
}

function hasBody(slide: PresentationSlide): boolean {
  return slide.bullets.some((bullet) => bullet.trim()) || Boolean(slide.subhead.trim()) || Boolean(slide.aside.trim());
}

function titleKey(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** What is wrong, with the English detail only the repair note reads. */
type Issue = PresentationCheckNote & { readonly detail: string[] };

function locate(outline: PresentationOutline, position: number): string {
  const heading = outline.slides[position - 1]?.heading.trim() ?? "";
  return heading ? `item ${position} of "slides" ("${heading}")` : `item ${position} of "slides"`;
}

function countIssue(outline: PresentationOutline, expected: number | null): Issue | null {
  const found = outline.slides.length;
  if (expected === null) {
    return found > MAX_OUTLINE_SLIDES ? { check: "slide_count", slides: [], found, detail: [] } : null;
  }
  return found === expected ? null : { check: "slide_count", slides: [], expected, found, detail: [] };
}

function contentIssue(outline: PresentationOutline): Issue | null {
  const slides: number[] = [];
  const detail: string[] = [];
  outline.slides.forEach((slide, index) => {
    const position = index + 1;
    if (!slide.heading.trim()) {
      slides.push(position);
      detail.push(`${locate(outline, position)} has no heading`);
    } else if (!hasBody(slide)) {
      slides.push(position);
      detail.push(`${locate(outline, position)} has no bullet or body text`);
    }
  });
  return slides.length > 0 ? { check: "slide_content", slides, detail } : null;
}

function duplicateIssue(outline: PresentationOutline): Issue | null {
  const groups = new Map<string, number[]>();
  outline.slides.forEach((slide, index) => {
    const key = titleKey(slide.heading);
    if (key) {
      groups.set(key, [...(groups.get(key) ?? []), index + 1]);
    }
  });
  const repeated = [...groups.values()].filter((positions) => positions.length > 1);
  if (repeated.length === 0) {
    return null;
  }
  return {
    check: "duplicate_title",
    slides: repeated.flat().sort((a, b) => a - b),
    detail: repeated.map(
      (positions) => `${positions.map((position) => locate(outline, position)).join(" and ")} share one heading`,
    ),
  };
}

function fitIssue(outline: PresentationOutline): Issue | null {
  const slides: number[] = [];
  const detail: string[] = [];
  outline.slides.forEach((_, index) => {
    const parts = overflowingParts(resolvePresentationSlideLayout(outline.slides, index));
    if (parts.length > 0) {
      slides.push(index + 1);
      detail.push(`${locate(outline, index + 1)}: ${parts.join(", ")}`);
    }
  });
  return slides.length > 0 ? { check: "slide_fit", slides, detail } : null;
}

/**
 * Every issue an outline has. `expected` is the number of content slides the request asked for
 * (`slideCount - 1`), or null when it set none.
 */
function findIssues(outline: PresentationOutline, expected: number | null): Issue[] {
  return [countIssue(outline, expected), contentIssue(outline), duplicateIssue(outline), fitIssue(outline)].filter(
    (issue): issue is Issue => issue !== null,
  );
}

/** The wire form of what an outline still fails: codes and slide numbers, no English. */
export function presentationCheckNotes(outline: PresentationOutline, expected: number | null): PresentationCheckNote[] {
  return findIssues(outline, expected).map(({ detail: _detail, ...note }) => note);
}

function verdictFor(issue: Issue, expected: number | null) {
  const { check, detail } = issue;
  if (check === "slide_count") {
    return expected === null
      ? {
          ok: false as const,
          check,
          error: `The outline has ${issue.found} slides, more than the ${MAX_OUTLINE_SLIDES} a deck may have.`,
          why: "Past that many slides the deck is too long to present and does not fit the way it is shown.",
          fix: `Return the whole outline with at most ${MAX_OUTLINE_SLIDES} items in "slides", merging or dropping the weakest.`,
        }
      : {
          ok: false as const,
          check,
          error: `The outline has ${issue.found} items in "slides", but the request asked for ${expected}.`,
          why: `The request asked for ${expected + 1} slides in total. The title slide is one of them and is not in "slides".`,
          fix: `Return the whole outline with exactly ${expected} items in "slides".`,
        };
  }
  if (check === "slide_content") {
    return {
      ok: false as const,
      check,
      error: `Slides with nothing to present: ${detail.join("; ")}.`,
      why: "A slide needs a heading and something under it, or it exports as an empty page.",
      fix: "Give each of those slides a heading and at least one bullet, subhead or aside, then return the whole outline.",
    };
  }
  if (check === "duplicate_title") {
    return {
      ok: false as const,
      check,
      error: `Slides share a heading: ${detail.join("; ")}.`,
      why: "Two slides with the same heading cannot be told apart in the filmstrip or when presenting.",
      fix: "Rewrite those headings so each makes its own claim, then return the whole outline.",
    };
  }
  return {
    ok: false as const,
    check,
    error: `Too much text to fit the exported slide: ${detail.join("; ")}.`,
    why: "The exported PowerPoint slide has fixed boxes, so extra text runs off the slide.",
    fix: "Shorten those parts (fewer or shorter bullets, a shorter heading) and return the whole outline.",
  };
}

function checkFor(code: PresentationCheckCode, expected: number | null): OutputCheck<PresentationOutline> {
  return {
    id: code,
    run: (outline) => {
      const issue = findIssues(outline, expected).find((item) => item.check === code);
      return issue ? verdictFor(issue, expected) : { ok: true };
    },
  };
}

/** The checks, in the order the repair note lists them. */
export function presentationChecks(expected: number | null): OutputCheck<PresentationOutline>[] {
  return (["slide_count", "slide_content", "duplicate_title", "slide_fit"] as const).map((code) =>
    checkFor(code, expected),
  );
}
