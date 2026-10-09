/**
 * Reading a `build_deck` call for the Chat card. Pure data in, plain data out, like `results.ts`.
 *
 * The tool's answer is `{ ok: true, artifactId, filename, slideCount }` or a refusal
 * `{ ok: false, reason, message }`. The outline is not in the answer: it is the tool's own input
 * (`{ title, slides }`), which the host stores with the call. So a card for a thread opened tomorrow is
 * rebuilt from the saved call alone, with no state held anywhere else. The input is parsed with the
 * renderer's copy of the outline schema, the one the Presentation studio uses, so a slide the model left
 * parts out of gets the same defaults it gets there. An input that does not parse leaves the card without
 * a preview; the download does not depend on it.
 */
import { presentationOutlineSchema, type PresentationOutline } from "@/lib/presentation-outline";
import { asRecord, readNumber, readString } from "./results";

export const DECK_TOOL_KEY = "build_deck";

export function isDeckTool(key: string): boolean {
  return key === DECK_TOOL_KEY;
}

export type DeckCardModel = {
  readonly artifactId: string;
  readonly filename: string;
  /** Slides in the file, the title slide included. */
  readonly slideCount: number;
  readonly title: string;
  /** Null when the call's input is not an outline this renderer can draw. */
  readonly outline: PresentationOutline | null;
};

function readOutline(input: unknown): PresentationOutline | null {
  const record = asRecord(input);
  if (!record) {
    return null;
  }
  const parsed = presentationOutlineSchema.safeParse({ title: record.title, slides: record.slides });
  return parsed.success ? parsed.data : null;
}

/** The card for one finished call, or null when it made no deck. */
export function readDeckResult(input: unknown, output: unknown): DeckCardModel | null {
  const result = asRecord(output);
  if (result?.ok !== true) {
    return null;
  }
  const artifactId = readString(result, "artifactId");
  const filename = readString(result, "filename");
  const slideCount = Number(result.slideCount);
  if (!artifactId || !filename || !Number.isFinite(slideCount) || slideCount < 1) {
    return null;
  }
  const outline = readOutline(input);
  const title = outline?.title ?? readString(asRecord(input), "title")?.trim() ?? filename;
  return { artifactId, filename, slideCount: Math.floor(slideCount), title: title || filename, outline };
}

/** What the Thinking row says about a finished call: the file's slide count. */
export function deckSlideCount(output: unknown): number | undefined {
  const record = asRecord(output);
  if (record?.ok !== true) {
    return undefined;
  }
  return readNumber(record, "slideCount");
}
