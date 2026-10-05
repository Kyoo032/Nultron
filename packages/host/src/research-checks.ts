/**
 * Checks on the Research synthesis: a dossier is not done when the model has written findings, it
 * is done when these pass. Each check is a pure function of the parsed synthesis; a failure is the
 * ERROR / WHY / FIX note `runChecked` hands back to the model for one repair round.
 *
 * Output language is not checked. No language detector exists in the repo (the only language
 * handling is the instruction `withOutputLanguage` appends to the prompt), and this file does not
 * invent one. The verdicts hold section excerpts and source ids only, never a whole body.
 */
import type { AppLocale } from "@agentforge/core";
import type { CheckVerdict } from "@agentforge/core/harness";

export type SectionKind = "summary" | "finding" | "contradiction" | "openQuestion";

/** Where in the model's answer something sits. `excerpt` is the finding heading or the first words of the text. */
export type SectionRef = { readonly kind: SectionKind; readonly excerpt: string };

/** A source id the model cited that no source of this run carries. `parseSynthesis` counts it instead of dropping it. */
export type UnknownCitation = { readonly section: SectionRef; readonly id: string };

/** What the checks read. `Synthesis` in `research-dossier.ts` satisfies it. */
export type SynthesisDraft = {
  readonly summary: string;
  readonly findings: ReadonlyArray<{
    readonly heading: string;
    readonly body: string;
    readonly sources: readonly string[];
  }>;
  /** 1-based positions, in the model's findings list, of findings dropped for an empty heading or body. */
  readonly emptyFindings: readonly number[];
  readonly unknownCitations: readonly UnknownCitation[];
  /** Every source id the model was shown, and so every id it may cite. */
  readonly sourceIds: readonly string[];
};

/** An `OutputCheck` that answers at once, so a test can read the verdict without awaiting it. */
export type SynthesisCheck = { readonly id: string; run(draft: SynthesisDraft): CheckVerdict };

export const RESEARCH_CHECK_IDS = {
  resolve: "research-citations-resolve",
  cited: "research-findings-cited",
  filled: "research-sections-filled",
} as const;

/** The checks outcome that travels with the dossier (artifact meta and the job result). */
export type ResearchChecksReport = {
  readonly passed: boolean;
  /** Repair rounds spent. 0 when the first synthesis passed. */
  readonly rounds: number;
  readonly verdicts: readonly CheckVerdict[];
  /** Error code of a repair call that gave nothing usable; the earlier answer was kept. */
  readonly repairFailure?: string;
};

/** Shown beside "Round 1 of 1" while the synthesis is repaired. Host-side copy, like the phase labels. */
const REPAIR_ROUND_LABEL: Readonly<Record<AppLocale, string>> = {
  en: "Repairing the findings",
  id: "Memperbaiki temuan",
};

export function repairRoundLabel(locale: AppLocale): string {
  return REPAIR_ROUND_LABEL[locale] ?? REPAIR_ROUND_LABEL.en;
}

const EXCERPT_MAX = 60;
const LIST_MAX = 8;
const ID_MAX = 24;

export function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_MAX ? `${flat.slice(0, EXCERPT_MAX - 1)}…` : flat;
}

export function shortId(id: string): string {
  return id.length > ID_MAX ? id.slice(0, ID_MAX) : id;
}

function sectionLabel(ref: SectionRef): string {
  switch (ref.kind) {
    case "summary":
      return "the summary";
    case "finding":
      return `finding "${ref.excerpt}"`;
    case "contradiction":
      return `contradiction "${ref.excerpt}"`;
    case "openQuestion":
      return `open question "${ref.excerpt}"`;
  }
}

function listCapped(items: readonly string[]): string {
  if (items.length <= LIST_MAX) {
    return items.join("; ");
  }
  return `${items.slice(0, LIST_MAX).join("; ")}; and ${items.length - LIST_MAX} more`;
}

function allowedIds(draft: SynthesisDraft): string {
  return draft.sourceIds.join(", ");
}

function failure(check: string, error: string, why: string, fix: string): CheckVerdict {
  return { ok: false, check, error, why, fix };
}

/** (b) Every citation resolves to a source the run was given. */
const citationsResolve: SynthesisCheck = {
  id: RESEARCH_CHECK_IDS.resolve,
  run(draft) {
    if (draft.unknownCitations.length === 0) {
      return { ok: true };
    }
    const byLabel = new Map<string, string[]>();
    for (const { section, id } of draft.unknownCitations) {
      const label = sectionLabel(section);
      byLabel.set(label, [...(byLabel.get(label) ?? []), id]);
    }
    const where = [...byLabel].map(([label, ids]) => `${ids.join(", ")} in ${label}`);
    return failure(
      RESEARCH_CHECK_IDS.resolve,
      `The answer cites source ids that do not exist: ${listCapped(where)}.`,
      "Only the numbered sources in the prompt were read. A citation to any other id points at nothing, so the reader cannot check the claim.",
      `Sections to fix: ${listCapped([...byLabel.keys()])}. Replace each unknown id with an allowed id that supports the claim, or delete the claim. Allowed source ids: ${allowedIds(draft)}.`,
    );
  },
};

/** (a) Every finding carries at least one citation that resolves. */
const findingsCited: SynthesisCheck = {
  id: RESEARCH_CHECK_IDS.cited,
  run(draft) {
    const uncited = draft.findings.filter((finding) => finding.sources.length === 0);
    if (uncited.length === 0) {
      return { ok: true };
    }
    const labels = uncited.map((finding) => sectionLabel({ kind: "finding", excerpt: excerptOf(finding.heading) }));
    const noun = uncited.length === 1 ? "finding cites" : "findings cite";
    return failure(
      RESEARCH_CHECK_IDS.cited,
      `${uncited.length} ${noun} no source: ${listCapped(labels)}.`,
      "A finding states a fact. Without a source id the reader cannot tell where it came from.",
      `Sections to fix: ${listCapped(labels)}. Put [Sn] inside each body and list the same ids in "sources", using only ${allowedIds(draft)}. If no source supports a finding, remove it.`,
    );
  },
};

/** (c) No section is empty: the summary has text and no finding was dropped for an empty heading or body. */
const sectionsFilled: SynthesisCheck = {
  id: RESEARCH_CHECK_IDS.filled,
  run(draft) {
    const errors: string[] = [];
    const sections: string[] = [];
    const fixes: string[] = [];
    if (draft.summary.trim() === "") {
      errors.push("the summary is empty");
      sections.push("the summary");
      fixes.push(
        "Write the summary: the argument in 8 to 12 lines, then a confidence (high, med or low) and what evidence is thin.",
      );
    }
    if (draft.emptyFindings.length > 0) {
      const noun = draft.emptyFindings.length === 1 ? "finding has" : "findings have";
      errors.push(`${draft.emptyFindings.length} ${noun} an empty heading or body`);
      sections.push(...draft.emptyFindings.map((position) => `finding ${position} of your findings list`));
      fixes.push("Give every finding a heading and a body, or remove it.");
    }
    if (errors.length === 0) {
      return { ok: true };
    }
    return failure(
      RESEARCH_CHECK_IDS.filled,
      `${errors.join("; ")}.`,
      "A section with nothing in it is a missing part of the answer, not a short one.",
      `Sections to fix: ${listCapped(sections)}. ${fixes.join(" ")}`,
    );
  },
};

/** In the order the repair note lists them: a fabricated id first, then a missing one, then an empty section. */
export const RESEARCH_SYNTHESIS_CHECKS: readonly SynthesisCheck[] = Object.freeze([
  citationsResolve,
  findingsCited,
  sectionsFilled,
]);
