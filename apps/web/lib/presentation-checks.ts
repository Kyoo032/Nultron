import { t } from "@/lib/i18n";

/**
 * What the host says an outline still fails after its repair round (`presentation-checks.ts` in
 * `packages/host`). The wire carries codes and slide numbers only; the sentences are this catalog's.
 *
 * Slide numbers on the wire are 1-based positions in `outline.slides`. The title slide is not in that
 * list, so the number the filmstrip shows for item `n` is `n + 1`, and a total counts the title.
 */
export type PresentationCheckCode = "slide_count" | "slide_content" | "duplicate_title" | "slide_fit";

export type PresentationCheckNote = {
  check: PresentationCheckCode;
  slides: number[];
  /** `slide_count` only: content slides asked for (absent when no count was set) and found. */
  expected?: number;
  found?: number;
};

/** Mirrors `MIN_REQUESTED_SLIDES` / `MAX_REQUESTED_SLIDES` in the host: a total, title slide included. */
export const MIN_SLIDE_COUNT = 2;
export const MAX_SLIDE_COUNT = 15;

const CODES: readonly PresentationCheckCode[] = ["slide_count", "slide_content", "duplicate_title", "slide_fit"];

function isCode(value: unknown): value is PresentationCheckCode {
  return typeof value === "string" && (CODES as readonly string[]).includes(value);
}

function wholeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** The `checks` the host returned beside an outline. Anything unreadable is dropped, never shown. */
export function readOutlineChecks(data: unknown): PresentationCheckNote[] {
  const raw = data && typeof data === "object" ? (data as { checks?: unknown }).checks : undefined;
  if (!Array.isArray(raw)) {
    return [];
  }
  const notes: PresentationCheckNote[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const { check, slides, expected, found } = item as Record<string, unknown>;
    if (!isCode(check) || !Array.isArray(slides)) {
      continue;
    }
    const positions = slides.map(wholeNumber).filter((value): value is number => value !== undefined && value > 0);
    const asked = wholeNumber(expected);
    const got = wholeNumber(found);
    notes.push({
      check,
      slides: positions,
      ...(asked !== undefined ? { expected: asked } : {}),
      ...(got !== undefined ? { found: got } : {}),
    });
  }
  return notes;
}

/** One sentence for one note, in the desk's language, with slide numbers as the filmstrip shows them. */
export function presentationCheckLine(note: PresentationCheckNote): string {
  const slides = note.slides.map((position) => position + 1).join(", ");
  if (note.check === "slide_count") {
    const found = (note.found ?? 0) + 1;
    return note.expected === undefined
      ? t("presentation.checks.tooMany", { found, max: MAX_SLIDE_COUNT })
      : t("presentation.checks.slideCount", { expected: note.expected + 1, found });
  }
  if (note.check === "slide_content") {
    return t("presentation.checks.content", { slides });
  }
  if (note.check === "duplicate_title") {
    return t("presentation.checks.duplicate", { slides });
  }
  return t("presentation.checks.fit", { slides });
}

export type SlideCountInput = { value: number | null; invalid: boolean };

/**
 * The optional "exact number of slides" field. Empty is no count. A number outside the range is
 * invalid and is not sent, so a typo never turns into a 400 on Create.
 */
export function readSlideCountInput(text: string): SlideCountInput {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { value: null, invalid: false };
  }
  const value = /^\d{1,2}$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isInteger(value) || value < MIN_SLIDE_COUNT || value > MAX_SLIDE_COUNT) {
    return { value: null, invalid: true };
  }
  return { value, invalid: false };
}
