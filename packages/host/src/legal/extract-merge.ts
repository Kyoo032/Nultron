/**
 * Putting the answers of several extraction calls together, in code (owner rule 2026-10-05: when a matter is
 * too long for one call it is read in parts, and the parts are merged deterministically).
 *
 * Rules, all of them code and none a model's choice:
 *  - a fact is kept once per field + value + quote; two files that state a field differently both stay, so
 *    `findConflicts` can report it;
 *  - a field some call found is never also reported missing; a field no call found is reported missing once;
 *  - every red flag stays (one per file + quote + title);
 *  - a file keeps the role the first call that saw it gave it;
 *  - item ids come from `facts.ts`, so the same fact in the same file keeps its id across extractions.
 *
 * Pure. No model call, no file access.
 */
import { normaliseForMatch } from "@agentforge/core/judges";
import {
  LEGAL_ALL_FIELDS,
  LEGAL_NOTABLE_FIELD,
  factItemId,
  flagItemId,
  samePartyName,
  type LegalExtractModelResponse,
  type LegalIntakeRole,
  type LegalModelFact,
  type LegalModelParty,
  type LegalModelRedFlag,
} from "@agentforge/core/legal";

export type CallOutput = {
  /** Position among the matter's calls. */
  readonly index: number;
  /** The files this call was given some or all of. */
  readonly docIds: readonly string[];
  /** The model's answer; null when it could not be read as the required JSON (twice). */
  readonly response: LegalExtractModelResponse | null;
  /** Why `response` is null: a short, fixed phrase, never the model's text. */
  readonly problem: string | null;
  /** The reply as written (capped), handed back to the model on a repair. */
  readonly raw: string;
};

export type MergedFact = LegalModelFact & { readonly id: string; readonly call: number };
export type MergedFlag = LegalModelRedFlag & { readonly id: string; readonly call: number };
export type MergedParty = LegalModelParty & { readonly call: number };
export type MergedFile = {
  readonly docId: string;
  readonly role: LegalIntakeRole;
  readonly reason: string;
  readonly call: number;
};
export type MergedSide = NonNullable<LegalExtractModelResponse["side"]> & { readonly call: number };

export type MergedExtract = {
  readonly documentType: string;
  readonly parties: readonly MergedParty[];
  readonly files: readonly MergedFile[];
  readonly side: MergedSide | null;
  readonly facts: readonly MergedFact[];
  readonly redFlags: readonly MergedFlag[];
};

const SEVERITY_ORDER: Readonly<Record<string, number>> = { high: 0, medium: 1, low: 2 };
const CONFIDENCE_ORDER: Readonly<Record<string, number>> = { high: 0, medium: 1, low: 2 };
const FIELD_ORDER: ReadonlyMap<string, number> = new Map(LEGAL_ALL_FIELDS.map((field, index) => [field, index]));

function fold(text: string): string {
  return normaliseForMatch(text, { foldCase: true }).value;
}

function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  let ordinal = 2;
  while (taken.has(id)) {
    id = `${base}#${ordinal}`;
    ordinal += 1;
  }
  taken.add(id);
  return id;
}

/** A fact as kept: found ones as written (trimmed), missing ones with nothing a model could have invented. */
function tidyFact(fact: LegalModelFact): LegalModelFact {
  return fact.status === "missing"
    ? { ...fact, value: "", quote: "", docId: "", anchor: "" }
    : { ...fact, value: fact.value.trim(), quote: fact.quote.trim(), docId: fact.docId.trim() };
}

function mergeFacts(outputs: readonly CallOutput[]): MergedFact[] {
  const seen = new Set<string>();
  const kept: Array<LegalModelFact & { call: number }> = [];
  for (const output of outputs) {
    for (const raw of output.response?.facts ?? []) {
      const fact = tidyFact(raw);
      if (fact.status === "missing" && fact.field === LEGAL_NOTABLE_FIELD) {
        continue;
      }
      const key =
        fact.status === "missing"
          ? `${fact.field}|missing`
          : // The file is part of the key: the same clause in a draft and in its counter-draft is two facts, one per file.
            `${fact.field}|${fact.docId}|${fold(fact.value)}|${fold(fact.quote)}`;
      if (!seen.has(key)) {
        seen.add(key);
        kept.push({ ...fact, call: output.index });
      }
    }
  }
  const found = new Set(kept.filter((fact) => fact.status === "found").map((fact) => fact.field));
  const relevant = kept.filter((fact) => fact.status === "found" || !found.has(fact.field));
  const ordered = relevant
    .map((fact, position) => ({ fact, position }))
    .sort(
      (left, right) =>
        (FIELD_ORDER.get(left.fact.field) ?? 99) - (FIELD_ORDER.get(right.fact.field) ?? 99) ||
        left.position - right.position,
    )
    .map((entry) => entry.fact);
  const ordinals = new Map<string, number>();
  const taken = new Set<string>();
  return ordered.map((fact) => {
    const slot = `${fact.field}|${fact.docId}`;
    const ordinal = (ordinals.get(slot) ?? 0) + 1;
    ordinals.set(slot, ordinal);
    return { ...fact, id: uniqueId(factItemId(fact.field, fact.docId, ordinal, fact.quote), taken) };
  });
}

function mergeFlags(outputs: readonly CallOutput[]): MergedFlag[] {
  const seen = new Set<string>();
  const kept: Array<LegalModelRedFlag & { call: number }> = [];
  for (const output of outputs) {
    for (const raw of output.response?.redFlags ?? []) {
      const flag = { ...raw, quote: raw.quote.trim(), docId: raw.docId.trim() };
      const key = `${flag.docId}|${fold(flag.quote)}|${fold(flag.title)}`;
      if (!seen.has(key)) {
        seen.add(key);
        kept.push({ ...flag, call: output.index });
      }
    }
  }
  const taken = new Set<string>();
  return kept
    .map((flag, position) => ({ flag, position }))
    .sort(
      (left, right) =>
        (SEVERITY_ORDER[left.flag.severity] ?? 3) - (SEVERITY_ORDER[right.flag.severity] ?? 3) ||
        left.position - right.position,
    )
    .map(({ flag }) => ({ ...flag, id: uniqueId(flagItemId(flag.docId, flag.quote), taken) }));
}

function mergeParties(outputs: readonly CallOutput[]): MergedParty[] {
  const parties: MergedParty[] = [];
  for (const output of outputs) {
    for (const party of output.response?.parties ?? []) {
      const at = parties.findIndex((other) => samePartyName(other.name, party.name));
      if (at === -1) {
        parties.push({ ...party, call: output.index });
      } else if ((parties[at] as MergedParty).quote.trim() === "" && party.quote.trim() !== "") {
        parties[at] = { ...party, name: (parties[at] as MergedParty).name, call: output.index };
      }
    }
  }
  return parties;
}

function mergeFiles(outputs: readonly CallOutput[]): MergedFile[] {
  const files = new Map<string, MergedFile>();
  for (const output of outputs) {
    for (const file of output.response?.files ?? []) {
      if (!files.has(file.docId)) {
        files.set(file.docId, { docId: file.docId, role: file.role, reason: file.reason, call: output.index });
      }
    }
  }
  return [...files.values()];
}

function mergeSide(outputs: readonly CallOutput[]): MergedSide | null {
  let best: MergedSide | null = null;
  for (const output of outputs) {
    const side = output.response?.side;
    if (
      side &&
      (best === null || (CONFIDENCE_ORDER[side.confidence] ?? 3) < (CONFIDENCE_ORDER[best.confidence] ?? 3))
    ) {
      best = { ...side, call: output.index };
    }
  }
  return best;
}

export function mergeCallOutputs(outputs: readonly CallOutput[]): MergedExtract {
  return {
    documentType: outputs.map((output) => output.response?.documentType.trim() ?? "").find((type) => type !== "") ?? "",
    parties: mergeParties(outputs),
    files: mergeFiles(outputs),
    side: mergeSide(outputs),
    facts: mergeFacts(outputs),
    redFlags: mergeFlags(outputs),
  };
}
