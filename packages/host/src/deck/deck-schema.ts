/**
 * What the model hands `build_deck`: a title and the slides it wrote.
 *
 * It is the outline the Presentation mode already validates (`presentation-outline.ts`), cut down to
 * the parts a model should author. Shapes and layouts are not here: a layout is chosen by the export
 * and a shape is something a person draws.
 *
 * **This schema sets no ceiling.** The AI SDK checks a tool call's arguments against it before
 * `execute` runs, and an argument that fails there ends the whole turn as `run.failed`: the person sees
 * an error and no deck, and the model is never told what was wrong. A model cannot count characters, so
 * a 2,100-character note is an ordinary mistake, and it has to come back as a tool result the model can
 * read. So the schema keeps the shape (a title, a list of slides, a heading on each) and says every
 * limit in words, in the field descriptions the model reads; the numbers below are enforced by
 * `deck-limits.ts`, inside `buildDeckForTenant`, which answers a refusal that names the field, the
 * limit and what was sent. The ceilings sit well above what the outline prompt asks for (a heading of 6
 * to 14 words, 3 to 5 bullets of 10 to 22 words, notes of 40 to 90 words), so one call cannot carry a
 * megabyte of notes and a careful model never meets them.
 *
 * The Zod defaults make the parsed value a complete outline slide, so the tool needs no second shape.
 * A slide kind the model invents reads as `bullets`, as it does in the Presentation mode.
 */
import { z } from "zod";
import { ARTIFACT_TITLE_MAX } from "../artifacts";
import { MAX_OUTLINE_SLIDES } from "../presentation-checks";

/** Content slides, not counting the title slide the export adds from `title`. */
export const DECK_MAX_SLIDES = MAX_OUTLINE_SLIDES;
export const DECK_TITLE_MAX_CHARS = ARTIFACT_TITLE_MAX;
export const DECK_HEADING_MAX_CHARS = 200;
export const DECK_SUBHEAD_MAX_CHARS = 300;
export const DECK_BULLET_MAX_CHARS = 400;
export const DECK_BULLETS_MAX = 12;
export const DECK_ASIDE_MAX_CHARS = 600;
export const DECK_NOTES_MAX_CHARS = 2000;

const slideSchema = z.object({
  kind: z
    .enum(["section", "bullets", "split", "close"])
    .catch("bullets")
    .default("bullets")
    .describe(
      "section opens a part, bullets is the normal slide, split puts a short aside beside the bullets, close ends the deck",
    ),
  heading: z.string().describe(`The slide's claim, as a short sentence (at most ${DECK_HEADING_MAX_CHARS} characters)`),
  subhead: z.string().default("").describe(`One line under the heading (at most ${DECK_SUBHEAD_MAX_CHARS} characters)`),
  bullets: z
    .array(z.string())
    .default([])
    .describe(
      `Three to five short points: at most ${DECK_BULLETS_MAX}, each at most ${DECK_BULLET_MAX_CHARS} characters`,
    ),
  aside: z
    .string()
    .default("")
    .describe(`Only for a split slide: the short callout (at most ${DECK_ASIDE_MAX_CHARS} characters)`),
  notes: z
    .string()
    .default("")
    .describe(`What the presenter says on this slide (at most ${DECK_NOTES_MAX_CHARS} characters)`),
});

export const buildDeckInputSchema = z.object({
  title: z.string().describe(`The deck's title, shown on the first slide (at most ${DECK_TITLE_MAX_CHARS} characters)`),
  slides: z
    .array(slideSchema)
    .describe(`One to ${DECK_MAX_SLIDES} slides after the title slide, in the order they are shown`),
});

export type BuildDeckInput = z.infer<typeof buildDeckInputSchema>;
