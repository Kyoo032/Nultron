/**
 * Legal "add files, get answers" contract (docs/internal/doc-flow-plan.md sections 2 and 7a).
 *
 * One place that says what an extraction and an answer look like, on the wire and on disk:
 *  - the response the MODEL is asked for (`legalExtractModelSchema`, `legalAskModelSchema`), parsed
 *    before any code trusts it. Prose is capped so a runaway answer cannot fill the record;
 *  - the record the HOST saves (`legalExtractRecordSchema`, `legalAskRecordSchema`) after code has judged
 *    every item, and the view `GET /legal/matters/:id/extract` returns, which is that record merged with
 *    the owner's edits and comments (`legalExtractViewSchema`);
 *  - the small pure rules both sides share: stable item ids, how each field is compared, which red flag
 *    is against whom, file roles, and the side question.
 *
 * STABLE: the Legal UI lane parses these schemas. Add a field with a default, never rename or remove one.
 *
 * Pure. No model call, no file access.
 */
import { z } from "zod";
import type { ConflictKind } from "../harness/judges/conflicts";
import { normaliseForMatch } from "../harness/judges/normalise";
import { APP_LOCALES } from "../locale";
import { DOC_ROLES, SEVERITIES, type DocRole, type LegalSide } from "./types";

// -- the fields ------------------------------------------------------------------------------------

/** The facts every extraction answers for, once per file that states them. */
export const LEGAL_FACT_FIELDS = [
  "parties",
  "effective-date",
  "term",
  "payment",
  "liability",
  "termination",
  "governing-law",
] as const;
export type LegalFactField = (typeof LEGAL_FACT_FIELDS)[number];

/** Free-form facts worth a reader's eye that no fixed field holds (a change of control, an exclusivity). */
export const LEGAL_NOTABLE_FIELD = "notable" as const;

export const LEGAL_ALL_FIELDS = [...LEGAL_FACT_FIELDS, LEGAL_NOTABLE_FIELD] as const;
export type LegalAnyField = (typeof LEGAL_ALL_FIELDS)[number];

const FIELD_KINDS: Readonly<Record<LegalAnyField, ConflictKind>> = {
  parties: "text",
  "effective-date": "date",
  term: "duration",
  payment: "amount",
  liability: "amount",
  termination: "text",
  "governing-law": "text",
  notable: "text",
};

/** How two files' values for a field are compared when looking for a conflict. */
export function legalConflictKind(field: string): ConflictKind {
  return FIELD_KINDS[field as LegalAnyField] ?? "text";
}

// -- limits ----------------------------------------------------------------------------------------

/** A quote is verified in code, so the model is told to keep it short and contiguous. */
export const LEGAL_QUOTE_MIN_CHARS = 12;
export const LEGAL_QUOTE_MAX_CHARS = 400;
export const LEGAL_ASK_QUESTION_MAX = 1000;
/** The owner's optional steer for an extraction. It decides what to look at harder, never what counts as proof. */
export const LEGAL_PROMPT_MAX = 2000;
export const LEGAL_ASKS_CAP = 50;
export const LEGAL_COMMENT_MAX_CHARS = 2000;
export const LEGAL_EDIT_MAX_CHARS = 2000;
/** Most read calls a matter may need before a run refuses up front (nothing is silently skipped). */
export const LEGAL_MAX_READ_CALLS = 30;

/**
 * Most files one call carries. A call answers every fixed field once per file it holds, so this bounds the
 * answer (8 files is 56 fixed facts) however many small files a matter has.
 */
export const LEGAL_MAX_FILES_PER_CALL = 8;

/** Most items the model may return for one call. Sized for `LEGAL_MAX_FILES_PER_CALL` files plus a good many notable facts. */
export const LEGAL_CALL_LIMITS = { parties: 40, files: 100, facts: 160, redFlags: 80 } as const;

/**
 * How many of each item a saved record holds. Sized for the largest matter the read-call cap allows (every call
 * may return `LEGAL_CALL_LIMITS`); a run trims to these, least important last, so saving never fails
 * after the model has been paid.
 */
export const LEGAL_RECORD_LIMITS = {
  parties: 400,
  facts: 2000,
  redFlags: 1000,
  conflicts: 100,
  askCitations: 40,
  answerChars: 20_000,
} as const;

/** The longest file name a card or a read record keeps; a longer one is cut (its extension kept) when the file is added. */
export const LEGAL_FILE_NAME_MAX = 200;

const SHORT_MAX = 200;
const LABEL_MAX = 120;
const VALUE_MAX = 1_500;
const PROSE_MAX = 2_000;
/** Generous on the wire: the shape judge enforces `LEGAL_QUOTE_MAX_CHARS` per item, so one long quote costs a repair, not the call. */
const QUOTE_WIRE_MAX = 1_500;
const ID_MAX = 120;

// -- vocab -----------------------------------------------------------------------------------------

/** What the model says of a fact: stated in the documents, or not. */
export const LEGAL_MODEL_FACT_STATUSES = ["found", "missing"] as const;
/** What code concludes about an item once it has judged it. */
export const LEGAL_ITEM_STATUSES = ["verified", "unverified", "not-in-documents"] as const;
export type LegalItemStatus = (typeof LEGAL_ITEM_STATUSES)[number];

/** What a file is, in the reader's words. Code maps it to a `DocRole` (`docRolesFromIntake`). */
export const LEGAL_INTAKE_ROLES = ["draft", "counter-draft", "signed", "reference"] as const;
export type LegalIntakeRole = (typeof LEGAL_INTAKE_ROLES)[number];

export const LEGAL_AGAINST = ["you", "them", "both", "unknown"] as const;
export type LegalAgainst = (typeof LEGAL_AGAINST)[number];

export const LEGAL_SIDE_SOURCES = ["matter", "declined", "single", "model", "desk", "ask", "none"] as const;
export type LegalSideSource = (typeof LEGAL_SIDE_SOURCES)[number];

const CONFIDENCE = ["high", "medium", "low"] as const;
const READ_STATUSES = ["read", "partial", "unread"] as const;
const COVERAGE_STATES = ["stated", "not-stated", "unknown"] as const;
const CONFLICT_KINDS = ["amount", "date", "duration", "text"] as const;

// -- the model's extract response ------------------------------------------------------------------

const modelPartySchema = z.object({
  name: z.string().trim().min(1).max(SHORT_MAX),
  role: z.string().trim().max(80).default(""),
  quote: z.string().max(QUOTE_WIRE_MAX).default(""),
  docId: z.string().trim().max(40).default(""),
});

const modelFileSchema = z.object({
  docId: z.string().trim().min(1).max(40),
  role: z.enum(LEGAL_INTAKE_ROLES),
  reason: z.string().max(300).default(""),
});

const modelSideSchema = z.object({
  party: z.string().trim().min(1).max(SHORT_MAX),
  confidence: z.enum(CONFIDENCE),
  quote: z.string().max(QUOTE_WIRE_MAX).default(""),
});

const modelFactSchema = z.object({
  field: z.enum(LEGAL_ALL_FIELDS),
  label: z.string().trim().max(LABEL_MAX).default(""),
  value: z.string().max(VALUE_MAX).default(""),
  status: z.enum(LEGAL_MODEL_FACT_STATUSES),
  quote: z.string().max(QUOTE_WIRE_MAX).default(""),
  docId: z.string().trim().max(40).default(""),
  /** A hint only: code takes the anchor from where the quote is, never from this. */
  anchor: z.string().trim().max(20).default(""),
});

const modelRedFlagSchema = z.object({
  title: z.string().trim().min(1).max(SHORT_MAX),
  why: z.string().max(PROSE_MAX).default(""),
  severity: z.enum(SEVERITIES).default("medium"),
  /** A party name as the documents write it, or `both`, or `unknown`. Code maps it to you / them. */
  against: z.string().trim().max(SHORT_MAX).default("unknown"),
  quote: z.string().max(QUOTE_WIRE_MAX).default(""),
  docId: z.string().trim().max(40).default(""),
  anchor: z.string().trim().max(20).default(""),
});

export const legalExtractModelSchema = z.object({
  documentType: z.string().trim().max(SHORT_MAX).default(""),
  parties: z.array(modelPartySchema).max(LEGAL_CALL_LIMITS.parties).default([]),
  files: z.array(modelFileSchema).max(LEGAL_CALL_LIMITS.files).default([]),
  side: modelSideSchema.nullable().default(null),
  facts: z.array(modelFactSchema).max(LEGAL_CALL_LIMITS.facts).default([]),
  redFlags: z.array(modelRedFlagSchema).max(LEGAL_CALL_LIMITS.redFlags).default([]),
});
export type LegalExtractModelResponse = z.infer<typeof legalExtractModelSchema>;
export type LegalModelFact = z.infer<typeof modelFactSchema>;
export type LegalModelRedFlag = z.infer<typeof modelRedFlagSchema>;
export type LegalModelParty = z.infer<typeof modelPartySchema>;

// -- the model's ask response ----------------------------------------------------------------------

export const legalAskModelSchema = z.object({
  answer: z.string().max(4_000),
  citations: z
    .array(
      z.object({
        docId: z.string().trim().max(40).default(""),
        quote: z.string().max(QUOTE_WIRE_MAX),
      }),
    )
    .max(12)
    .default([]),
  notInDocuments: z.boolean(),
});
export type LegalAskModelResponse = z.infer<typeof legalAskModelSchema>;

// -- the saved records -----------------------------------------------------------------------------

/** What was read, so nothing is silently left out: per file, how many chunks went to the model. */
const readFileSchema = z.object({
  docId: z.string().max(40),
  name: z.string().max(LEGAL_FILE_NAME_MAX),
  sha256: z.string().max(80),
  chars: z.number().int().nonnegative(),
  chunks: z.object({ read: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
  status: z.enum(READ_STATUSES),
});

export const legalReadSchema = z.object({
  /** Model calls the first pass made (one per file or chunk group). */
  calls: z.number().int().nonnegative(),
  /** Targeted repair calls made after the checks, at most one per call. */
  repairs: z.number().int().nonnegative(),
  files: z.array(readFileSchema).max(200),
  /** Files read in part or not at all (a call failed twice). Empty when every file was read in full. */
  partialDocs: z.array(z.string().max(40)).max(200),
});
export type LegalRead = z.infer<typeof legalReadSchema>;

const locationShape = {
  quote: z.string().max(QUOTE_WIRE_MAX),
  docId: z.string().max(40),
  anchor: z.string().max(20),
  clauseId: z.string().max(SHORT_MAX).nullable(),
  page: z.number().int().positive().nullable(),
};

export const legalFactRecordSchema = z.object({
  id: z.string().max(ID_MAX),
  field: z.enum(LEGAL_ALL_FIELDS),
  label: z.string().max(LABEL_MAX),
  value: z.string().max(VALUE_MAX),
  status: z.enum(LEGAL_ITEM_STATUSES),
  ...locationShape,
});
export type LegalFactRecord = z.infer<typeof legalFactRecordSchema>;

export const legalRedFlagRecordSchema = z.object({
  id: z.string().max(ID_MAX),
  title: z.string().max(SHORT_MAX),
  why: z.string().max(PROSE_MAX),
  severity: z.enum(SEVERITIES),
  /** Who it is against, as of the current side. Recomputed on read; `againstParty` is what the model wrote. */
  against: z.enum(LEGAL_AGAINST),
  againstParty: z.string().max(SHORT_MAX),
  status: z.enum(LEGAL_ITEM_STATUSES),
  ...locationShape,
});
export type LegalRedFlagRecord = z.infer<typeof legalRedFlagRecordSchema>;

export const legalPartyRecordSchema = z.object({
  name: z.string().max(SHORT_MAX),
  role: z.string().max(80),
  status: z.enum(LEGAL_ITEM_STATUSES),
  ...locationShape,
});
export type LegalPartyRecord = z.infer<typeof legalPartyRecordSchema>;

export const legalFileRecordSchema = z.object({
  docId: z.string().max(40),
  /** What the model took the file for; null when it said nothing about it. */
  intakeRole: z.enum(LEGAL_INTAKE_ROLES).nullable(),
  reason: z.string().max(300),
  /** The `DocRole` code set from it; null when it left the file's role alone. */
  appliedRole: z.enum(DOC_ROLES).nullable(),
});
export type LegalFileRecord = z.infer<typeof legalFileRecordSchema>;

/** Two files (or two places in one) that give different values for the same field. Reported, never repaired. */
export const legalConflictRecordSchema = z.object({
  field: z.enum(LEGAL_ALL_FIELDS),
  kind: z.enum(CONFLICT_KINDS),
  values: z
    .array(
      z.object({
        /** An owner's edit can be longer than what the model wrote, so this is the edit's cap. */
        value: z.string().max(LEGAL_EDIT_MAX_CHARS),
        docIds: z.array(z.string().max(40)).max(200),
        itemIds: z.array(z.string().max(ID_MAX)).max(200),
      }),
    )
    .min(2)
    .max(100),
});
export type LegalConflictRecord = z.infer<typeof legalConflictRecordSchema>;

export const legalCoverageSchema = z.object({
  field: z.enum(LEGAL_FACT_FIELDS),
  /** stated: a file states it. not-stated: the model answered that no file does. unknown: no answer (a call failed). */
  state: z.enum(COVERAGE_STATES),
});

export const legalChecksSchema = z.object({
  /** Every check passed on the last look. False means some item is marked unverified. */
  passed: z.boolean(),
  /** Repair rounds spent: 0 or 1. */
  rounds: z.number().int().nonnegative(),
  /** Check ids and pass/fail only; never a quote. */
  verdicts: z.array(z.object({ check: z.string().max(60), ok: z.boolean() })).max(20),
});
export type LegalChecks = z.infer<typeof legalChecksSchema>;

/** A name the owner can be asked about: `party` ready to PATCH onto the matter as `side`. */
export const legalSideCandidateSchema = z.object({
  party: z.string().max(SHORT_MAX),
  role: z.string().max(SHORT_MAX),
  counterparty: z.string().max(SHORT_MAX),
});
export type LegalSideCandidate = z.infer<typeof legalSideCandidateSchema>;

export const legalSideResolutionSchema = z.object({
  /** The client's side, or null when it is not known and not being asked. */
  party: z.string().max(SHORT_MAX).nullable(),
  /** True when the owner should be asked: show `candidates` and "Neither / just reading". */
  ask: z.boolean(),
  candidates: z.array(legalSideCandidateSchema).max(4),
  source: z.enum(LEGAL_SIDE_SOURCES),
});
export type LegalSideResolution = z.infer<typeof legalSideResolutionSchema>;

export const legalExtractRecordSchema = z.object({
  version: z.literal(1),
  matterId: z.string().max(ID_MAX),
  createdAt: z.number(),
  model: z.string().max(SHORT_MAX),
  locale: z.enum(APP_LOCALES),
  /** What the owner asked the extraction to look at ("what should I watch out for"); "" for the default reading. */
  prompt: z.string().max(LEGAL_PROMPT_MAX).default(""),
  documentType: z.string().max(SHORT_MAX),
  read: legalReadSchema,
  files: z.array(legalFileRecordSchema).max(200),
  parties: z.array(legalPartyRecordSchema).max(LEGAL_RECORD_LIMITS.parties),
  facts: z.array(legalFactRecordSchema).max(LEGAL_RECORD_LIMITS.facts),
  redFlags: z.array(legalRedFlagRecordSchema).max(LEGAL_RECORD_LIMITS.redFlags),
  conflicts: z.array(legalConflictRecordSchema).max(LEGAL_RECORD_LIMITS.conflicts),
  coverage: z.array(legalCoverageSchema).max(20),
  checks: legalChecksSchema,
  side: legalSideResolutionSchema,
});
export type LegalExtractRecord = z.infer<typeof legalExtractRecordSchema>;

// -- the owner's edits and comments (plan 7a.3) ----------------------------------------------------

export const legalExtractEditSchema = z.object({
  itemId: z.string().min(1).max(ID_MAX),
  /** Replaces a fact's value, or a red flag's `why`. The quote beside it never changes. */
  value: z.string().max(LEGAL_EDIT_MAX_CHARS),
  editedAt: z.number(),
  editedBy: z.string().max(SHORT_MAX),
});
export type LegalExtractEdit = z.infer<typeof legalExtractEditSchema>;

export const legalExtractCommentSchema = z.object({
  id: z.string().min(1).max(ID_MAX),
  itemId: z.string().min(1).max(ID_MAX),
  text: z.string().min(1).max(LEGAL_COMMENT_MAX_CHARS),
  at: z.number(),
  by: z.string().max(SHORT_MAX),
});
export type LegalExtractComment = z.infer<typeof legalExtractCommentSchema>;

/** `extract-edits.json`: inside the matter folder, so deleting the matter deletes it. */
export const legalExtractEditsFileSchema = z.object({
  version: z.literal(1),
  edits: z.array(legalExtractEditSchema).max(500),
  comments: z.array(legalExtractCommentSchema).max(1000),
});
export type LegalExtractEditsFile = z.infer<typeof legalExtractEditsFileSchema>;

const editedShape = {
  /** True when the owner replaced the model's value. `quote` still shows what the documents say. */
  edited: z.boolean(),
  /** The model's own value (a fact's value, a red flag's why) when `edited`; null otherwise. */
  originalValue: z.string().max(PROSE_MAX).nullable(),
  editedAt: z.number().nullable(),
  editedBy: z.string().max(SHORT_MAX).nullable(),
};

export const legalFactViewSchema = legalFactRecordSchema.extend({
  ...editedShape,
  /** The model's value is at most `VALUE_MAX`; the owner's edit may be longer, up to `LEGAL_EDIT_MAX_CHARS`. */
  value: z.string().max(LEGAL_EDIT_MAX_CHARS),
});
export const legalRedFlagViewSchema = legalRedFlagRecordSchema.extend(editedShape);
export type LegalFactView = z.infer<typeof legalFactViewSchema>;
export type LegalRedFlagView = z.infer<typeof legalRedFlagViewSchema>;

/** What `GET /legal/matters/:id/extract` returns inside `extract`: the record, edits applied, comments attached. */
export const legalExtractViewSchema = legalExtractRecordSchema.omit({ facts: true, redFlags: true }).extend({
  facts: z.array(legalFactViewSchema).max(LEGAL_RECORD_LIMITS.facts),
  redFlags: z.array(legalRedFlagViewSchema).max(LEGAL_RECORD_LIMITS.redFlags),
  comments: z.array(legalExtractCommentSchema).max(1000),
  /** Files were added or removed since this extraction: reading again would find more (or less). */
  stale: z.boolean(),
  /** Items an edit or a comment names that the extraction no longer has. Kept on disk; listed so they are not lost silently. */
  orphanedEdits: z.array(z.string().max(ID_MAX)).max(500),
});
export type LegalExtractView = z.infer<typeof legalExtractViewSchema>;

/** `GET /legal/matters/:id/extract`, and the `job.done` result of `POST .../extract/stream` and the edit routes. */
export const legalExtractResponseSchema = z.object({ extract: legalExtractViewSchema.nullable() });
export type LegalExtractResponse = z.infer<typeof legalExtractResponseSchema>;

// -- ask records -----------------------------------------------------------------------------------

export const legalAskCitationSchema = z.object({
  docId: z.string().max(40),
  quote: z.string().max(QUOTE_WIRE_MAX),
  anchor: z.string().max(20),
  clauseId: z.string().max(SHORT_MAX).nullable(),
  page: z.number().int().positive().nullable(),
});
export type LegalAskCitation = z.infer<typeof legalAskCitationSchema>;

export const legalAskRecordSchema = z.object({
  id: z.string().min(1).max(ID_MAX),
  question: z.string().max(LEGAL_ASK_QUESTION_MAX),
  answer: z.string().max(LEGAL_RECORD_LIMITS.answerChars),
  /** verified: every claim traced. unverified: a check still failed after the repair. not-in-documents: nothing verified supports an answer. */
  status: z.enum(LEGAL_ITEM_STATUSES),
  notInDocuments: z.boolean(),
  /** Only citations whose quote was found in the file they name. */
  citations: z.array(legalAskCitationSchema).max(LEGAL_RECORD_LIMITS.askCitations),
  askedAt: z.number(),
  model: z.string().max(SHORT_MAX),
  read: legalReadSchema,
  checks: legalChecksSchema,
});
export type LegalAskRecord = z.infer<typeof legalAskRecordSchema>;

/** `asks.json`. */
export const legalAsksFileSchema = z.object({
  version: z.literal(1),
  asks: z.array(legalAskRecordSchema).max(LEGAL_ASKS_CAP),
});
export type LegalAsksFile = z.infer<typeof legalAsksFileSchema>;

/** `GET /legal/matters/:id/asks`: newest first. The `job.done` result of `POST .../ask/stream` is `{ ask }`. */
export const legalAsksResponseSchema = z.object({ asks: z.array(legalAskRecordSchema).max(LEGAL_ASKS_CAP) });
export type LegalAsksResponse = z.infer<typeof legalAsksResponseSchema>;
export const legalAskResultSchema = z.object({ ask: legalAskRecordSchema });
export type LegalAskResult = z.infer<typeof legalAskResultSchema>;

// -- item ids --------------------------------------------------------------------------------------

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const HASH_HEX_CHARS = 8;
const NO_FILE = "-";

/** A short hash of the words, so the same sentence gets the same id however it is spaced or cased. */
function wordsHash(text: string): string {
  const value = normaliseForMatch(text, { foldCase: true }).value;
  let hash = FNV_OFFSET;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(HASH_HEX_CHARS, "0");
}

/**
 * The id of a fact. A fixed field is named by field and file (`payment:S1`; `payment:-` when no file states
 * it), so an edit to it survives a re-extract; a second distinct value for the same field in the same file
 * gets `#2`. A notable fact is named by the words it quotes, since a file can hold many.
 */
export function factItemId(field: string, docId: string, ordinal: number, quote = ""): string {
  const file = docId.trim() === "" ? NO_FILE : docId.trim();
  if (field === LEGAL_NOTABLE_FIELD) {
    return `${field}:${file}:${wordsHash(quote)}`;
  }
  return ordinal > 1 ? `${field}:${file}#${ordinal}` : `${field}:${file}`;
}

/** The id of a red flag: the file and the words it quotes, so a re-extract that finds it again keeps its edits. */
export function flagItemId(docId: string, quote: string): string {
  const file = docId.trim() === "" ? NO_FILE : docId.trim();
  return `flag:${file}:${wordsHash(quote)}`;
}

// -- party names -----------------------------------------------------------------------------------

const NAME_MIN_CONTAINED_CHARS = 4;
const COUNTERPARTY_SEPARATOR = " / ";
const SIDE_CANDIDATES_MAX = 4;
const TEXT_FIELD_MAX = 200;

function partyKey(name: string): string {
  return normaliseForMatch(name, { foldCase: true })
    .value.replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Same party: equal once case and punctuation go, or one name is the other with a prefix or suffix (`PT`, `Tbk`). */
export function samePartyName(left: string, right: string): boolean {
  const a = partyKey(left);
  const b = partyKey(right);
  if (a === "" || b === "") {
    return false;
  }
  if (a === b) {
    return true;
  }
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= NAME_MIN_CONTAINED_CHARS && ` ${long} `.includes(` ${short} `);
}

const BOTH_WORDS = new Set(["both", "keduanya", "kedua belah pihak", "kedua pihak", "all parties"]);

/**
 * Who a red flag is against, from the party name the model wrote and the side now on the matter. A name
 * that matches neither side, a missing side, and "unknown" are all `unknown`.
 */
export function redFlagAgainst(againstParty: string, side: Pick<LegalSide, "party" | "counterparty">): LegalAgainst {
  const named = againstParty.trim().toLowerCase();
  if (named === "" || named === "unknown" || named === "tidak diketahui") {
    return "unknown";
  }
  if (BOTH_WORDS.has(named)) {
    return "both";
  }
  if (side.party.trim() === "") {
    return "unknown";
  }
  if (samePartyName(againstParty, side.party)) {
    return "you";
  }
  const others = side.counterparty.split(COUNTERPARTY_SEPARATOR).filter((name) => name.trim() !== "");
  return others.some((name) => samePartyName(againstParty, name)) ? "them" : "unknown";
}

// -- file roles ------------------------------------------------------------------------------------

export type IntakeRoleInput = { docId: string; intakeRole: LegalIntakeRole | null };
export type IntakeRoleOutput = { docId: string; role: DocRole | null };

/**
 * The `DocRole` each file gets from what the model took it for (plan section 2). One draft is the
 * counterparty draft. A draft beside one counter-draft is the prior turn, and the counter-draft is the
 * counterparty draft. Signed is executed, reference is context. Where nothing says which file is the one
 * under review (two drafts, two counter-drafts) the role is null and the file keeps whatever it has.
 */
export function docRolesFromIntake(files: readonly IntakeRoleInput[]): IntakeRoleOutput[] {
  const drafts = files.filter((file) => file.intakeRole === "draft");
  const counters = files.filter((file) => file.intakeRole === "counter-draft");
  return files.map((file): IntakeRoleOutput => {
    switch (file.intakeRole) {
      case "signed":
        return { docId: file.docId, role: "executed" };
      case "reference":
        return { docId: file.docId, role: "context" };
      case "counter-draft":
        return { docId: file.docId, role: counters.length === 1 ? "counterparty-draft" : null };
      case "draft":
        if (counters.length === 1) {
          return { docId: file.docId, role: drafts.length === 1 ? "prior-turn" : null };
        }
        return { docId: file.docId, role: counters.length === 0 && drafts.length === 1 ? "counterparty-draft" : null };
      default:
        return { docId: file.docId, role: null };
    }
  });
}

// -- the side question -----------------------------------------------------------------------------

export type LegalSideCandidateParty = { name: string; role: string };

export type LegalSideResolutionInput = {
  /** What the matter already says. A filled `party` wins over everything. */
  matterSide: LegalSide;
  /** The owner answered "Neither / just reading": never ask again. */
  declined: boolean;
  /** Parties the documents name, in the order found. */
  parties: readonly LegalSideCandidateParty[];
  /** The model's guess, which counts only when it was sure, its quote verified, and its name is one of `parties`. */
  modelPick: { party: string; confidence: "high" | "medium" | "low"; quoteVerified: boolean } | null;
  /** The party of the desk's most recent matter that had a side, if any. Counts only when it is one of `parties`. */
  deskParty: string | null;
};

function distinctParties(parties: readonly LegalSideCandidateParty[]): LegalSideCandidateParty[] {
  const kept: LegalSideCandidateParty[] = [];
  for (const party of parties) {
    if (party.name.trim() !== "" && !kept.some((other) => samePartyName(other.name, party.name))) {
      kept.push({ name: party.name.trim(), role: party.role.trim() });
    }
  }
  return kept;
}

/** One line, at most `TEXT_FIELD_MAX` characters: a side comes from a file's words and is printed in prompts. */
function cut(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > TEXT_FIELD_MAX ? oneLine.slice(0, TEXT_FIELD_MAX) : oneLine;
}

/** The `LegalSide` to store on the matter for `partyName`: its role, and every other detected party as the counterparty. */
export function sideForParty(parties: readonly LegalSideCandidateParty[], partyName: string): LegalSide {
  const all = distinctParties(parties);
  const mine = all.find((party) => samePartyName(party.name, partyName));
  const others = all.filter((party) => party !== mine).map((party) => party.name);
  return {
    role: cut((mine?.role ?? "").toLowerCase()),
    party: cut(mine?.name ?? partyName.trim()),
    counterparty: cut(others.join(COUNTERPARTY_SEPARATOR)),
  };
}

/**
 * Whose side the owner is on, decided in code from what the documents and the desk say (plan section 2):
 *  1. a side already on the matter wins;
 *  2. with at most one party there is nothing to ask;
 *  3. a model pick counts only if it was sure, its quote verified, and the name is a detected party;
 *  4. otherwise the desk's last side, if it is one of the parties;
 *  5. otherwise ask once: up to four names (each ready to PATCH as `side`), plus "Neither".
 */
export function resolveLegalSide(input: LegalSideResolutionInput): LegalSideResolution {
  if (input.matterSide.party.trim() !== "") {
    return { party: input.matterSide.party.trim(), ask: false, candidates: [], source: "matter" };
  }
  if (input.declined) {
    return { party: null, ask: false, candidates: [], source: "declined" };
  }
  const parties = distinctParties(input.parties);
  if (parties.length === 0) {
    return { party: null, ask: false, candidates: [], source: "none" };
  }
  if (parties.length === 1) {
    return { party: (parties[0] as LegalSideCandidateParty).name, ask: false, candidates: [], source: "single" };
  }
  const named = (name: string): LegalSideCandidateParty | undefined =>
    parties.find((party) => samePartyName(party.name, name));
  const pick = input.modelPick;
  const picked = pick && pick.confidence === "high" && pick.quoteVerified ? named(pick.party) : undefined;
  if (picked) {
    return { party: picked.name, ask: false, candidates: [], source: "model" };
  }
  const desk = input.deskParty ? named(input.deskParty) : undefined;
  if (desk) {
    return { party: desk.name, ask: false, candidates: [], source: "desk" };
  }
  const candidates = parties.slice(0, SIDE_CANDIDATES_MAX).map((party) => sideForParty(parties, party.name));
  return { party: null, ask: true, candidates, source: "ask" };
}
