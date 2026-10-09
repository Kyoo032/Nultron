/**
 * What the owner sees of an extraction: the saved record with their edits and comments applied
 * (docs/internal/doc-flow-plan.md 7a.3), and the pure rules for changing those edits and comments.
 *
 * An edit replaces a fact's value (or a red flag's explanation) and is marked `edited`; the quote the model
 * found stays beside it. Edits live in `extract-edits.json`, not in `extract.json`, so a re-extraction that
 * replaces the record never overwrites one: an item keeps its id across extractions (field + file for a fixed
 * field, the quoted words for a notable fact or a red flag), and the edit is applied to whatever item
 * carries that id now. An edit whose item is gone is kept and listed as orphaned, not dropped.
 *
 * Pure. No file access, no model call.
 */
import { ApiError } from "@agentforge/core";
import { findConflicts } from "@agentforge/core/judges";
import {
  LEGAL_NOTABLE_FIELD,
  type LegalConflictRecord,
  type LegalExtractComment,
  type LegalExtractEdit,
  type LegalExtractEditsFile,
  type LegalExtractRecord,
  type LegalExtractView,
  type LegalSide,
  legalConflictKind,
  redFlagAgainst,
} from "@agentforge/core/legal";

const MAX_COMMENTS_PER_ITEM = 50;
const MAX_EDITS = 500;
const MAX_COMMENTS = 1000;

/** A fact reduced to what finding conflicts needs. */
export type ConflictInput = {
  readonly id: string;
  readonly field: string;
  readonly value: string;
  readonly docId: string;
};

/** Files that state a field differently. Reported beside both values; never repaired and never resolved by the model. */
export function conflictRecords(
  facts: readonly ConflictInput[],
  locale: LegalExtractRecord["locale"],
): LegalConflictRecord[] {
  const comparable = facts.filter((fact) => fact.field !== LEGAL_NOTABLE_FIELD && fact.value.trim() !== "");
  const docOf = new Map(comparable.map((fact) => [fact.id, fact.docId] as const));
  // The judge groups values by agreement, so each fact goes in under its own id: a group's sources are then
  // exactly the facts in it, however differently they are written ("Rp 1,5 miliar" and "Rp 1.500.000.000").
  return (
    findConflicts(
      comparable.map((fact) => ({ key: fact.field, value: fact.value, source: fact.id })),
      legalConflictKind,
      locale,
    )
      .map((conflict) => ({
        field: conflict.key as LegalConflictRecord["field"],
        kind: conflict.kind,
        values: conflict.values.map((entry) => ({
          value: entry.value,
          itemIds: [...entry.sources],
          docIds: [...new Set(entry.sources.map((id) => docOf.get(id) ?? "").filter((docId) => docId !== ""))],
        })),
      }))
      // Two values in one file (a fee and a late fee) are two facts, not a conflict between files.
      .filter((conflict) => new Set(conflict.values.flatMap((entry) => entry.docIds)).size >= 2)
  );
}

export type ViewMatter = {
  readonly side: LegalSide;
  readonly sideDeclined?: boolean;
  readonly docs: readonly { readonly id: string; readonly sha256: string }[];
};

function editFor(edits: readonly LegalExtractEdit[], itemId: string): LegalExtractEdit | undefined {
  return edits.find((edit) => edit.itemId === itemId);
}

function sameFiles(record: LegalExtractRecord, matter: ViewMatter): boolean {
  return (
    record.read.files.length === matter.docs.length &&
    matter.docs.every((doc) => record.read.files.some((file) => file.docId === doc.id && file.sha256 === doc.sha256))
  );
}

function sideNow(record: LegalExtractRecord, matter: ViewMatter): LegalExtractRecord["side"] {
  if (matter.side.party.trim() !== "") {
    return { party: matter.side.party.trim(), ask: false, candidates: [], source: "matter" };
  }
  if (matter.sideDeclined === true) {
    return { party: null, ask: false, candidates: [], source: "declined" };
  }
  return record.side;
}

/** The record as the owner sees it: edits applied and marked, comments attached, the side and who a flag hurts as they stand now. */
export function buildExtractView(
  record: LegalExtractRecord,
  file: LegalExtractEditsFile,
  matter: ViewMatter,
): LegalExtractView {
  const facts = record.facts.map((fact) => {
    const edit = editFor(file.edits, fact.id);
    return edit
      ? {
          ...fact,
          value: edit.value,
          edited: true,
          originalValue: fact.value,
          editedAt: edit.editedAt,
          editedBy: edit.editedBy,
        }
      : { ...fact, edited: false, originalValue: null, editedAt: null, editedBy: null };
  });
  const redFlags = record.redFlags.map((flag) => {
    const edit = editFor(file.edits, flag.id);
    const against = flag.againstParty === "" ? flag.against : redFlagAgainst(flag.againstParty, matter.side);
    return edit
      ? {
          ...flag,
          against,
          why: edit.value,
          edited: true,
          originalValue: flag.why,
          editedAt: edit.editedAt,
          editedBy: edit.editedBy,
        }
      : { ...flag, against, edited: false, originalValue: null, editedAt: null, editedBy: null };
  });
  const ids = new Set([...record.facts.map((fact) => fact.id), ...record.redFlags.map((flag) => flag.id)]);
  return {
    ...record,
    facts,
    redFlags,
    // Conflicts are looked for in the values the owner now holds, so correcting one of two dates settles it.
    conflicts: conflictRecords(
      facts
        .filter((fact) => fact.status !== "not-in-documents" || fact.edited)
        .map((fact) => ({ id: fact.id, field: fact.field, value: fact.value, docId: fact.docId })),
      record.locale,
    ),
    side: sideNow(record, matter),
    comments: [...file.comments],
    stale: !sameFiles(record, matter),
    orphanedEdits: [...new Set([...file.edits, ...file.comments].map((entry) => entry.itemId))].filter(
      (itemId) => !ids.has(itemId),
    ),
  };
}

function itemIds(record: LegalExtractRecord): Set<string> {
  return new Set([...record.facts.map((fact) => fact.id), ...record.redFlags.map((flag) => flag.id)]);
}

function requireItem(record: LegalExtractRecord, itemId: string): void {
  if (!itemIds(record).has(itemId)) {
    throw new ApiError("invalid_request", `itemId "${itemId}" is not an item of this extraction`, 400);
  }
}

export type EditRequest = { readonly itemId: string; readonly value: string | null };

/** Set the listed items' values (`null` puts an item back to what the documents say). Returns a new file. */
export function applyEdits(
  record: LegalExtractRecord,
  file: LegalExtractEditsFile,
  requests: readonly EditRequest[],
  at: number,
  by: string,
): LegalExtractEditsFile {
  for (const request of requests) {
    requireItem(record, request.itemId);
  }
  const touched = new Set(requests.map((request) => request.itemId));
  const kept = file.edits.filter((edit) => !touched.has(edit.itemId));
  const added: LegalExtractEdit[] = requests.flatMap((request) =>
    request.value === null ? [] : [{ itemId: request.itemId, value: request.value.trim(), editedAt: at, editedBy: by }],
  );
  const edits = [...kept, ...added];
  if (edits.length > MAX_EDITS) {
    throw new ApiError("invalid_request", `A matter holds at most ${MAX_EDITS} edits`, 400);
  }
  return { ...file, edits };
}

/** Append a comment to one item. Returns a new file. */
export function addComment(
  record: LegalExtractRecord,
  file: LegalExtractEditsFile,
  comment: { itemId: string; text: string },
  at: number,
  by: string,
  id: string,
): LegalExtractEditsFile {
  requireItem(record, comment.itemId);
  if (file.comments.length >= MAX_COMMENTS) {
    throw new ApiError("invalid_request", `A matter holds at most ${MAX_COMMENTS} comments`, 400);
  }
  if (file.comments.filter((existing) => existing.itemId === comment.itemId).length >= MAX_COMMENTS_PER_ITEM) {
    throw new ApiError("invalid_request", `An item takes at most ${MAX_COMMENTS_PER_ITEM} comments`, 400);
  }
  const next: LegalExtractComment = { id, itemId: comment.itemId, text: comment.text.trim(), at, by };
  return { ...file, comments: [...file.comments, next] };
}

type Located = { readonly id: string; readonly docId: string; readonly anchor: string };

/**
 * Carry the owner's edits and comments over to the items of a new extraction.
 *
 * An item keeps its id when the same fact is found in the same file; a red flag or notable fact is named by the
 * words the model quoted, and a model that quotes a slightly different span the second time gives the same
 * finding a new id. So an edit or comment whose item is gone is looked for in the NEW record by place: the same
 * kind of item, in the same file, at the same paragraph or table. It moves only when exactly one item is there
 * and no other edit already holds it. A field that was "missing" and is now stated moves to that field's one fact.
 * Anything that cannot be matched with certainty stays where it is and is listed as orphaned. Returns a new file.
 */
export function relinkEdits(
  previous: LegalExtractRecord | null,
  next: LegalExtractRecord,
  file: LegalExtractEditsFile,
): LegalExtractEditsFile {
  if (previous === null) {
    return file;
  }
  const kept = new Set([...next.facts.map((fact) => fact.id), ...next.redFlags.map((flag) => flag.id)]);
  const gone = [...new Set([...file.edits, ...file.comments].map((entry) => entry.itemId))].filter((id) => !kept.has(id));
  if (gone.length === 0) {
    return file;
  }
  const held = new Set(file.edits.map((edit) => edit.itemId).filter((id) => kept.has(id)));
  const oldFacts = new Map(previous.facts.map((fact) => [fact.id, fact] as const));
  const oldFlags = new Map(previous.redFlags.map((flag) => [flag.id, flag] as const));
  const moves = new Map<string, string>();
  const free = (candidate: Located): boolean => !held.has(candidate.id) && ![...moves.values()].includes(candidate.id);
  const samePlace = (old: Located, candidate: Located): boolean =>
    old.docId !== "" && old.anchor !== "" && candidate.docId === old.docId && candidate.anchor === old.anchor;
  for (const id of gone) {
    const fact = oldFacts.get(id);
    const flag = oldFlags.get(id);
    const candidates: readonly Located[] = fact
      ? next.facts.filter(
          (candidate) =>
            candidate.field === fact.field &&
            candidate.status !== "not-in-documents" &&
            (fact.docId === "" || samePlace(fact, candidate)) &&
            free(candidate),
        )
      : flag
        ? next.redFlags.filter((candidate) => samePlace(flag, candidate) && free(candidate))
        : [];
    if (candidates.length === 1) {
      moves.set(id, (candidates[0] as Located).id);
    }
  }
  if (moves.size === 0) {
    return file;
  }
  const moved = (itemId: string): string => moves.get(itemId) ?? itemId;
  return {
    ...file,
    edits: file.edits.map((edit) => ({ ...edit, itemId: moved(edit.itemId) })),
    comments: file.comments.map((comment) => ({ ...comment, itemId: moved(comment.itemId) })),
  };
}

/** A fact the owner corrected: what the full review may treat as given. */
export type ConfirmedFact = {
  readonly field: string;
  readonly label: string;
  readonly value: string;
  readonly docId: string;
  readonly quote: string;
};

/** The owner's own corrections, for the full review to read as user-confirmed facts. */
export function confirmedFacts(view: LegalExtractView): ConfirmedFact[] {
  return view.facts
    .filter((fact) => fact.edited && fact.value.trim() !== "")
    .map((fact) => ({ field: fact.field, label: fact.label, value: fact.value, docId: fact.docId, quote: fact.quote }));
}

const NOTE_VALUE_CHARS = 300;

/** One block of text for the review's source-priority note. Empty when the owner corrected nothing. */
export function confirmedFactsNote(facts: readonly ConfirmedFact[]): string {
  if (facts.length === 0) {
    return "";
  }
  const lines = facts.map((fact) => {
    const where = fact.docId === "" ? "" : ` (${fact.docId})`;
    const value = fact.value.replace(/\s+/g, " ").trim();
    return `${fact.label || fact.field}${where}: ${value.length > NOTE_VALUE_CHARS ? `${value.slice(0, NOTE_VALUE_CHARS)}...` : value}`;
  });
  return `USER-CONFIRMED FACTS (the owner corrected these; treat them as given): ${lines.join("; ")}.`;
}
