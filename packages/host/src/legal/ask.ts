/**
 * Ask a question about the matter's files (docs/internal/doc-flow-plan.md section 2, owner rules in 7a).
 *
 * The files are read in full: all of them go to the model with the question, and a matter too long for one
 * call is cut into parts, one call each (code never picks passages). The answer must carry citations, and
 * every citation is a quote that code found in the file it names. Checks, then at most one repair per call:
 *
 *   legal-answer-cited  an answer has at least one citation, or says the files do not answer
 *   legal-quotes        every citation's quote is in the files
 *   legal-values        the figures and dates in the answer are in the cited passages
 *   legal-scope         no advice, and no statute the files do not cite
 *
 * What survives: the verified citations only. An answer with no verified citation becomes "not in the
 * documents". Answers of several parts are joined in code, in file order. Saved to `asks.json`, newest last,
 * capped at 50; read back newest first.
 */
import { ApiError, type TenantContext } from "@agentforge/core";
import type { DocxDocument } from "@agentforge/core/docx";
import type { JobEmitter } from "@agentforge/core/jobs";
import { normaliseForMatch, scopeHits, summarizeVerdicts } from "@agentforge/core/judges";
import {
  LEGAL_ASKS_CAP,
  LEGAL_FILE_NAME_MAX,
  LEGAL_MAX_READ_CALLS,
  LEGAL_QUOTE_MAX_CHARS,
  LEGAL_RECORD_LIMITS,
  LEGAL_QUOTE_MIN_CHARS,
  type LegalAskCitation,
  type LegalAskModelResponse,
  type LegalAskRecord,
  type LegalAskResult,
  type LegalAsksResponse,
  type LegalItemStatus,
  type ReadCallPlan,
  buildAskPrompt,
  fillCopy,
  legalAskModelSchema,
  legalAskSystem,
  legalOutputCopy,
  parseModelJson,
  planReadCalls,
} from "@agentforge/core/legal";
import type { AppLocale } from "@agentforge/core";
import { runChecked } from "../harness/run-checked";
import { readModelPinned } from "../job-regen";
import { throwIfJobAborted } from "../job-stream";
import { localeForRun } from "../run-context";
import { type CheckDef, type Judged, createCallChecks } from "./call-checks";
import { type Evidence, buildEvidence } from "./evidence";
import { traceClaim } from "./extract-checks";
import { emitPhase, emitStep } from "./instructions";
import { createLegalAsk, requireLegalLive, resolveLegalModel } from "./legal-model";
import { mapWithConcurrency } from "./pool";
import type { LegalMatterRecord } from "./records";
import { legalStore, requireLegalMatter } from "./store";
import type { AskBody } from "./input";

export type LegalAskFn = (args: { model: string; system: string; prompt: string }) => Promise<string>;

export type LegalAskInput = {
  readonly matter: LegalMatterRecord;
  readonly docs: ReadonlyMap<string, DocxDocument>;
  readonly pages: ReadonlyMap<string, Readonly<Record<string, number>> | null>;
  readonly question: string;
  readonly model: string;
  readonly locale: AppLocale;
  readonly now: () => number;
  /** Test seam: the characters one call carries. */
  readonly budgetChars?: number;
};

export type LegalAskDeps = {
  readonly ask: LegalAskFn;
  readonly emit: JobEmitter;
  readonly abortSignal?: AbortSignal;
  readonly concurrency?: number;
};

type AskCallOutput = {
  readonly index: number;
  readonly docIds: readonly string[];
  readonly response: LegalAskModelResponse | null;
  readonly problem: string | null;
  readonly raw: string;
};

const REPAIR_ROUNDS = 1;
const DEFAULT_CONCURRENCY = 3;
const RAW_KEEP_CHARS = 40_000;
const MAX_FIRST_ATTEMPTS = 2;
const QUOTE_WINDOW_CHARS = 240;
const PREVIEW_CHARS = 70;
const ANSWER_ID = "answer";

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}...` : flat;
}

function fail(id: string, call: number, problem: string): Judged {
  return { id, call, ok: false, problem };
}

/** What the model said for one call, with a not-in-the-documents answer cleaned of anything it wrote beside it. */
function parseAnswer(raw: string): { response: LegalAskModelResponse } | { problem: string } {
  const json = parseModelJson(raw);
  if (json === null) {
    return { problem: "the answer was not valid JSON" };
  }
  const parsed = legalAskModelSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      problem: `the answer did not match the required shape (${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid"})`,
    };
  }
  return { response: parsed.data.notInDocuments ? { answer: "", citations: [], notInDocuments: true } : parsed.data };
}

// -- the checks --------------------------------------------------------------------------------------

function citedJudgements(outputs: readonly AskCallOutput[]): Judged[] {
  return outputs.flatMap((output): Judged[] => {
    const response = output.response;
    if (!response) {
      return [fail(ANSWER_ID, output.index, output.problem ?? "the answer was not valid JSON in the required shape")];
    }
    if (response.notInDocuments) {
      return [];
    }
    if (response.answer.trim() === "") {
      return [
        fail(ANSWER_ID, output.index, 'the answer is empty (set "notInDocuments" to true if the files do not answer)'),
      ];
    }
    return response.citations.length === 0 ? [fail(ANSWER_ID, output.index, "the answer has no citation")] : [];
  });
}

function quoteJudgements(outputs: readonly AskCallOutput[], evidence: Evidence): Judged[] {
  return outputs.flatMap((output) =>
    (output.response?.citations ?? []).map((citation, position): Judged => {
      const id = `citation ${position + 1}`;
      const length = citation.quote.trim().length;
      if (length < LEGAL_QUOTE_MIN_CHARS || length > LEGAL_QUOTE_MAX_CHARS) {
        return fail(
          id,
          output.index,
          `the quote must be ${LEGAL_QUOTE_MIN_CHARS} to ${LEGAL_QUOTE_MAX_CHARS} characters (it is ${length})`,
        );
      }
      return evidence.verify(citation.quote, citation.docId)
        ? { id, call: output.index, ok: true }
        : fail(id, output.index, `the quote was not found in the files: "${preview(citation.quote)}"`);
    }),
  );
}

/** The passages around the quotes that were found: the only evidence an answer's figures may rest on. */
function citedEvidence(response: LegalAskModelResponse, evidence: Evidence): string {
  return response.citations
    .map((citation) => evidence.verify(citation.quote, citation.docId))
    .flatMap((found) => (found ? [evidence.window(found, QUOTE_WINDOW_CHARS)] : []))
    .join("\n");
}

function valueJudgements(outputs: readonly AskCallOutput[], evidence: Evidence, locale: AppLocale): Judged[] {
  return outputs.flatMap((output): Judged[] => {
    const response = output.response;
    if (!response || response.notInDocuments || response.answer.trim() === "") {
      return [];
    }
    const passages = citedEvidence(response, evidence);
    if (passages === "") {
      return [];
    }
    const { problem } = traceClaim(response.answer, passages, locale);
    return problem ? [fail(ANSWER_ID, output.index, `the answer ${problem}`)] : [];
  });
}

function scopeJudgements(outputs: readonly AskCallOutput[], evidence: Evidence): Judged[] {
  return outputs.flatMap((output): Judged[] => {
    const hit =
      output.response && !output.response.notInDocuments
        ? scopeHits(output.response.answer, evidence.texts)[0]
        : undefined;
    if (!hit) {
      return [];
    }
    return [
      fail(
        ANSWER_ID,
        output.index,
        hit.kind === "advice"
          ? `gives advice ("${preview(hit.text)}"); say what the files state`
          : `cites "${preview(hit.text)}", which no file cites`,
      ),
    ];
  });
}

function askChecks(evidence: Evidence, locale: AppLocale) {
  const defs: CheckDef<readonly AskCallOutput[]>[] = [
    {
      id: "legal-answer-cited",
      words: {
        error: "The answer is not backed by a citation:",
        why: "Every answer must cite the files it rests on, or say the files do not answer.",
        fix: "Return the whole answer again with at least one exact quote from the files in citations, or set notInDocuments to true. Fix {items}.",
      },
      judge: (outputs) => citedJudgements(outputs),
    },
    {
      id: "legal-quotes",
      words: {
        error: "These citations are not in the files:",
        why: "Code looks every quote up in the files; a quote that is not there word for word is not evidence.",
        fix: "For {items}, copy the exact words from the file (contiguous, no ellipsis, 12 to 400 characters), or drop the citation.",
      },
      judge: (outputs) => quoteJudgements(outputs, evidence),
    },
    {
      id: "legal-values",
      words: {
        error: "The answer states figures or dates the cited passages do not:",
        why: "A figure or date in the answer must be the document's own, in a passage you cite.",
        fix: "For {items}, correct the answer to what the cited passages state, or cite the passage that states it.",
      },
      judge: (outputs) => valueJudgements(outputs, evidence, locale),
    },
    {
      id: "legal-scope",
      words: {
        error: "The answer gives advice or relies on law the files do not cite:",
        why: "The owner asked what the files state, not for advice or for law from outside the files.",
        fix: "Rewrite {items} to say only what the files state.",
      },
      judge: (outputs) => scopeJudgements(outputs, evidence),
    },
  ];
  return createCallChecks(defs);
}

// -- the run -----------------------------------------------------------------------------------------

type Ctx = {
  readonly input: LegalAskInput;
  readonly deps: LegalAskDeps;
  readonly system: string;
  readonly plan: readonly ReadCallPlan[];
  firstError: unknown;
};

async function askCall(
  ctx: Ctx,
  call: ReadCallPlan,
  repair: { previous: string; note: string } | null,
): Promise<AskCallOutput> {
  const { input, deps } = ctx;
  const prompt = buildAskPrompt({
    locale: input.locale,
    question: input.question,
    call,
    totalCalls: ctx.plan.length,
    repair,
  });
  let problem = "the answer was not valid JSON";
  let raw = "";
  // An unreadable first answer is asked for once more at once; a repair is already the last chance, so it is asked once.
  const attempts = repair === null ? MAX_FIRST_ATTEMPTS : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    throwIfJobAborted(deps.abortSignal);
    try {
      raw = await deps.ask({ model: input.model, system: ctx.system, prompt });
    } catch (error) {
      throwIfJobAborted(deps.abortSignal);
      ctx.firstError ??= error;
      return { index: call.index, docIds: call.docIds, response: null, problem: "the call failed", raw: "" };
    }
    const parsed = parseAnswer(raw);
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

function foldKey(text: string): string {
  return normaliseForMatch(text, { foldCase: true }).value;
}

type Contribution = {
  readonly answer: string;
  readonly citations: readonly LegalAskCitation[];
  readonly status: LegalItemStatus;
};

/** One call's surviving answer: verified citations only, and "not in the documents" when none verified. */
function contributionOf(output: AskCallOutput, evidence: Evidence, failed: ReadonlySet<number>): Contribution | null {
  const response = output.response;
  if (!response || response.notInDocuments) {
    return null;
  }
  const citations = response.citations.flatMap((citation): LegalAskCitation[] => {
    const found = evidence.verify(citation.quote, citation.docId);
    return found
      ? [
          {
            docId: found.located.docId,
            quote: citation.quote.trim(),
            anchor: found.located.anchor,
            clauseId: found.located.clauseId,
            page: found.located.page,
          },
        ]
      : [];
  });
  if (citations.length === 0) {
    return null;
  }
  return { answer: response.answer.trim(), citations, status: failed.has(output.index) ? "unverified" : "verified" };
}

function mergeContributions(parts: readonly Contribution[]): {
  answer: string;
  citations: LegalAskCitation[];
  status: LegalItemStatus;
} {
  const answers = [...new Set(parts.map((part) => part.answer))];
  const seen = new Set<string>();
  const citations = parts
    .flatMap((part) => part.citations)
    .filter((citation) => {
      const key = `${citation.docId}|${foldKey(citation.quote)}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, LEGAL_RECORD_LIMITS.askCitations);
  return {
    answer: answers.join("\n\n").slice(0, LEGAL_RECORD_LIMITS.answerChars),
    citations,
    status: parts.every((part) => part.status === "verified") ? "verified" : "unverified",
  };
}

function readRecord(ctx: Ctx, outputs: readonly AskCallOutput[], repairs: number): LegalAskRecord["read"] {
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

export async function runLegalAsk(input: LegalAskInput, deps: LegalAskDeps): Promise<LegalAskRecord> {
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

  const ctx: Ctx = { input, deps, system: legalAskSystem(input.locale), plan, firstError: undefined };
  const evidence = buildEvidence(
    input.matter.docs.map((card) => ({
      id: card.id,
      name: card.name,
      doc: input.docs.get(card.id) as DocxDocument,
      pages: input.pages.get(card.id) ?? null,
    })),
  );
  const judged = askChecks(evidence, input.locale);
  let outputs: AskCallOutput[] = [];
  let repairs = 0;
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;

  const giveUp = (give: boolean): void => {
    if (give && outputs.every((output) => output.response === null)) {
      if (ctx.firstError !== undefined) {
        throw ctx.firstError;
      }
      throw new ApiError("model_unreadable", copy.modelUnreadable, 502);
    }
  };

  const produce = async (_note: string | null, round: number): Promise<readonly AskCallOutput[]> => {
    throwIfJobAborted(deps.abortSignal);
    if (round === 0) {
      emitPhase(deps.emit, "answering", input.locale);
      let done = 0;
      outputs = await mapWithConcurrency(plan, concurrency, async (call) => {
        const output = await askCall(ctx, call, null);
        done += 1;
        emitStep(deps.emit, "answering", fillCopy(copy.readingPart, { current: done, total: plan.length }), {
          current: done,
          total: plan.length,
        });
        return output;
      });
      giveUp(ctx.firstError !== undefined);
      emitPhase(deps.emit, "checking", input.locale);
      return outputs;
    }
    const failing = [...judged.failuresByCall().keys()];
    emitStep(
      deps.emit,
      "checking",
      fillCopy(copy.repairing, {
        count: [...judged.failuresByCall().values()].reduce((total, items) => total + items.length, 0),
      }),
    );
    const redone = await mapWithConcurrency(failing, concurrency, async (index) => {
      const before = outputs.find((output) => output.index === index) as AskCallOutput;
      repairs += 1;
      return askCall(ctx, plan[index] as ReadCallPlan, {
        previous: before.raw || "{}",
        note: (await judged.repairNoteFor(index)) ?? "",
      });
    });
    outputs = outputs.map(
      (output) => redone.find((next) => next.index === output.index && next.response !== null) ?? output,
    );
    giveUp(true);
    return outputs;
  };

  const result = await runChecked<readonly AskCallOutput[]>({
    produce,
    checks: judged.checks,
    repairRounds: REPAIR_ROUNDS,
    ...(deps.abortSignal ? { signal: deps.abortSignal } : {}),
  });
  throwIfJobAborted(deps.abortSignal);

  const failed = new Set(
    judged
      .judgements()
      .filter((judgement) => !judgement.ok)
      .map((judgement) => judgement.call),
  );
  const contributions = outputs.flatMap((output) => {
    const part = contributionOf(output, evidence, failed);
    return part ? [part] : [];
  });
  const answered = outputs.some((output) => output.response !== null && !output.response.notInDocuments);
  if (answered && contributions.length === 0) {
    emitStep(deps.emit, "checking", copy.answerDropped);
  }
  const summary = summarizeVerdicts(judged.checks, result);
  const merged = contributions.length === 0 ? null : mergeContributions(contributions);
  const read = readRecord(ctx, outputs, repairs);
  // Nothing is "verified", and "the documents do not say" is not sure, while a part was not read: the answer may be in it.
  const complete = read.partialDocs.length === 0;
  const notFound: LegalItemStatus = complete ? "not-in-documents" : "unverified";
  return {
    id: crypto.randomUUID(),
    question: input.question.trim(),
    answer: merged ? merged.answer : copy.notInDocuments,
    status: merged ? (complete ? merged.status : "unverified") : notFound,
    notInDocuments: merged === null,
    citations: merged ? merged.citations : [],
    askedAt: input.now(),
    model: input.model,
    read,
    checks: {
      passed: summary.passed,
      rounds: summary.rounds,
      verdicts: summary.verdicts.map((verdict) => ({ ...verdict })),
    },
  };
}

// -- wiring ------------------------------------------------------------------------------------------

/** The saved questions and answers, newest first. */
export function readLegalAsks(tenant: TenantContext, matter: LegalMatterRecord): LegalAsksResponse {
  return { asks: [...legalStore().getAsks(tenant, matter.id).asks].reverse() };
}

export async function generateLegalAsk(
  tenant: TenantContext,
  matterId: string,
  body: AskBody,
  rawBody: unknown,
  emit: JobEmitter,
  abortSignal?: AbortSignal,
): Promise<LegalAskResult> {
  requireLegalLive(tenant);
  const matter = requireLegalMatter(tenant, matterId);
  const locale = localeForRun();
  const store = legalStore();
  const model = resolveLegalModel(tenant, body.model);
  const docs = new Map<string, DocxDocument>();
  const pages = new Map<string, Record<string, number> | null>();
  for (const card of matter.docs) {
    const parsed = await store.readDoc(tenant, matterId, card.id);
    if (!parsed) {
      throw new ApiError("internal_error", `Document ${card.id} could not be loaded`, 500);
    }
    docs.set(card.id, parsed);
    pages.set(card.id, store.readPages(tenant, matterId, card.id));
  }
  const binding = createLegalAsk(tenant, {
    runId: crypto.randomUUID(),
    pinned: readModelPinned(rawBody),
    ...(abortSignal ? { abortSignal } : {}),
  });
  throwIfJobAborted(abortSignal);
  const record = await runLegalAsk(
    { matter, docs, pages, question: body.question, model, locale, now: () => Date.now() },
    { ask: binding.ask, emit, ...(abortSignal ? { abortSignal } : {}) },
  );
  throwIfJobAborted(abortSignal);
  emitPhase(emit, "saving", locale);
  const answered: LegalAskRecord = { ...record, model: binding.answered(model) };
  const history = store.getAsks(tenant, matterId).asks;
  store.saveAsks(tenant, matterId, { version: 1, asks: [...history, answered].slice(-LEGAL_ASKS_CAP) });
  emitStep(emit, "saving", legalOutputCopy(locale).extractSaved);
  return { ask: answered };
}
