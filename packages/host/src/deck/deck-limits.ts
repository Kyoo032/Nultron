/**
 * The limits `build_deck` enforces, and the way it says so.
 *
 * `deck-schema.ts` sets no ceiling (an argument the SDK refuses ends the whole turn), so every ceiling
 * is read here, from the text after it has been cleaned: characters XML cannot hold are removed, the
 * ends are trimmed, and a bullet that was only blank is dropped. A refusal is a string for the model,
 * in English, that names the field by its path in the call (`slides[1].notes`), the limit and what was
 * sent, for every overrun at once, so one corrected call is enough.
 */
import { stripXmlIllegalChars } from "../xml-text";
import {
  DECK_ASIDE_MAX_CHARS,
  DECK_BULLET_MAX_CHARS,
  DECK_BULLETS_MAX,
  DECK_HEADING_MAX_CHARS,
  DECK_MAX_SLIDES,
  DECK_NOTES_MAX_CHARS,
  DECK_SUBHEAD_MAX_CHARS,
  DECK_TITLE_MAX_CHARS,
  type BuildDeckInput,
} from "./deck-schema";

/** How many problems one refusal lists; the rest are counted, so the answer stays short. */
export const DECK_PROBLEMS_LISTED = 10;

type DeckSlide = BuildDeckInput["slides"][number];

function clean(text: unknown): string {
  return typeof text === "string" ? stripXmlIllegalChars(text).trim() : "";
}

/** A copy of the call with every text cleaned. The call itself is never changed. */
export function cleanDeckInput(input: BuildDeckInput): BuildDeckInput {
  const slides: readonly DeckSlide[] = Array.isArray(input.slides) ? input.slides : [];
  return {
    title: clean(input.title),
    slides: slides.map((slide) => ({
      kind: slide.kind,
      heading: clean(slide.heading),
      subhead: clean(slide.subhead),
      bullets: (Array.isArray(slide.bullets) ? slide.bullets : []).map(clean).filter((bullet) => bullet.length > 0),
      aside: clean(slide.aside),
      notes: clean(slide.notes),
    })),
  };
}

function overText(path: string, text: string, limit: number): string | null {
  return text.length > limit ? `${path} is ${text.length} characters; the limit is ${limit}` : null;
}

function slideProblems(slide: DeckSlide, index: number): string[] {
  const at = `slides[${index}]`;
  const found: Array<string | null> = [
    slide.heading
      ? overText(`${at}.heading`, slide.heading, DECK_HEADING_MAX_CHARS)
      : `${at}.heading is empty; every slide needs a heading`,
    overText(`${at}.subhead`, slide.subhead, DECK_SUBHEAD_MAX_CHARS),
    overText(`${at}.aside`, slide.aside, DECK_ASIDE_MAX_CHARS),
    overText(`${at}.notes`, slide.notes, DECK_NOTES_MAX_CHARS),
    slide.bullets.length > DECK_BULLETS_MAX
      ? `${at}.bullets has ${slide.bullets.length} items; the limit is ${DECK_BULLETS_MAX}`
      : null,
    ...slide.bullets.map((bullet, position) => overText(`${at}.bullets[${position}]`, bullet, DECK_BULLET_MAX_CHARS)),
  ];
  return found.filter((problem): problem is string => problem !== null);
}

/** Every limit the cleaned call breaks, in the order a reader meets them. Empty when it breaks none. */
export function deckLimitProblems(deck: BuildDeckInput): string[] {
  const problems: string[] = [];
  const titleProblem = deck.title
    ? overText("title", deck.title, DECK_TITLE_MAX_CHARS)
    : "title is empty; give the deck a title";
  if (titleProblem) {
    problems.push(titleProblem);
  }
  if (deck.slides.length === 0) {
    problems.push("slides is empty; send at least one slide");
  } else if (deck.slides.length > DECK_MAX_SLIDES) {
    problems.push(`slides has ${deck.slides.length} items; the limit is ${DECK_MAX_SLIDES}`);
  }
  deck.slides.forEach((slide, index) => {
    problems.push(...slideProblems(slide, index));
  });
  return problems;
}

/** The refusal the model reads. */
export function formatDeckLimitProblems(problems: readonly string[]): string {
  const listed = problems.slice(0, DECK_PROBLEMS_LISTED).map((problem) => `- ${problem}`);
  const rest = problems.length - listed.length;
  return [
    "The deck was not saved: part of it is over a limit or empty.",
    ...listed,
    ...(rest > 0 ? [`- and ${rest} more`] : []),
    "Shorten or fill in each one, then call build_deck again with the whole outline.",
  ].join("\n");
}
