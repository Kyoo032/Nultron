import {
  ApiError,
  harnessSpecFor,
  hasLiveProvider,
  modeMessage,
  resolveChatModel,
  resolveRuntimeMode,
  type TenantContext,
} from "@agentforge/core";
import type { OutputCheck } from "@agentforge/core/harness";
import type { JobEmitter } from "@agentforge/core/jobs";
import { loadSettings } from "./settings-store";
import { listSelectableModels, modeDefaultsFor } from "./selectable-models";
import {
  mergePresentationSlide,
  parsePresentationOutline,
  parsePresentationOutlineBody,
  parsePresentationSlide,
  type PresentationOutline,
} from "./presentation-outline";
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
import { artifactStore } from "./artifacts";
import { upsertWorkSource } from "./knowledge-ingest";
import { artifactWorkCard, presentationOutlineMarkdown } from "./work-cards";
import {
  inspectNultronDesign,
  mergeNultronDesignRetry,
  repairNultronDesign,
  repairNultronOutline,
} from "./presentation-harness";
import {
  presentationDesignLabel,
  presentationGatewayMessage,
  presentationLanguageRule,
  presentationLocale,
  presentationRepairLabel,
  presentationSkillCopy,
  type PresentationLocale,
} from "./presentation-locale";
import { log } from "./log";
import { assertArraysWithin } from "./request-limits";
import { runChecked } from "./harness/run-checked";
import {
  MAX_REQUESTED_SLIDES,
  MIN_REQUESTED_SLIDES,
  presentationCheckNotes,
  presentationChecks,
  type PresentationCheckNote,
} from "./presentation-checks";
import { assembleDeskSource } from "./desk-sources";

const NO_EMIT: JobEmitter = () => {};

const OUTLINE_SYSTEM = `You write finished presentation outlines a stranger can present from. Return ONLY JSON (no markdown fences).
Shape:
{"title":string,"slides":[{"kind":"section"|"bullets"|"split"|"close","heading":string,"subhead":string,"bullets":string[],"aside":string,"notes":string}]}
Rules:
- Honor the requested slide count. Default 8–12 (max 14). title is the title slide — do not add a Title content slide.
- Mix kinds: one section opener, mostly bullets, at least one split, last slide close.
- heading: a spoken claim, 6–14 words. Never Overview, Agenda, Introduction, Team, Traction, Thank you, Q&A, or Next steps.
- subhead: one tightening line.
- bullets: 3–5 complete thoughts, 10–22 words, with names, dates, owners, or decisions. section may have 0–2. No one-word stubs.
- aside: required on split (1–2 sentences to point at). Empty on other kinds.
- notes: required, 40–90 words, what to say if they push back. Not "keep it short."
- Use the sample story. Tag invented figures [sample]. No "excited to share." No TBD. Do not invent revenue, logos, or uptime.
- No campus / student / course nouns unless the topic itself requires them.
- {languageRule}
Example (copy the shape, not the facts):
{"title":"Saturday pickup week of 6 Sep","slides":[{"kind":"section","heading":"The door menu is the only sentence that matters","subhead":"The whiteboard is current; anyone reading the door is a month behind.","bullets":[],"aside":"","notes":"If they say the reprint can wait, remind them anyone who only reads the door will not see the new Saturday hours. Offer a yes or no this Thursday, not a backlog item. Do not bury the gap under process slides."},{"kind":"bullets","heading":"What we can show at the counter today","subhead":"Open the till log if they want evidence.","bullets":["Named bags are ready for the first twenty pre-orders.","The spare card reader sits on the counter, not in the back room.","A second shop can wait; we did not open one here."],"aside":"","notes":"Walk them to the counter if they want proof. Do not send them to a binder they have not opened. The proof is a named bag on this counter, not a plan on paper."},{"kind":"split","heading":"I will not paper over a thin Saturday","subhead":"Old handover cards were one sentence.","bullets":["The counter then ran from guesswork and mixed up two orders.","The checklist now names who collects, what done looks like, and a sample Saturday.","The remaining risk is a Saturday run from a blank card."],"aside":"This is a print miss, not a counter miss.","notes":"If they ask for a prettier menu instead of a better checklist, say the menu only helps when the bags have names and the reader works. Show the checklist if they want proof."},{"kind":"close","heading":"Thursday is a yes or no on the reprint","subhead":"Owner of the call: you.","bullets":["Reprint the door menu this week, or keep the whiteboard.","I will not call the August sheet the current hours.","Friday: a six-line recap whether or not we reprinted."],"aside":"","notes":"If they defer, write deferred on the recap. Do not leave the decision implied. Three outcomes this week; a fourth waits."}]}`;

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

/**
 * Optional `slideCount`: the deck's total slides as the person counts them, title slide included.
 * Returns null when the request sets none.
 */
function readSlideCount(body: unknown): number | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const raw = (body as { slideCount?: unknown }).slideCount;
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < MIN_REQUESTED_SLIDES || raw > MAX_REQUESTED_SLIDES) {
    throw new ApiError(
      "invalid_request",
      `slideCount must be a whole number from ${MIN_REQUESTED_SLIDES} to ${MAX_REQUESTED_SLIDES}`,
      400,
    );
  }
  return raw;
}

/** The count in words the model cannot misread: the title slide is one of the total and is not in "slides". */
function withSlideCount(prompt: string, total: number | null): string {
  return total === null
    ? prompt
    : `${prompt}\n\nSlide count: ${total} slides in total, counting the title slide, so "slides" holds exactly ${total - 1} items.`;
}

function outlineSystem(locale: PresentationLocale): string {
  return OUTLINE_SYSTEM.replace("{languageRule}", presentationLanguageRule(locale));
}

function slideSystem(locale: PresentationLocale): string {
  return `${SLIDE_SYSTEM}\n- ${presentationLanguageRule(locale)}`;
}

type OutlineCall = {
  tenant: TenantContext;
  model: string;
  prompt: string;
  sourceText: string;
  locale: PresentationLocale;
  modelExplicit: boolean;
  /** A repair round: the outline the model wrote before, and the note on what failed. */
  repair?: { previous: string; note: string };
  /** The design pass asks for its own pages; its calls are told apart from the outline's in the run log. */
  versionId?: "presentation-outline" | "presentation-design";
  signal?: AbortSignal;
};

/** The user turn of a repair round: the same request, then the failed outline and the note. */
function repairPrompt(base: string, repair: { previous: string; note: string }): string {
  return `${base}\n\nYour previous outline:\n${repair.previous}\n\n${repair.note}`;
}

/** One outline call. The run says which model answered, which is the one the artifact records. */
function collectAssistantRun(call: OutlineCall): Promise<JobAssistantRun> {
  const base = withSourceMaterial(call.prompt, call.sourceText);
  return collectJobAssistantRun({
    tenant: call.tenant,
    model: call.model,
    // A model the person picked is never swapped by the fallback; a seeded default can be.
    modelExplicit: call.modelExplicit,
    systemPrompt: withSourceRule(outlineSystem(call.locale), call.sourceText),
    runPrefix: "presentation",
    agentId: "presentation",
    jobMode: "presentations",
    versionId: call.versionId ?? "presentation-outline",
    prompt: call.repair ? repairPrompt(base, call.repair) : base,
    ...(call.signal ? { signal: call.signal } : {}),
  });
}

function requireLivePresentationRuntime(tenant: TenantContext): ReturnType<typeof loadSettings> {
  const settings = loadSettings(tenant);
  const mode = resolveRuntimeMode({
    settingsHasKey: hasLiveProvider(settings),
    envRuntime: process.env.AGENTFORGE_RUNTIME,
  });
  if (mode === "stub") {
    throw new ApiError("runtime_stub", presentationGatewayMessage(presentationLocale()), 503);
  }
  return settings;
}

function resolvePresentationModel(
  body: unknown,
  settings: ReturnType<typeof loadSettings>,
  tenant: TenantContext,
): string {
  const catalog = listSelectableModels(tenant);
  const defaults = modeDefaultsFor(tenant);
  return resolveChatModel(readOptionalModel(body), settings.presentationGenModel || defaults.presentations, catalog);
}

/** Save the outline as a `presentations / draft` artifact. Never fails the job. */
function persistOutline(
  tenant: TenantContext,
  outline: PresentationOutline,
  markdown: string,
  meta: Record<string, unknown>,
): string | null {
  try {
    return artifactStore().create(tenant, {
      mode: "presentations",
      kind: "draft",
      title: outline.title,
      mime: "text/markdown",
      body: markdown,
      meta,
    }).id;
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "internal_error";
    log.warn("presentation_outline_not_saved", { code });
    return null;
  }
}

function designRetryPrompt(
  prompt: string,
  outline: PresentationOutline,
  failures: ReturnType<typeof inspectNultronDesign>,
): string {
  const indexes = new Set(failures.map((failure) => failure.index));
  const slides = outline.slides.flatMap((slide, index) =>
    indexes.has(index + 1) ? [{ index: index + 1, ...slide }] : [],
  );
  const notes = failures
    .map((failure) => `${failure.id}: ${failure.reasons.join(", ")} — layout ${failure.layout}`)
    .join("\n");
  return [
    prompt,
    presentationLanguageRule(presentationLocale()),
    'Rewrite only these pages. Return JSON {"title"?: string, "slides":[{"index": number, ...slide}]}.',
    "Do not add a slide. Do not remove a slide. Do not add a digit that is not already on the page or in the topic.",
    "title is one short line. section holds at most two lines. split holds at most five. quote is one sentence. figure is one supplied figure.",
    notes,
    JSON.stringify({ title: indexes.has(0) ? outline.title : undefined, slides }),
  ].join("\n");
}

/**
 * One model reply, with the raw text a repair round shows back to it. A reply that does not read as
 * an outline has no `outline`; `failure` is why, and the first `readable` check turns it into a note.
 */
type Attempt = { text: string; model: string } & (
  | { outline: PresentationOutline; failure: null }
  | { outline: null; failure: ApiError }
);

/** The outline, and what it still fails when the repair round did not get it through every check. */
export type PresentationOutlineResult = PresentationOutline & { checks?: PresentationCheckNote[] };

/** One reply read as an outline, or the reason it was not one. Only an unreadable outline is held back. */
function readAttempt(run: JobAssistantRun): Attempt {
  try {
    return { text: run.text, model: run.model, outline: parsePresentationOutline(run.text), failure: null };
  } catch (error) {
    if (error instanceof ApiError && error.code === "invalid_outline") {
      return { text: run.text, model: run.model, outline: null, failure: error };
    }
    throw error;
  }
}

/** Fails a reply that is not an outline, so the repair round gets a note instead of the request failing at once. */
const READABLE_CHECK: OutputCheck<Attempt> = {
  id: "readable",
  run: (attempt) =>
    attempt.failure
      ? {
          ok: false,
          check: "readable",
          error: `The reply was not a valid outline JSON: ${attempt.failure.message}.`,
          why: "An outline is done when it reads as the JSON shape in the instructions. The studio cannot show or export anything else.",
          fix: 'Return the whole outline again as one JSON object {"title": string, "slides": [{"kind", "heading", "subhead", "bullets", "aside", "notes"}]} with no markdown fences and no commentary.',
        }
      : { ok: true },
};

/** The structure checks look at an outline, so a reply without one has nothing for them to say yet. */
function outlineChecks(expected: number | null): OutputCheck<Attempt>[] {
  return [
    READABLE_CHECK,
    ...presentationChecks(expected).map(
      (check): OutputCheck<Attempt> => ({
        id: check.id,
        run: (attempt) => (attempt.outline ? check.run(attempt.outline) : { ok: true }),
      }),
    ),
  ];
}

type DesignPass = {
  tenant: TenantContext;
  model: string;
  modelExplicit: boolean;
  prompt: string;
  sourceText: string;
  locale: PresentationLocale;
  emit: JobEmitter;
  signal?: AbortSignal;
};

/**
 * The Nultron design pass on an outline that already went through the structure checks: put back
 * what the source and the request did not give, ask once for the crowded pages, then give every
 * page a layout and cut what still does not fit. The slide count never changes.
 */
async function designOutline(outline: PresentationOutline, pass: DesignPass): Promise<PresentationOutline> {
  const copy = presentationSkillCopy(pass.locale);
  const fidelity = { prompt: pass.prompt, sourceText: pass.sourceText, note: copy.note, noFigure: copy.noFigure };
  let next = repairNultronOutline(outline, fidelity);
  pass.emit({ type: "job.phase", phase: "designing", label: presentationDesignLabel("designing", pass.locale) });
  const failures = inspectNultronDesign(next);
  if (failures.length > 0) {
    pass.emit({ type: "job.phase", phase: "repairing", label: presentationDesignLabel("repairing", pass.locale) });
    throwIfJobAborted(pass.signal);
    try {
      const retry = await collectAssistantRun({
        tenant: pass.tenant,
        model: pass.model,
        prompt: designRetryPrompt(pass.prompt, next, failures),
        sourceText: pass.sourceText,
        locale: pass.locale,
        modelExplicit: pass.modelExplicit,
        versionId: "presentation-design",
        ...(pass.signal ? { signal: pass.signal } : {}),
      });
      if (retry.text.trim()) {
        next = repairNultronOutline(
          mergeNultronDesignRetry(
            next,
            retry.text,
            new Set(failures.map((failure) => failure.index)),
            `${pass.prompt}\n${pass.sourceText}`,
          ),
          fidelity,
        );
      }
    } catch {
      // One ask for the failing pages. A crowded page is still repaired in code, but a cancel still ends the job.
      throwIfJobAborted(pass.signal);
    }
  }
  return repairNultronDesign(next);
}

/**
 * Generate a validated presentation outline via the same runtime path as chat. The outline is not
 * done when the model stops: it is done when it passes `presentationChecks`, with the spec's repair
 * rounds to get there. Then the Nultron design pass (`designOutline`) fixes what the source and the
 * request did not give and gives each page a layout; its progress goes out on `emit`. One that still
 * fails a check comes back with `checks` naming what, so the studio can say so. Only an outline with
 * no slides at all is an error.
 */
export async function generatePresentationOutline(
  tenant: TenantContext,
  body: unknown,
  emit: JobEmitter = NO_EMIT,
  abortSignal?: AbortSignal,
): Promise<PresentationOutlineResult> {
  const prompt = readPrompt(body);
  const slideCount = readSlideCount(body);
  const settings = requireLivePresentationRuntime(tenant);
  const locale = presentationLocale();
  const guard = { injectionGuardBypass: settings.injectionGuardBypass === true };
  const source = await assembleDeskSource(tenant, body, guard);
  const model = resolvePresentationModel(body, settings, tenant);
  const modelExplicit = readModelPinned(body);
  const asked = withSlideCount(prompt, slideCount);
  const expected = slideCount === null ? null : slideCount - 1;
  const rounds = harnessSpecFor("presentations").repairRounds;

  // `held` is what the person already has: the last reply that read as an outline, or else the last
  // reply there was. A repair that fails, comes back empty or comes back unreadable must not cost
  // them that outline; only the first call may fail the request, as in Research and Meeting.
  let held: Attempt | null = null;
  let lastText = "";
  const checked = await runChecked<Attempt>({
    produce: async (note) => {
      let run: JobAssistantRun;
      try {
        run = await collectAssistantRun({
          tenant,
          model,
          prompt: asked,
          sourceText: source.text,
          locale,
          modelExplicit,
          ...(note ? { repair: { previous: lastText, note } } : {}),
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
      } catch (error) {
        // A cancel is the one failure that still ends the job.
        throwIfJobAborted(abortSignal);
        if (!held) {
          throw error;
        }
        log.warn("presentation_repair_failed", { code: error instanceof ApiError ? error.code : "internal_error" });
        return held;
      }
      // An outline the person cancelled is not saved as an artifact or a work card.
      throwIfJobAborted(abortSignal);
      if (!run.text.trim()) {
        if (held) {
          return held;
        }
        throw new ApiError("generation_failed", modeMessage("emptyPresentationOutline", locale), 502);
      }
      lastText = run.text;
      const attempt = readAttempt(run);
      held = attempt.outline || !held?.outline ? attempt : held;
      return held;
    },
    checks: outlineChecks(expected),
    repairRounds: rounds,
    onRound: (round) => {
      emit({ type: "job.round", round, total: rounds, label: presentationRepairLabel(locale) });
    },
  });

  const final = checked.output;
  // No attempt ever read as an outline, even after the repair round: the first reply's own error stands.
  if (!final.outline) {
    throw final.failure;
  }
  const answeredBy = final.model;
  // The design pass is the last word on the pages, so the checks are read off what it returns.
  const outline = await designOutline(final.outline, {
    tenant,
    model,
    modelExplicit,
    prompt,
    sourceText: source.text,
    locale,
    emit,
    ...(abortSignal ? { signal: abortSignal } : {}),
  });
  const notes = presentationCheckNotes(outline, expected);
  const markdown = presentationOutlineMarkdown(outline);
  // Record the model that wrote the outline. After a fallback the requested id is the one model that did not.
  const artifactId = persistOutline(tenant, outline, markdown, {
    question: prompt,
    model: answeredBy,
    slides: outline.slides.length,
    ...(source.files.length > 0 ? { sourceFiles: source.files.map((file) => file.path) } : {}),
    ...(checked.rounds > 0 ? { repairRounds: checked.rounds } : {}),
    ...(notes.length > 0 ? { failedChecks: notes.map((note) => note.check) } : {}),
  });
  if (artifactId) {
    await upsertWorkSource(
      tenant,
      artifactWorkCard({ type: "Presentation", artifactId, title: outline.title, prompt, markdown, model: answeredBy }),
    );
  }
  return notes.length > 0 ? { ...outline, checks: notes } : outline;
}

const SLIDE_SYSTEM = `You rewrite one slide of a Nultron presentation.
Return ONLY valid JSON (no markdown fences, no commentary) with this exact shape:
{ "kind": "section" | "bullets" | "split" | "close", "heading": string, "subhead": string, "bullets": string[], "aside": string, "notes": string }
Rules:
- Keep the same kind unless the instruction names a different layout.
- heading is a spoken claim, not a topic label.
- bullets: 3–5 complete thoughts (10–22 words). section may have 0–2. split needs 3–4 plus aside.
- notes: 40–90 words, what to say if they push back.
- Stay on the same topic as the rest of the deck.
- No campus / student / course nouns unless the topic itself requires them.`;

function readSlideIndex(body: unknown, length: number): number {
  if (!body || typeof body !== "object") {
    throw new ApiError("invalid_request", "Request body must be a JSON object", 400);
  }
  const index = (body as { slideIndex?: unknown }).slideIndex;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= length) {
    throw new ApiError("invalid_request", "slideIndex is out of range", 400);
  }
  return index;
}

export async function regeneratePresentationSlide(
  tenant: TenantContext,
  body: unknown,
  abortSignal?: AbortSignal,
): Promise<PresentationOutline> {
  if (!body || typeof body !== "object") {
    throw new ApiError("invalid_request", "Request body must be a JSON object", 400);
  }
  assertArraysWithin((body as { outline?: unknown }).outline, "Presentation outline");
  const outline = parsePresentationOutlineBody((body as { outline?: unknown }).outline);
  const index = readSlideIndex(body, outline.slides.length);
  const topic =
    typeof (body as { prompt?: unknown }).prompt === "string" ? (body as { prompt: string }).prompt.trim() : "";
  const current = outline.slides[index];
  if (!current) {
    throw new ApiError("invalid_request", "slideIndex is out of range", 400);
  }
  const settings = requireLivePresentationRuntime(tenant);
  const locale = presentationLocale();
  const model = resolvePresentationModel(body, settings, tenant);
  const attachments = readJobRegenAttachments(body);
  const guard = { injectionGuardBypass: settings.injectionGuardBypass === true };
  const source = await assembleDeskSource(tenant, body, guard);
  const others = outline.slides
    .map((slide, itemIndex) => (itemIndex === index ? null : `- ${slide.heading}`))
    .filter(Boolean)
    .join("\n");
  const prompt = appendRegenInstruction(
    [
      topic ? `Original topic: ${topic}` : null,
      `Deck title: ${outline.title}`,
      others ? `Other slides:\n${others}` : null,
      `Rewrite this slide only.\nKind: ${current.kind}\nHeading: ${current.heading}\nSubhead: ${current.subhead}\nBullets:\n${current.bullets.map((item) => `- ${item}`).join("\n")}\nAside: ${current.aside}\nNotes: ${current.notes}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    readOptionalInstruction(body),
  );
  const raw = await collectJobAssistantText({
    tenant,
    model,
    modelExplicit: readModelPinned(body),
    systemPrompt: withSourceRule(slideSystem(locale), source.text),
    runPrefix: "presentation-slide",
    agentId: "presentation",
    jobMode: "presentations",
    versionId: "presentation-slide",
    prompt: withSourceMaterial(prompt, source.text),
    attachments,
    ...(abortSignal ? { signal: abortSignal } : {}),
  });
  if (!raw.trim()) {
    throw new ApiError("generation_failed", modeMessage("emptySlide", locale), 502);
  }
  const copy = presentationSkillCopy(locale);
  const repaired = repairNultronOutline(
    mergePresentationSlide(outline, index, parsePresentationSlide(raw)),
    {
      prompt: topic,
      sourceText: source.text,
      note: copy.note,
      noFigure: copy.noFigure,
    },
    index,
  );
  const designed = repairNultronDesign(repaired);
  return {
    ...repaired,
    slides: repaired.slides.map((slide, slideIndex) =>
      slideIndex === index ? (designed.slides[slideIndex] ?? slide) : slide,
    ),
  };
}
