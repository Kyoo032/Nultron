import {
  ApiError,
  gatewayRequiredMessage,
  harnessSpecFor,
  hasLiveProvider,
  holdDraftToSource,
  modeMessage,
  resolveChatModel,
  resolveRuntimeMode,
  withOutputLanguage,
  type AppLocale,
  type TenantContext,
} from "@agentforge/core";
import type { CheckVerdict } from "@agentforge/core/harness";
import { loadSettings } from "./settings-store";
import { modeDefaultsFor, listSelectableModels } from "./selectable-models";
import {
  mergeDocumentSection,
  parseDocumentDraft,
  parseDocumentDraftBody,
  parseDocumentSection,
  type DocumentDraft,
} from "./document-outline";
import {
  appendRegenInstruction,
  collectJobAssistantRun,
  collectJobAssistantText,
  readJobRegenAttachments,
  readModelPinned,
  readOptionalInstruction,
  type JobAssistantRun,
} from "./job-regen";
import { throwIfJobAborted } from "./job-stream";
import { withSourceMaterial, withSourceRule } from "./job-source";
import { runChecked } from "./harness/run-checked";
import {
  buildChecksReport,
  documentChecks,
  type DocumentCheckInput,
  type DocumentChecksReport,
} from "./documents-checks";
import { assembleDeskSource } from "./desk-sources";
import { localeForRun } from "./run-context";
import { artifactStore } from "./artifacts";
import { upsertWorkSource } from "./knowledge-ingest";
import { artifactWorkCard, documentDraftMarkdown } from "./work-cards";
import { log } from "./log";

const FINANCE_SYSTEM = `You draft finished finance documents for Nultron — not skeletons.
Return ONLY valid JSON (no markdown fences, no commentary) with this exact shape:
{
  "title": string,
  "sections": [
    { "heading": string, "body": string }
  ]
}
Rules:
- Use only figures the user pasted. Never invent numbers, rates, or balances.
- If a figure is missing, say it is missing. Do not fill it in.
- Each section is finished writing: 2–4 short paragraphs. Use \\n\\n between paragraphs.
- Headings are claims or jobs, not labels.
- No campus / student / course nouns unless the topic itself requires them.`;

const DOCUMENT_SYSTEM = `You draft finished professional documents for Nultron — not skeletons.
Return ONLY valid JSON (no markdown fences, no commentary) with this exact shape:
{
  "title": string,
  "sections": [
    { "heading": string, "body": string }
  ]
}
Rules:
- Honor the user's requested section list and length. Default 5–8 sections (max 12).
- Each section is finished writing: 2–4 short paragraphs, or a tight list. Use \\n\\n between paragraphs. No markdown headings.
- Headings are claims or jobs ("What I need from you"), not labels ("Introduction").
- Use the sample scenario in the prompt. Keep bracketed fields if the user left them. Tag invented figures [sample].
- No TBD, "lorem", "replace this paragraph", "we should consider exploring", or "in today's landscape".
- Do not invent citations, customers, statutes, or quotes.
- No campus / student / course nouns unless the topic itself requires them.`;

function readPrompt(body: unknown): string {
  if (!body || typeof body !== "object") {
    throw new ApiError("invalid_request", "Request body must be a JSON object", 400);
  }
  const prompt = (body as { prompt?: unknown }).prompt;
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new ApiError("invalid_request", "prompt is required", 400);
  }
  return prompt.trim();
}

function readOptionalModel(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const model = (body as { model?: unknown }).model;
  return typeof model === "string" && model.trim() ? model.trim() : undefined;
}

export function isFinanceJob(body: unknown): boolean {
  return Boolean(body && typeof body === "object" && (body as { job?: unknown }).job === "finance");
}

export function documentJobSystemPrompt(finance: boolean, locale: AppLocale = localeForRun()): string {
  const base = finance ? FINANCE_SYSTEM : DOCUMENT_SYSTEM;
  return withOutputLanguage(base, finance ? "finance" : "documents", locale);
}

/** What a repair call adds to the same prompt: the reply that failed, and the checks' note on it. */
type RepairRound = { readonly previous: string; readonly note: string };

/** A reply longer than this is cut when it is quoted back; the note says what to fix, not where. */
const REPAIR_PREVIOUS_MAX_CHARS = 30_000;

function withRepairRound(prompt: string, repair: RepairRound | undefined): string {
  if (!repair) {
    return prompt;
  }
  const previous = repair.previous.slice(0, REPAIR_PREVIOUS_MAX_CHARS);
  return `${prompt}

Your previous reply (correct it, do not repeat it):
<<<
${previous}
>>>

${repair.note}`;
}

/** One draft call. The run says which model answered, which is the one the artifact records. */
async function collectAssistantRun(
  tenant: TenantContext,
  model: string,
  prompt: string,
  finance: boolean,
  sourceText: string,
  modelExplicit: boolean,
  signal?: AbortSignal,
  repair?: RepairRound,
): Promise<JobAssistantRun> {
  return collectJobAssistantRun({
    tenant,
    model,
    // A model the person picked is never swapped by the fallback; a seeded default can be.
    modelExplicit,
    systemPrompt: withSourceRule(documentJobSystemPrompt(finance), sourceText),
    runPrefix: finance ? "finance" : "document",
    agentId: finance ? "finance" : "document",
    jobMode: finance ? "finance" : "documents",
    versionId: finance ? "finance-draft" : "document-draft",
    prompt: withRepairRound(withSourceMaterial(prompt, sourceText), repair),
    ...(signal ? { signal } : {}),
  });
}

/** Mirrors `harness.sourceGap` in `apps/web/locales/{en,id}/documents.json`. The model does not write this line. */
export function documentSourceGap(locale: AppLocale = localeForRun()): string {
  return locale === "id" ? "Tidak ada di sumber." : "Not in the source.";
}

/** Skill: check the draft against the source. Code deletes. No second model call. */
export function holdDocumentSource(draft: DocumentDraft, sourceText: string, onlySection?: number): DocumentDraft {
  if (!sourceText.trim()) {
    return draft;
  }
  return holdDraftToSource(draft, sourceText, documentSourceGap(), onlySection);
}

function requireLiveDocumentRuntime(tenant: TenantContext): ReturnType<typeof loadSettings> {
  const settings = loadSettings(tenant);
  const mode = resolveRuntimeMode({
    settingsHasKey: hasLiveProvider(settings),
    envRuntime: process.env.AGENTFORGE_RUNTIME,
  });
  if (mode === "stub") {
    throw new ApiError("runtime_stub", gatewayRequiredMessage("documents", localeForRun()), 503);
  }
  return settings;
}

function resolveDocumentModel(body: unknown, settings: ReturnType<typeof loadSettings>, tenant: TenantContext): string {
  const catalog = listSelectableModels(tenant);
  const defaults = modeDefaultsFor(tenant);
  return resolveChatModel(
    readOptionalModel(body),
    settings.documentGenModel || (isFinanceJob(body) ? defaults.finance : defaults.documents),
    catalog,
  );
}

/** Save the draft as a `documents / draft` artifact. Never fails the job; returns null when it cannot save. */
function persistDraft(
  tenant: TenantContext,
  draft: DocumentDraft,
  markdown: string,
  meta: Record<string, unknown>,
): string | null {
  try {
    return artifactStore().create(tenant, {
      mode: "documents",
      kind: "draft",
      title: draft.title,
      mime: "text/markdown",
      body: markdown,
      meta,
    }).id;
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "internal_error";
    log.warn("document_draft_not_saved", { code });
    return null;
  }
}

/** The draft as the response carries it: plain, unless a check still fails or a repair was spent. */
export type DocumentDraftResult = DocumentDraft & { checks?: DocumentChecksReport };

/** One model reply read as a draft, or the reason it was not one. */
type DraftAttempt = DocumentCheckInput & {
  readonly run: JobAssistantRun;
  /** The error to answer with when no attempt ever produced a draft. */
  readonly failure: ApiError | null;
};

/**
 * A reply with no JSON object in it fails inside the shared outline reader as `invalid_outline`,
 * worded for a presentation. A Documents reply that fails to read is `invalid_document` either way.
 */
function readAttempt(run: JobAssistantRun): DraftAttempt {
  try {
    return { run, draft: parseDocumentDraft(run.text), parseError: null, failure: null };
  } catch (error) {
    if (error instanceof ApiError && (error.code === "invalid_document" || error.code === "invalid_outline")) {
      const failure =
        error.code === "invalid_document"
          ? error
          : new ApiError("invalid_document", "Model did not return a JSON document draft", 502);
      return { run, draft: null, parseError: failure.message, failure };
    }
    throw error;
  }
}

/** The same checks on a draft the source hold has edited: one look, no repair, no model call. */
async function recheckDraft(
  attempt: DraftAttempt,
  draft: DocumentDraft,
  prompt: string,
  sourceText: string,
): Promise<CheckVerdict[]> {
  const edited: DraftAttempt = { ...attempt, draft, parseError: null };
  const result = await runChecked<DraftAttempt>({
    produce: async () => edited,
    checks: documentChecks(prompt, sourceText),
    repairRounds: 0,
  });
  return result.verdicts;
}

export async function generateDocumentDraft(
  tenant: TenantContext,
  body: unknown,
  abortSignal?: AbortSignal,
): Promise<DocumentDraftResult> {
  const prompt = readPrompt(body);
  const settings = requireLiveDocumentRuntime(tenant);
  const source = await assembleDeskSource(tenant, body, {
    injectionGuardBypass: settings.injectionGuardBypass === true,
  });
  const model = resolveDocumentModel(body, settings, tenant);
  const finance = isFinanceJob(body);
  const pinned = readModelPinned(body);

  // Done is a check that passes, never the model's word. The finance draft keeps its single call.
  // `held` is what the person already has: the last reply that read as a draft, or else the last
  // reply there was. A repair that fails, comes back empty or comes back unreadable must not cost
  // them that draft; only the first call may fail the request, as in Research and Meeting.
  let held: DraftAttempt | null = null;
  let lastText = "";
  const result = await runChecked<DraftAttempt>({
    produce: async (note) => {
      let run: JobAssistantRun;
      try {
        run = await collectAssistantRun(
          tenant,
          model,
          prompt,
          finance,
          source.text,
          pinned,
          abortSignal,
          note === null ? undefined : { previous: lastText, note },
        );
      } catch (error) {
        // A cancel is the one failure that still ends the job.
        throwIfJobAborted(abortSignal);
        if (!held) {
          throw error;
        }
        log.warn("document_repair_failed", { code: error instanceof ApiError ? error.code : "internal_error" });
        return held;
      }
      // A draft the person cancelled is not saved as an artifact or a work card.
      throwIfJobAborted(abortSignal);
      if (!run.text.trim()) {
        if (held) {
          return held;
        }
        throw new ApiError("generation_failed", modeMessage("emptyDocumentDraft", localeForRun()), 502);
      }
      lastText = run.text;
      const attempt = readAttempt(run);
      held = attempt.draft || !held?.draft ? attempt : held;
      return held;
    },
    checks: finance ? [] : documentChecks(prompt, source.text),
    repairRounds: finance ? 0 : harnessSpecFor("documents").repairRounds,
  });
  throwIfJobAborted(abortSignal);

  const final = result.output;
  const parsed = final.draft;
  if (!parsed) {
    throw final.failure ?? new ApiError("invalid_document", "Model returned no usable document draft", 502);
  }
  // After the repair round, code deletes what the source still does not support. No model call here:
  // a retry would invent the replacement. Finance on this route keeps its own number guard.
  const draft = finance ? parsed : holdDocumentSource(parsed, source.text);
  // The checks speak for the draft the person gets, so a hold that changed it is checked again.
  const verdicts = draft === parsed ? result.verdicts : await recheckDraft(final, draft, prompt, source.text);
  const report = buildChecksReport(verdicts, result.rounds, draft, source.text);
  const markdown = documentDraftMarkdown(draft);
  // Record the model that wrote the draft. After a fallback the requested id is the one model that did not.
  const answeredBy = final.run.model;
  const artifactId = persistDraft(tenant, draft, markdown, {
    question: prompt,
    model: answeredBy,
    finance,
    ...(source.files.length > 0 ? { sourceFiles: source.files.map((file) => file.path) } : {}),
    // A pass on the first try is the normal case and adds nothing; a repair or a failure is kept.
    ...(report.passed && report.rounds === 0 ? {} : { checks: report }),
  });
  if (artifactId) {
    await upsertWorkSource(
      tenant,
      artifactWorkCard({ type: "Documents", artifactId, title: draft.title, prompt, markdown, model: answeredBy }),
    );
  }
  return report.passed ? draft : { ...draft, checks: report };
}

const SECTION_SYSTEM = `You rewrite one section of a Nultron document.
Return ONLY valid JSON (no markdown fences, no commentary) with this exact shape:
{ "heading": string, "body": string }
Rules:
- body is plain paragraphs. Use \\n\\n between paragraphs. No markdown headings.
- Stay on the same topic as the rest of the document.
- No campus / student / course nouns unless the topic itself requires them.`;

function readSectionIndex(body: unknown, length: number): number {
  if (!body || typeof body !== "object") {
    throw new ApiError("invalid_request", "Request body must be a JSON object", 400);
  }
  const index = (body as { sectionIndex?: unknown }).sectionIndex;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= length) {
    throw new ApiError("invalid_request", "sectionIndex is out of range", 400);
  }
  return index;
}

export async function regenerateDocumentSection(
  tenant: TenantContext,
  body: unknown,
  abortSignal?: AbortSignal,
): Promise<DocumentDraft> {
  if (!body || typeof body !== "object") {
    throw new ApiError("invalid_request", "Request body must be a JSON object", 400);
  }
  const draft = parseDocumentDraftBody((body as { draft?: unknown }).draft);
  const index = readSectionIndex(body, draft.sections.length);
  const topic =
    typeof (body as { prompt?: unknown }).prompt === "string" ? (body as { prompt: string }).prompt.trim() : "";
  const current = draft.sections[index];
  if (!current) {
    throw new ApiError("invalid_request", "sectionIndex is out of range", 400);
  }
  const settings = requireLiveDocumentRuntime(tenant);
  const model = resolveDocumentModel(body, settings, tenant);
  const attachments = readJobRegenAttachments(body);
  const sourceText = (
    await assembleDeskSource(tenant, body, { injectionGuardBypass: settings.injectionGuardBypass === true })
  ).text;
  const others = draft.sections
    .map((section, itemIndex) => (itemIndex === index ? null : `- ${section.heading}`))
    .filter(Boolean)
    .join("\n");
  const prompt = appendRegenInstruction(
    [
      topic ? `Original topic: ${topic}` : null,
      `Document title: ${draft.title}`,
      others ? `Other sections:\n${others}` : null,
      `Rewrite this section only.\nHeading: ${current.heading}\nBody:\n${current.body}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    readOptionalInstruction(body),
  );

  const raw = await collectJobAssistantText({
    tenant,
    model,
    modelExplicit: readModelPinned(body),
    systemPrompt: withSourceRule(withOutputLanguage(SECTION_SYSTEM, "documents", localeForRun()), sourceText),
    runPrefix: "document-section",
    agentId: "document",
    jobMode: "documents",
    versionId: "document-section",
    prompt: withSourceMaterial(prompt, sourceText),
    attachments,
    ...(abortSignal ? { signal: abortSignal } : {}),
  });
  if (!raw.trim()) {
    throw new ApiError("generation_failed", modeMessage("emptyDocumentSection", localeForRun()), 502);
  }
  return holdDocumentSource(mergeDocumentSection(draft, index, parseDocumentSection(raw)), sourceText, index);
}
