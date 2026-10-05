/**
 * The checks a Documents draft passes before the job is done (`runChecked`, one repair round).
 *
 * `structure` looks at the draft's own section model: it parses, no more sections than the prompt's
 * cap, at least as many as the brief lists as required, and each body is finished writing.
 * `grounding` reuses the overlap check behind `POST /documents/check` and runs only when the request
 * had source material. Both are pure and call no model.
 *
 * A verdict's wording is English and fixed: it is the repair note the model reads. The model's own
 * output language comes from the draft prompt, not from here.
 */
import { checkDraftAgainstSource } from "@agentforge/core";
import type { CheckVerdict, OutputCheck } from "@agentforge/core/harness";
import type { DocumentDraft } from "./document-outline";

/** The section ceiling `DOCUMENT_SYSTEM` states ("Default 5-8 sections (max 12)"). */
export const MAX_DOCUMENT_SECTIONS = 12;

/**
 * A body of fewer words is a label, not writing. The prompt asks for 2-4 short paragraphs or a tight
 * list; the starters' shortest body is 22 words, so four is far under anything a finished section has.
 */
export const MIN_SECTION_BODY_WORDS = 4;

/**
 * A section may not follow the source when at least `MIN_UNSUPPORTED_SENTENCES` of its checked
 * sentences are not in it, and those are at least `MIN_UNSUPPORTED_SHARE` of its checked sentences.
 *
 * The scale is `checkDraftAgainstSource`: a sentence is unsupported when fewer than 60% of its
 * content words (longer than three letters) occur in the source. Measured on a faithful paraphrase
 * of a source, sentences score 0.70 to 1.00. A sentence the writer adds (a recommendation, a link
 * between two facts) scores 0.33 to 0.50, and an invented one 0.00 to 0.25, so the sentence test
 * cannot tell advice from invention. The section rule is therefore deliberately slack: a draft mixes
 * source and synthesis, so only a section that is almost all unsupported (three in four, two of
 * two) is flagged. A section of two sentences in three, or half of one, is left alone.
 */
export const MIN_UNSUPPORTED_SENTENCES = 2;
export const MIN_UNSUPPORTED_SHARE = 0.75;

/** What a check reads: the parsed draft, or why the model's reply was not one. */
export type DocumentCheckInput = {
  readonly draft: DocumentDraft | null;
  readonly parseError: string | null;
};

export type DocumentCheckId = "structure" | "grounding";

const MAX_LISTED = 5;
const SENTENCE_CHARS = 140;
const HEADING_CHARS = 80;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function words(text: string): number {
  const flat = text.trim();
  return flat ? flat.split(/\s+/).length : 0;
}

// ---- the brief's own list of required sections -------------------------------------------------

const REQUIRED_MARKER = /(?:required\s+(?:sections|blocks)|bagian\s+wajib|blok\s+wajib)\s*(?:\([^)]*\))?\s*:/i;
/** An item is a short line. A longer gap means the list ended and a later "4." is something else. */
const MAX_ITEM_GAP = 300;

/**
 * How many numbered items the brief lists under "Required sections:" (or "Required blocks:", or the
 * Indonesian forms), or null when it lists none. The built-in template cards all use that shape.
 *
 * The Documents prompt box is a one-line input, so a pasted brief can arrive with its line breaks
 * gone ("...pick).2. Context..."): the count follows the numbers 1, 2, 3 in order, not the lines.
 */
export function requiredSectionCount(prompt: string): number | null {
  const marker = REQUIRED_MARKER.exec(prompt);
  if (!marker) {
    return null;
  }
  let position = marker.index + marker[0].length;
  let count = 0;
  for (;;) {
    const hit = findItemNumber(prompt, count + 1, position);
    if (!hit) {
      break;
    }
    const gap = prompt.slice(position, hit.index);
    if (gap.length > (count === 0 ? 20 : MAX_ITEM_GAP) || /\n\s*\n/.test(gap)) {
      break;
    }
    count += 1;
    position = hit.index + hit[0].length;
  }
  return count > 0 && count <= MAX_DOCUMENT_SECTIONS ? count : null;
}

/**
 * The next "N." or "N)" at or after `from`. It is not one when a digit, a colon or a dash sits right
 * before it ("0:05", "5-7") or a digit right after ("2.5"). A full stop before it is fine: that is
 * the end of the last item when a line break was lost in a one-line input.
 */
function findItemNumber(prompt: string, n: number, from: number): RegExpExecArray | null {
  const item = new RegExp(`${n}[.)](?!\\d)`, "g");
  item.lastIndex = from;
  for (let hit = item.exec(prompt); hit; hit = item.exec(prompt)) {
    if (hit.index === from || !/[\d:\u2013-]/.test(prompt.charAt(hit.index - 1))) {
      return hit;
    }
  }
  return null;
}

// ---- structure ---------------------------------------------------------------------------------

const FILLER = /\blorem ipsum\b|\breplace this paragraph\b/i;
const WHOLE_PLACEHOLDER = /^(?:tbd|todo|to be determined|n\/a|placeholder|\.{3}|…)[.!]?$/i;
const TBD = /\bTBD\b/;

function hasFiller(text: string, context: string): boolean {
  const flat = text.trim();
  if (FILLER.test(flat) || WHOLE_PLACEHOLDER.test(flat)) {
    return true;
  }
  // A brief or a source that itself says "TBD" makes the word a quote, not filler.
  return TBD.test(flat) && !TBD.test(context);
}

export type StructureIssue = string;

/** Every way the draft falls short of its own section model, in reading order. */
export function structureIssues(input: DocumentCheckInput, prompt: string, source: string): StructureIssue[] {
  const { draft } = input;
  if (!draft) {
    return [`The reply was not a document draft: ${input.parseError ?? "it could not be read as the JSON shape"}.`];
  }
  const issues: StructureIssue[] = [];
  const count = draft.sections.length;
  if (count > MAX_DOCUMENT_SECTIONS) {
    issues.push(`The draft has ${count} sections; the limit is ${MAX_DOCUMENT_SECTIONS}.`);
  }
  const required = requiredSectionCount(prompt);
  if (required !== null && count < required) {
    issues.push(`The brief lists ${required} required sections and the draft has ${count}.`);
  }
  const context = `${prompt}\n${source}`;
  draft.sections.forEach((section, index) => {
    const label = `Section ${index + 1} ("${clip(section.heading, HEADING_CHARS)}")`;
    if (!section.heading.trim()) {
      issues.push(`Section ${index + 1} has no heading.`);
    }
    if (!section.body.trim()) {
      issues.push(`${label} has an empty body.`);
    } else if (words(section.body) < MIN_SECTION_BODY_WORDS) {
      issues.push(`${label} is only ${words(section.body)} words, which is a label and not finished writing.`);
    } else if (hasFiller(section.body, context) || hasFiller(section.heading, context)) {
      issues.push(`${label} still holds placeholder text.`);
    }
  });
  return issues;
}

function listIssues(issues: readonly string[]): string {
  const shownIssues = issues.slice(0, MAX_LISTED);
  const more = issues.length - shownIssues.length;
  return [...shownIssues, ...(more > 0 ? [`...and ${more} more.`] : [])].join(" ");
}

export function structureCheck(prompt: string, source: string): OutputCheck<DocumentCheckInput> {
  return {
    id: "structure",
    run(input): CheckVerdict {
      const issues = structureIssues(input, prompt, source);
      if (issues.length === 0) {
        return { ok: true };
      }
      return {
        ok: false,
        check: "structure",
        error: listIssues(issues),
        why: "A document is done when it reads as the JSON draft and every section the brief asks for is present and written out. The host cannot preview or download anything less.",
        fix: 'Return the whole document again as one JSON object {"title": string, "sections": [{"heading": string, "body": string}]} with no markdown fences and no commentary. Include every required section, each written out as finished prose with no placeholders.',
      };
    },
  };
}

// ---- grounding ---------------------------------------------------------------------------------

export type UngroundedSection = {
  readonly sectionIndex: number;
  readonly heading: string;
  /** Sentences the overlap check looked at in this section. */
  readonly checked: number;
  readonly unsupported: number;
  /** The first sentence the source does not support. */
  readonly example: string;
};

/** The sections whose sentences mostly are not in the source. Empty without a source. */
export function findUngroundedSections(draft: DocumentDraft, source: string): UngroundedSection[] {
  const result = checkDraftAgainstSource(draft, source);
  if (!result.checked) {
    return [];
  }
  const flagged: UngroundedSection[] = [];
  draft.sections.forEach((section, sectionIndex) => {
    const mine = result.items.filter((item) => item.sectionIndex === sectionIndex);
    const unsupported = mine.filter((item) => !item.supported);
    if (unsupported.length >= MIN_UNSUPPORTED_SENTENCES && unsupported.length / mine.length >= MIN_UNSUPPORTED_SHARE) {
      flagged.push({
        sectionIndex,
        heading: section.heading,
        checked: mine.length,
        unsupported: unsupported.length,
        example: unsupported[0]?.sentence ?? "",
      });
    }
  });
  return flagged;
}

export function groundingCheck(source: string): OutputCheck<DocumentCheckInput> {
  return {
    id: "grounding",
    run({ draft }): CheckVerdict {
      if (!draft || !source.trim()) {
        return { ok: true };
      }
      const flagged = findUngroundedSections(draft, source);
      if (flagged.length === 0) {
        return { ok: true };
      }
      const lines = flagged
        .slice(0, MAX_LISTED)
        .map(
          (item) =>
            `Section ${item.sectionIndex + 1} ("${clip(item.heading, HEADING_CHARS)}"): ${item.unsupported} of ${item.checked} sentences are not in the source, for example "${clip(item.example, SENTENCE_CHARS)}"`,
        );
      const more = flagged.length - lines.length;
      return {
        ok: false,
        check: "grounding",
        error: `${flagged.length === 1 ? "A section does" : `${flagged.length} sections do`} not follow the source material. ${lines.join(". ")}.${more > 0 ? ` ...and ${more} more.` : ""}`,
        why: "The brief supplied source material, and the draft may use only that material for facts, figures, names and quotes. These sections state things the source does not contain.",
        fix: "Rewrite the listed sections using only facts, figures, names and quotes that appear in the source material. Delete any claim the source does not support, and where the source is silent say so in one sentence instead of filling the gap. Keep the other sections as they are and return the whole JSON document.",
      };
    },
  };
}

/** The checks one Documents request runs: structure always, grounding when it has a source. */
export function documentChecks(prompt: string, source: string): OutputCheck<DocumentCheckInput>[] {
  return source.trim() ? [structureCheck(prompt, source), groundingCheck(source)] : [structureCheck(prompt, source)];
}

// ---- what the response and the artifact carry --------------------------------------------------

export type DocumentCheckFailure = {
  readonly check: DocumentCheckId;
  readonly error: string;
  /** Zero-based sections the failure is about. Empty when it is about the draft as a whole. */
  readonly sections: readonly number[];
};

/** Attached to the response and the artifact's meta when a check still fails or a repair was spent. */
export type DocumentChecksReport = {
  readonly passed: boolean;
  /** Repair rounds spent. */
  readonly rounds: number;
  readonly failures: readonly DocumentCheckFailure[];
};

/**
 * The failing verdicts of the last check pass, with the sections each is about. Grounding is looked
 * up again from the draft (it is pure), because a verdict carries text and not section numbers.
 */
export function buildChecksReport(
  verdicts: readonly CheckVerdict[],
  rounds: number,
  draft: DocumentDraft | null,
  source: string,
): DocumentChecksReport {
  const failures: DocumentCheckFailure[] = [];
  for (const verdict of verdicts) {
    if (verdict.ok) {
      continue;
    }
    const check: DocumentCheckId = verdict.check === "grounding" ? "grounding" : "structure";
    const sections =
      check === "grounding" && draft ? findUngroundedSections(draft, source).map((item) => item.sectionIndex) : [];
    failures.push({ check, error: verdict.error, sections });
  }
  return { passed: failures.length === 0, rounds, failures };
}
