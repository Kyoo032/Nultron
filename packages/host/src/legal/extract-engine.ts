/**
 * The extraction run (docs/internal/doc-flow-plan.md section 2, owner rules in 7a):
 *
 *   reading     code: the files as anchored text, cut into calls (every file read in full, nothing picked)
 *   extracting  the model: one call per file group or part
 *   checking    the judges: shape, quotes, values, coverage, scope
 *   (repair)    at most one targeted re-ask, only for the calls that have a failing item
 *   result      code: statuses, locations, conflicts, coverage, file roles, the side question
 *
 * No store access and no gateway here: `ask` and `emit` come in, a record comes out. `extract.ts` wires it to
 * the store, the gateway and the job stream. A model that cannot be read twice, or that fails outright, never
 * silently shrinks the result: the files that call held are marked `partial` or `unread` in `read`.
 */
import { ApiError, type AppLocale } from "@agentforge/core";
import type { DocxDocument } from "@agentforge/core/docx";
import type { JobEmitter } from "@agentforge/core/jobs";
import { type ItemOutcome, normaliseForMatch, outcomesById, summarizeVerdicts } from "@agentforge/core/judges";
import {
  LEGAL_FACT_FIELDS,
  LEGAL_FILE_NAME_MAX,
  LEGAL_MAX_READ_CALLS,
  LEGAL_NOTABLE_FIELD,
  LEGAL_RECORD_LIMITS,
  type DocRole,
  type LegalExtractModelResponse,
  type LegalExtractRecord,
  type LegalFactRecord,
  type LegalItemStatus,
  type LegalPartyRecord,
  type LegalRedFlagRecord,
  type LegalSide,
  type ReadCallPlan,
  buildExtractPrompt,
  docRolesFromIntake,
  fillCopy,
  legalExtractModelSchema,
  legalExtractSystem,
  legalOutputCopy,
  parseModelJson,
  planReadCalls,
  redFlagAgainst,
  resolveLegalSide,
  sideForParty,
} from "@agentforge/core/legal";
import { runChecked } from "../harness/run-checked";
import { throwIfJobAborted } from "../job-stream";
import { type Evidence, buildEvidence } from "./evidence";
import { buildExtractChecks } from "./extract-checks";
import { conflictRecords } from "./extract-view";
import { type CallOutput, type MergedExtract, mergeCallOutputs } from "./extract-merge";
import { emitPhase, emitStep } from "./instructions";
import { mapWithConcurrency } from "./pool";
import type { LegalMatterRecord } from "./records";

export type LegalExtractAsk = (args: { model: string; system: string; prompt: string }) => Promise<string>;

export type LegalExtractInput = {
  readonly matter: LegalMatterRecord;
  readonly docs: ReadonlyMap<string, DocxDocument>;
  /** Paragraph anchor -> page, per file that has one. */
  readonly pages: ReadonlyMap<string, Readonly<Record<string, number>> | null>;
  readonly model: string;
  readonly locale: AppLocale;
  /** The owner's optional steer; "" for the default reading. */
  readonly prompt: string;
  /** The party of the desk's most recent other matter that had a side. */
  readonly deskParty: string | null;
  /** The extraction being replaced, for the roles it set. */
  readonly previous: LegalExtractRecord | null;
  readonly now: () => number;
  /** Test seam: the characters one call carries. */
  readonly budgetChars?: number;
};

export type LegalExtractDeps = {
  readonly ask: LegalExtractAsk;
  readonly emit: JobEmitter;
  readonly abortSignal?: AbortSignal;
  readonly concurrency?: number;
};

export type LegalExtractOutcome = {
  readonly record: LegalExtractRecord;
  /** File roles to set, in code, for files the owner has not given a role of their own. */
  readonly roles: readonly { readonly id: string; readonly role: DocRole }[];
  /** The side to put on the matter: code resolved one and the matter had none. Null otherwise. */
  readonly side: LegalSide | null;
};

const REPAIR_ROUNDS = 1;
const DEFAULT_CONCURRENCY = 3;
const RAW_KEEP_CHARS = 40_000;
const MAX_FIRST_ATTEMPTS = 2;
const AUTO_SIDE_SOURCES: ReadonlySet<string> = new Set(["single", "model", "desk"]);

type Ctx = {
  readonly input: LegalExtractInput;
  readonly deps: LegalExtractDeps;
  readonly system: string;
  readonly plan: readonly ReadCallPlan[];
  readonly copy: ReturnType<typeof legalOutputCopy>;
  /** The first error a call raised, so a run where every call failed reports why. */
  firstError: unknown;
};

function abort(ctx: Ctx): void {
  throwIfJobAborted(ctx.deps.abortSignal);
}

// -- one call ----------------------------------------------------------------------------------------

type Parsed = { readonly response: LegalExtractModelResponse } | { readonly problem: string };

function parseExtract(raw: string): Parsed {
  const json = parseModelJson(raw);
  if (json === null) {
    return { problem: "the answer was not valid JSON" };
  }
  const parsed = legalExtractModelSchema.safeParse(json);
  if (parsed.success) {
    return { response: parsed.data };
  }
  const issue = parsed.error.issues[0];
  return {
    problem: `the answer did not match the required shape (${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid"})`,
  };
}

/** One call. An answer that cannot be read is asked for once more, as every Legal stage does; then it is a failed call. */
async function askCall(
  ctx: Ctx,
  call: ReadCallPlan,
  repair: { previous: string; note: string } | null,
): Promise<CallOutput> {
  const { input, deps } = ctx;
  const matterSide = input.matter.side.party.trim() === "" ? null : input.matter.side;
  const prompt = buildExtractPrompt({
    locale: input.locale,
    side: matterSide,
    prompt: input.prompt,
    call,
    totalCalls: ctx.plan.length,
    repair,
  });
  let problem = "the answer was not valid JSON";
  let raw = "";
  // An unreadable first answer is asked for once more at once; a repair is already the last chance, so it is asked once.
  const attempts = repair === null ? MAX_FIRST_ATTEMPTS : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    abort(ctx);
    try {
      raw = await deps.ask({ model: input.model, system: ctx.system, prompt });
    } catch (error) {
      abort(ctx);
      ctx.firstError ??= error;
      return { index: call.index, docIds: call.docIds, response: null, problem: "the call failed", raw: "" };
    }
    const parsed = parseExtract(raw);
    if ("response" in parsed) {
      return {
        index: call.index,
        docIds: call.docIds,
        response: parsed.response,
        problem: null,
        raw: raw.slice(0, RAW_KEEP_CHARS),
      };
    }
    problem = parsed.problem;
  }
  return { index: call.index, docIds: call.docIds, response: null, problem, raw: raw.slice(0, RAW_KEEP_CHARS) };
}

// -- the record --------------------------------------------------------------------------------------

/** `needle` is written in `haystack`, ignoring case, spacing and quote style. */
function foldedIncludes(haystack: string, needle: string): boolean {
  const wanted = normaliseForMatch(needle, { foldCase: true }).value;
  return wanted !== "" && normaliseForMatch(haystack, { foldCase: true }).value.includes(wanted);
}

function statusOf(outcome: ItemOutcome | undefined): LegalItemStatus {
  return outcome === "verified" ? "verified" : outcome === "not-in-sources" ? "not-in-documents" : "unverified";
}

type Location = { docId: string; anchor: string; clauseId: string | null; page: number | null };

function locationOf(evidence: Evidence, quote: string, docId: string): Location {
  const found = quote.trim() === "" ? null : evidence.verify(quote, docId);
  if (found) {
    const { located } = found;
    return { docId: located.docId, anchor: located.anchor, clauseId: located.clauseId, page: located.page };
  }
  return { docId: evidence.hasDoc(docId) ? docId : "", anchor: "", clauseId: null, page: null };
}

function factRecords(
  merged: MergedExtract,
  evidence: Evidence,
  outcomes: ReadonlyMap<string, ItemOutcome>,
  ctx: Ctx,
): LegalFactRecord[] {
  const labels = ctx.copy.fieldLabels;
  return merged.facts.map((fact) => {
    const where =
      fact.status === "found"
        ? locationOf(evidence, fact.quote, fact.docId)
        : { docId: "", anchor: "", clauseId: null, page: null };
    const label =
      fact.field === LEGAL_NOTABLE_FIELD
        ? fact.label.trim() || (labels[fact.field] ?? "")
        : (labels[fact.field] ?? fact.label);
    return {
      id: fact.id,
      field: fact.field,
      label,
      value: fact.status === "found" ? fact.value : "",
      status: fact.status === "found" ? statusOf(outcomes.get(fact.id)) : "not-in-documents",
      quote: fact.status === "found" ? fact.quote : "",
      ...where,
    };
  });
}

function flagRecords(
  merged: MergedExtract,
  evidence: Evidence,
  outcomes: ReadonlyMap<string, ItemOutcome>,
  side: Pick<LegalSide, "party" | "counterparty">,
): LegalRedFlagRecord[] {
  return merged.redFlags.map((flag) => ({
    id: flag.id,
    title: flag.title,
    why: flag.why,
    severity: flag.severity,
    against: redFlagAgainst(flag.against, side),
    againstParty: ["both", "unknown"].includes(flag.against.trim().toLowerCase()) ? "" : flag.against.trim(),
    status: statusOf(outcomes.get(flag.id)),
    quote: flag.quote,
    ...locationOf(evidence, flag.quote, flag.docId),
  }));
}

function partyRecords(
  merged: MergedExtract,
  evidence: Evidence,
  outcomes: ReadonlyMap<string, ItemOutcome>,
): LegalPartyRecord[] {
  return merged.parties.map((party, index) => ({
    name: party.name,
    role: party.role,
    status: statusOf(outcomes.get(`party:${index}`)),
    quote: party.quote,
    ...locationOf(evidence, party.quote, party.docId),
  }));
}

function coverageRecords(
  facts: readonly LegalFactRecord[],
  outputs: readonly CallOutput[],
): LegalExtractRecord["coverage"] {
  return LEGAL_FACT_FIELDS.map((field) => {
    if (facts.some((fact) => fact.field === field && fact.status !== "not-in-documents")) {
      return { field, state: "stated" as const };
    }
    // "Not stated" is only sure when every call answered: a call that failed may hold the field.
    const everyCallAnswered = outputs.every((output) => output.response !== null);
    const answered = outputs.some((output) =>
      output.response?.facts.some((fact) => fact.field === field && fact.status === "missing"),
    );
    return { field, state: answered && everyCallAnswered ? ("not-stated" as const) : ("unknown" as const) };
  });
}

function readRecord(ctx: Ctx, outputs: readonly CallOutput[], repairs: number): LegalExtractRecord["read"] {
  const readCalls = new Set(outputs.filter((output) => output.response !== null).map((output) => output.index));
  const files = ctx.input.matter.docs.map((card) => {
    const chunks = ctx.plan.flatMap((call) =>
      call.chunks.filter((chunk) => chunk.docId === card.id).map((chunk) => ({ call: call.index, chars: chunk.chars })),
    );
    const read = chunks.filter((chunk) => readCalls.has(chunk.call)).length;
    return {
      docId: card.id,
      name: card.name.slice(0, LEGAL_FILE_NAME_MAX),
      sha256: card.sha256,
      chars: chunks.reduce((total, chunk) => total + chunk.chars, 0),
      chunks: { read, total: chunks.length },
      status: read === chunks.length ? ("read" as const) : read === 0 ? ("unread" as const) : ("partial" as const),
    };
  });
  return {
    calls: ctx.plan.length,
    repairs,
    files,
    partialDocs: files.filter((file) => file.status !== "read").map((file) => file.docId),
  };
}

type RoleDecision = { roles: { id: string; role: DocRole }[]; applied: ReadonlyMap<string, DocRole> };

/** Roles from what the model took each file for. A role the owner set themselves (not `context`, not what an earlier extraction set) stays. */
function roleDecisions(merged: MergedExtract, input: LegalExtractInput): RoleDecision {
  const intake = new Map(merged.files.map((file) => [file.docId, file.role] as const));
  const earlier = new Map((input.previous?.files ?? []).map((file) => [file.docId, file.appliedRole] as const));
  const wanted = docRolesFromIntake(
    input.matter.docs.map((card) => ({ docId: card.id, intakeRole: intake.get(card.id) ?? null })),
  );
  const roles: { id: string; role: DocRole }[] = [];
  const applied = new Map<string, DocRole>();
  for (const entry of wanted) {
    const card = input.matter.docs.find((doc) => doc.id === entry.docId);
    const mine = card && (card.role === "context" || card.role === earlier.get(card.id));
    if (card && entry.role !== null && mine) {
      applied.set(card.id, entry.role);
      if (entry.role !== card.role) {
        roles.push({ id: card.id, role: entry.role });
      }
    }
  }
  return { roles, applied };
}

function buildOutcome(
  ctx: Ctx,
  outputs: readonly CallOutput[],
  judged: ReturnType<typeof buildExtractChecks>,
  summary: ReturnType<typeof summarizeVerdicts>,
  repairs: number,
  evidence: Evidence,
): LegalExtractOutcome {
  const { input } = ctx;
  const merged = mergeCallOutputs(outputs);
  const outcomes = outcomesById(judged.judgements());
  const parties = partyRecords(merged, evidence, outcomes);
  // A party counts as detected when its name is written in the files, whether or not the model quoted it exactly:
  // a misquoted second party must not leave the first as the only one and make it "the" side.
  const grounded = merged.parties
    .filter((party) => evidence.mentions(party.name))
    .map((party) => ({ name: party.name, role: party.role }));
  const pick = merged.side;
  const side = resolveLegalSide({
    matterSide: input.matter.side,
    declined: input.matter.sideDeclined === true,
    parties: grounded,
    modelPick: pick
      ? {
          party: pick.party,
          confidence: pick.confidence,
          // The quote must be in the files AND name the party: a file's own words elsewhere prove nothing about whose side it is.
          quoteVerified:
            pick.quote.trim() !== "" &&
            evidence.verify(pick.quote, "") !== null &&
            foldedIncludes(pick.quote, pick.party),
        }
      : null,
    deskParty: input.deskParty,
  });
  const resolvedSide = side.party ? sideForParty(grounded, side.party) : { role: "", party: "", counterparty: "" };
  const against = input.matter.side.party.trim() === "" ? resolvedSide : input.matter.side;
  const facts = factRecords(merged, evidence, outcomes, ctx).slice(0, LEGAL_RECORD_LIMITS.facts);
  const decisions = roleDecisions(merged, input);
  const intake = new Map(merged.files.map((file) => [file.docId, file] as const));
  const record: LegalExtractRecord = {
    version: 1,
    matterId: input.matter.id,
    createdAt: input.now(),
    model: input.model,
    locale: input.locale,
    prompt: input.prompt.trim(),
    documentType: merged.documentType,
    read: readRecord(ctx, outputs, repairs),
    files: input.matter.docs.map((card) => ({
      docId: card.id,
      intakeRole: intake.get(card.id)?.role ?? null,
      reason: intake.get(card.id)?.reason ?? "",
      appliedRole: decisions.applied.get(card.id) ?? null,
    })),
    parties: parties.slice(0, LEGAL_RECORD_LIMITS.parties),
    facts,
    redFlags: flagRecords(merged, evidence, outcomes, against).slice(0, LEGAL_RECORD_LIMITS.redFlags),
    conflicts: conflictRecords(
      facts
        .filter((fact) => fact.status !== "not-in-documents")
        .map((fact) => ({ id: fact.id, field: fact.field, value: fact.value, docId: fact.docId })),
      input.locale,
    ).slice(0, LEGAL_RECORD_LIMITS.conflicts),
    coverage: coverageRecords(facts, outputs),
    checks: {
      passed: summary.passed,
      rounds: summary.rounds,
      verdicts: summary.verdicts.map((verdict) => ({ ...verdict })),
    },
    side,
  };
  const autoSide = side.party !== null && AUTO_SIDE_SOURCES.has(side.source) && input.matter.side.party.trim() === "";
  return { record, roles: decisions.roles, side: autoSide ? resolvedSide : null };
}

// -- the run -----------------------------------------------------------------------------------------

export async function runLegalExtract(input: LegalExtractInput, deps: LegalExtractDeps): Promise<LegalExtractOutcome> {
  const copy = legalOutputCopy(input.locale);
  throwIfJobAborted(deps.abortSignal);
  if (input.matter.docs.length === 0) {
    throw new ApiError("invalid_request", copy.noFiles, 400);
  }
  emitPhase(deps.emit, "reading", input.locale);
  const readDocs = input.matter.docs.map((card) => {
    const doc = input.docs.get(card.id);
    if (!doc) {
      throw new ApiError("internal_error", `Document ${card.id} could not be loaded`, 500);
    }
    return { id: card.id, name: card.name, doc };
  });
  const plan = planReadCalls(readDocs, input.budgetChars);
  if (plan.length > LEGAL_MAX_READ_CALLS) {
    throw new ApiError("matter_too_large", fillCopy(copy.matterTooLarge, { calls: plan.length }), 413);
  }
  for (const card of input.matter.docs) {
    deps.emit({ type: "job.source", id: card.id, title: card.name, url: card.path, status: "read" });
  }
  emitStep(deps.emit, "reading", fillCopy(copy.readSummary, { files: readDocs.length, calls: plan.length }), {
    current: readDocs.length,
    total: readDocs.length,
  });

  const ctx: Ctx = { input, deps, system: legalExtractSystem(input.locale), plan, copy, firstError: undefined };
  const evidence = buildEvidence(
    input.matter.docs.map((card) => ({
      id: card.id,
      name: card.name,
      doc: input.docs.get(card.id) as DocxDocument,
      pages: input.pages.get(card.id) ?? null,
    })),
  );
  const judged = buildExtractChecks({ evidence, locale: input.locale });
  let outputs: CallOutput[] = [];
  let repairs = 0;

  const produce = async (_note: string | null, round: number): Promise<readonly CallOutput[]> => {
    abort(ctx);
    if (round === 0) {
      emitPhase(deps.emit, "extracting", input.locale);
      let done = 0;
      outputs = await mapWithConcurrency(plan, deps.concurrency ?? DEFAULT_CONCURRENCY, async (call) => {
        const output = await askCall(ctx, call, null);
        done += 1;
        emitStep(deps.emit, "extracting", fillCopy(copy.readingPart, { current: done, total: plan.length }), {
          current: done,
          total: plan.length,
        });
        return output;
      });
      // A gateway that failed every call is not worth a repair; an answer that merely could not be read is.
      failIfNothingRead(ctx, outputs, ctx.firstError !== undefined);
      emitPhase(deps.emit, "checking", input.locale);
      deps.emit({
        type: "job.round",
        round: 1,
        total: 1 + REPAIR_ROUNDS,
        label: fillCopy(copy.roundOf, { round: 1, total: 1 + REPAIR_ROUNDS }),
      });
      return outputs;
    }
    const failing = [...judged.failuresByCall().keys()];
    deps.emit({
      type: "job.round",
      round: 1 + round,
      total: 1 + REPAIR_ROUNDS,
      label: fillCopy(copy.roundOf, { round: 1 + round, total: 1 + REPAIR_ROUNDS }),
    });
    emitStep(
      deps.emit,
      "checking",
      fillCopy(copy.repairing, {
        count: [...judged.failuresByCall().values()].reduce((total, items) => total + items.length, 0),
      }),
    );
    const redone = await mapWithConcurrency(failing, deps.concurrency ?? DEFAULT_CONCURRENCY, async (index) => {
      const call = plan[index] as ReadCallPlan;
      const before = outputs.find((output) => output.index === index) as CallOutput;
      const note = await judged.repairNoteFor(index);
      repairs += 1;
      return askCall(ctx, call, { previous: before.raw || "{}", note: note ?? "" });
    });
    outputs = outputs.map(
      (output) => redone.find((next) => next.index === output.index && next.response !== null) ?? output,
    );
    failIfNothingRead(ctx, outputs, true);
    return outputs;
  };

  const result = await runChecked<readonly CallOutput[]>({
    produce,
    checks: judged.checks,
    repairRounds: REPAIR_ROUNDS,
    ...(deps.abortSignal ? { signal: deps.abortSignal } : {}),
  });
  abort(ctx);
  const summary = summarizeVerdicts(judged.checks, result);
  const outcome = buildOutcome(ctx, outputs, judged, summary, repairs, evidence);
  for (const file of outcome.record.read.files.filter((entry) => entry.status !== "read")) {
    emitStep(deps.emit, "checking", fillCopy(copy.partFailed, { part: file.docId }), { detail: file.docId });
  }
  return outcome;
}

/** When no call produced a readable answer the run has nothing to save: say why instead of saving an empty extraction. */
function failIfNothingRead(ctx: Ctx, outputs: readonly CallOutput[], give: boolean): void {
  if (give && outputs.every((output) => output.response === null)) {
    if (ctx.firstError !== undefined) {
      throw ctx.firstError;
    }
    throw new ApiError("model_unreadable", ctx.copy.modelUnreadable, 502);
  }
}
