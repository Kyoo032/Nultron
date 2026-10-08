/**
 * The five checks an extraction must pass (docs/internal/doc-flow-plan.md section 2), built from the shared
 * judges in `@agentforge/core/judges` and plugged into `runChecked`:
 *
 *   legal-shape     every answer parsed, every found item has a value, a 12-400 character quote and a real file id
 *   legal-quotes    every quote is in the files (the file the model named, or any other)
 *   legal-values    the figures and dates a value states are the ones the quoted passage states
 *   legal-coverage  every fixed field and every file has an entry (not stated is an answer; silence is the gap)
 *   legal-scope     no advice, and no statute the files do not cite
 *
 * Conflicts between files are not a check: they are reported, never repaired (`findConflicts`).
 *
 * The checks judge the merged answer, item by item, and remember which call each failing item came from so
 * the one repair goes only to the calls that need it. They never keep model text beyond the repair note.
 */
import { coverageGaps, datesTraced, numbersTraced, scopeHits } from "@agentforge/core/judges";
import {
  LEGAL_FACT_FIELDS,
  LEGAL_QUOTE_MAX_CHARS,
  LEGAL_QUOTE_MIN_CHARS,
  LEGAL_NOTABLE_FIELD,
} from "@agentforge/core/legal";
import type { AppLocale } from "@agentforge/core";
import { type CallChecks, type CheckDef, type Judged, createCallChecks } from "./call-checks";
import type { Evidence, VerifiedQuote } from "./evidence";
import { type CallOutput, type MergedExtract, mergeCallOutputs } from "./extract-merge";

export const EXTRACT_CHECK_IDS = [
  "legal-shape",
  "legal-quotes",
  "legal-values",
  "legal-coverage",
  "legal-scope",
] as const;

export type { Judged };

/** The five checks over the calls' answers, with the bookkeeping for the targeted repair. */
export type ExtractChecks = CallChecks<readonly CallOutput[]>;

export type ExtractChecksContext = {
  readonly evidence: Evidence;
  readonly locale: AppLocale;
};

const QUOTE_WINDOW_CHARS = 240;
const FLAG_WINDOW_CHARS = 600;
const PREVIEW_CHARS = 70;
const ANSWER_ID = "answer";
const FIXED_FIELDS: readonly string[] = LEGAL_FACT_FIELDS;

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}...` : flat;
}

function fail(id: string, call: number, problem: string): Judged {
  return { id, call, ok: false, problem };
}

// -- shape -------------------------------------------------------------------------------------------

function quoteShapeProblem(quote: string, docId: string, evidence: Evidence): string | null {
  const length = quote.trim().length;
  if (length < LEGAL_QUOTE_MIN_CHARS || length > LEGAL_QUOTE_MAX_CHARS) {
    return `the quote must be ${LEGAL_QUOTE_MIN_CHARS} to ${LEGAL_QUOTE_MAX_CHARS} characters (it is ${length})`;
  }
  if (!evidence.hasDoc(docId)) {
    return `docId "${docId}" is not one of the files (${evidence.docIds.join(", ")})`;
  }
  return null;
}

function shapeJudgements(outputs: readonly CallOutput[], merged: MergedExtract, evidence: Evidence): Judged[] {
  const unreadable = outputs
    .filter((output) => output.response === null)
    .map((output) =>
      fail(ANSWER_ID, output.index, output.problem ?? "the answer was not valid JSON in the required shape"),
    );
  const facts = merged.facts.flatMap((fact): Judged[] => {
    if (fact.status !== "found") {
      return [];
    }
    const problem =
      fact.value === ""
        ? "marked found but the value is empty (use status missing if the files do not state it)"
        : quoteShapeProblem(fact.quote, fact.docId, evidence);
    return problem ? [fail(fact.id, fact.call, problem)] : [];
  });
  const flags = merged.redFlags.flatMap((flag): Judged[] => {
    const problem = quoteShapeProblem(flag.quote, flag.docId, evidence);
    return problem ? [fail(flag.id, flag.call, problem)] : [];
  });
  return [...unreadable, ...facts, ...flags];
}

// -- quotes ------------------------------------------------------------------------------------------

function partyId(index: number): string {
  return `party:${index}`;
}

function quoteJudgements(merged: MergedExtract, evidence: Evidence): Judged[] {
  const judge = (id: string, call: number, quote: string, docId: string): Judged =>
    evidence.verify(quote, docId)
      ? { id, call, ok: true }
      : fail(id, call, `the quote was not found in the files: "${preview(quote)}"`);
  const facts = merged.facts.map(
    (fact): Judged =>
      fact.status === "found"
        ? judge(fact.id, fact.call, fact.quote, fact.docId)
        : { id: fact.id, call: fact.call, ok: true, absent: true },
  );
  const flags = merged.redFlags.map((flag) => judge(flag.id, flag.call, flag.quote, flag.docId));
  const parties = merged.parties.map((party, index): Judged => {
    const id = partyId(index);
    if (party.quote.trim() !== "") {
      return judge(id, party.call, party.quote, party.docId);
    }
    return evidence.mentions(party.name)
      ? { id, call: party.call, ok: true }
      : fail(id, party.call, `no quote, and "${party.name}" is not written in the files`);
  });
  return [...facts, ...flags, ...parties];
}

// -- values ------------------------------------------------------------------------------------------

export type Trace = { readonly problem: string | null };

/** Figures and dates of `claim` against `evidence`. A date is read strictly first, then by its parts ("14th day of August, 2026"). */
export function traceClaim(claim: string, evidence: string, locale: AppLocale): Trace {
  const numbers = numbersTraced(claim, evidence, locale);
  if (!numbers.traced) {
    return {
      problem: `states ${numbers.untraced.map((amount) => amount.text.trim()).join(", ")}, which the passage does not`,
    };
  }
  const strict = datesTraced(claim, evidence, locale);
  if (!strict.traced && !datesTraced(claim, evidence, locale, { loose: true }).traced) {
    return {
      problem: `states the date or time ${strict.untraced.map((mention) => mention.text).join(", ")}, which the passage does not`,
    };
  }
  return { problem: null };
}

function windowOf(evidence: Evidence, found: VerifiedQuote, radius: number): string {
  return evidence.window(found, radius);
}

function valueJudgements(merged: MergedExtract, evidence: Evidence, locale: AppLocale): Judged[] {
  const facts = merged.facts.flatMap((fact): Judged[] => {
    if (fact.status !== "found" || fact.field === "parties") {
      return [];
    }
    const found = evidence.verify(fact.quote, fact.docId);
    if (!found) {
      return [];
    }
    const { problem } = traceClaim(fact.value, windowOf(evidence, found, QUOTE_WINDOW_CHARS), locale);
    return problem ? [fail(fact.id, fact.call, `the value ${problem}`)] : [];
  });
  const flags = merged.redFlags.flatMap((flag): Judged[] => {
    const found = evidence.verify(flag.quote, flag.docId);
    if (!found) {
      return [];
    }
    const claim = `${flag.title}\n${flag.why}`;
    const near = traceClaim(claim, windowOf(evidence, found, FLAG_WINDOW_CHARS), locale);
    if (!near.problem) {
      return [];
    }
    // The explanation may lean on a figure elsewhere in the same file; only then is it unsupported.
    const wide = traceClaim(claim, evidence.textOf(found.match.sourceId), locale);
    return wide.problem ? [fail(flag.id, flag.call, `the explanation ${wide.problem}`)] : [];
  });
  return [...facts, ...flags];
}

// -- coverage ----------------------------------------------------------------------------------------

function coverageJudgements(outputs: readonly CallOutput[]): Judged[] {
  return outputs.flatMap((output): Judged[] => {
    if (!output.response) {
      return [];
    }
    const fields = coverageGaps(
      FIXED_FIELDS,
      output.response.facts.map((fact) => ({ id: fact.field })),
    ).missing.map((field) =>
      fail(
        field,
        output.index,
        "no entry for this field: give a found fact (one per file that states it) or one with status missing",
      ),
    );
    const files = coverageGaps(
      output.docIds,
      output.response.files.map((file) => ({ id: file.docId })),
    ).missing.map((docId) =>
      fail(docId, output.index, "no role given for this file (draft, counter-draft, signed or reference)"),
    );
    return [...fields, ...files];
  });
}

// -- scope -------------------------------------------------------------------------------------------

function scopeJudgements(merged: MergedExtract, evidence: Evidence): Judged[] {
  const sources = evidence.texts;
  const flags = merged.redFlags.flatMap((flag): Judged[] => {
    const hit = scopeHits(`${flag.title}\n${flag.why}`, sources)[0];
    return hit ? [fail(flag.id, flag.call, scopeProblem(hit.kind, hit.text))] : [];
  });
  const notable = merged.facts.flatMap((fact): Judged[] => {
    if (fact.field !== LEGAL_NOTABLE_FIELD || fact.status !== "found") {
      return [];
    }
    const hit = scopeHits(fact.value, sources)[0];
    return hit ? [fail(fact.id, fact.call, scopeProblem(hit.kind, hit.text))] : [];
  });
  return [...flags, ...notable];
}

function scopeProblem(kind: "advice" | "citation", text: string): string {
  return kind === "advice"
    ? `gives advice ("${preview(text)}"); describe what the files say`
    : `cites "${preview(text)}", which no file cites`;
}

// -- the checks --------------------------------------------------------------------------------------

export function buildExtractChecks(context: ExtractChecksContext): ExtractChecks {
  const { evidence, locale } = context;
  const merges = new WeakMap<readonly CallOutput[], MergedExtract>();
  let latestMerge: MergedExtract | null = null;
  const mergedOf = (outputs: readonly CallOutput[]): MergedExtract => {
    const known = merges.get(outputs);
    if (known) {
      latestMerge = known;
      return known;
    }
    const merged = mergeCallOutputs(outputs);
    merges.set(outputs, merged);
    latestMerge = merged;
    return merged;
  };
  const labelFor = (id: string): string => {
    const fact = latestMerge?.facts.find((item) => item.id === id);
    if (fact) {
      return `${fact.field} in ${fact.docId || "the files"}`;
    }
    const flag = latestMerge?.redFlags.find((item) => item.id === id);
    if (flag) {
      return `red flag "${preview(flag.title)}"`;
    }
    const party = /^party:(d+)$/.exec(id);
    const named = party ? latestMerge?.parties[Number(party[1])] : undefined;
    return named ? `party "${named.name}"` : id;
  };
  const def = (
    id: (typeof EXTRACT_CHECK_IDS)[number],
    words: CheckDef<readonly CallOutput[]>["words"],
    judge: (outputs: readonly CallOutput[], merged: MergedExtract) => Judged[],
  ): CheckDef<readonly CallOutput[]> => ({ id, words, judge: (outputs) => judge(outputs, mergedOf(outputs)) });
  return createCallChecks<readonly CallOutput[]>([
    def(
      "legal-shape",
      {
        error: "These items are malformed:",
        why: "Code reads the answer by its shape, and could not read these.",
        fix: "Return the whole answer again as valid JSON in the required shape: a found fact or red flag needs a quote of 12 to 400 characters and the id of the file it comes from; a missing field is status missing with an empty value, quote and docId. Fix {items}.",
      },
      (outputs, merged) => shapeJudgements(outputs, merged, evidence),
    ),
    def(
      "legal-quotes",
      {
        error: "These quotes are not in the files:",
        why: "Code looks every quote up in the files; a quote that is not there word for word cannot be shown to the owner as evidence.",
        fix: "For {items}, copy the exact words from the file (contiguous, no ellipsis, 12 to 400 characters), or leave the item out if the files do not say it.",
      },
      (_outputs, merged) => quoteJudgements(merged, evidence),
    ),
    def(
      "legal-values",
      {
        error: "These items state figures or dates the quoted passage does not:",
        why: "A value is the document's own figure or date, not a recomputed or rounded one.",
        fix: "For {items}, correct the value to what the quoted passage states, or quote the passage that states it.",
      },
      (_outputs, merged) => valueJudgements(merged, evidence, locale),
    ),
    def(
      "legal-coverage",
      {
        error: "These answers are missing:",
        why: 'Every field and every file needs an entry; "the files do not state it" is an answer, silence is not.',
        fix: "Add an entry for {items}: a found fact with a quote, or status missing; and a role for every file.",
      },
      (outputs) => coverageJudgements(outputs),
    ),
    def(
      "legal-scope",
      {
        error: "These items give advice or rely on law the files do not cite:",
        why: "The owner asked what the files state, not for advice or for law from outside the files.",
        fix: "Rewrite {items} to describe what the files say, with no advice and no statute the files do not cite.",
      },
      (_outputs, merged) => scopeJudgements(merged, evidence),
    ),
  ], labelFor);
}
