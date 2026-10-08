/**
 * A write-up that tells the reader what to do.
 *
 * A finance task describes what the computed figures show. It does not say "you should sell" or "we
 * recommend funding it", whatever the prompt asked of the model: the appraisal's "no buy, sell or fund
 * directive" used to be a sentence in the prompt and nothing more. The scope judge in
 * `@agentforge/core/judges` finds the sentences that advise; this module deals with them the way the
 * direction check deals with a sentence that contradicts a computed figure — one rewrite, then the
 * sentence is taken out — and it spends the run's shared extra call, so a run is still the narrative
 * plus at most one more.
 *
 * Nothing here produces or changes a figure. A rewrite goes back through the number guard like any
 * other model text.
 */
import { withOutputLanguage } from "@agentforge/core";
import { guardNumbers, type FinanceReport, type ReportLocale } from "@agentforge/core/finance";
import type { JobEmitter } from "@agentforge/core/jobs";
import { splitSentences, stripMarkedSentences } from "../finance-section-repair";
import { collectJobAssistantRun } from "../job-regen";
import { throwIfJobAborted } from "../job-stream";
import { extractJsonObject } from "../presentation-outline";
import { takeExtraCall, type CallBudget } from "./call-budget";
import type { DirectionSection } from "./direction";
import { adviceSentencesIn } from "./narrate";
import type { FinanceTaskRunContext } from "./types";

/** What a section says when every sentence in it advised. No figure, and no marker. */
export const ADVICE_EMPTY: Readonly<Record<ReportLocale, string>> = Object.freeze({
  en: "The text of this section was removed because it told the reader what to do. This report describes the figures and gives no advice.",
  id: "Teks bagian ini dihapus karena isinya menyuruh pembaca melakukan sesuatu. Laporan ini menjelaskan angka dan tidak memberi saran.",
});

/** The reader is told once that a sentence went, and why. */
export const ADVICE_SENTENCE_FLAG: Readonly<Record<ReportLocale, string>> = Object.freeze({
  en: "A sentence was removed because it gave advice. This report describes the figures and does not tell you what to do.",
  id: "Satu kalimat dihapus karena berisi saran. Laporan ini menjelaskan angka dan tidak memberi tahu apa yang harus dilakukan.",
});

const ADVICE_SYSTEM = `You rewrite one section of a Nultron finance report.
Return ONLY valid JSON (no markdown fences) with this exact shape: { "heading": string, "body": string }
Rules:
- Describe what the listed facts show. Do not tell the reader what to do: no "you should", no "we recommend", no advice to buy, sell, fund, invest, approve, cut or hire.
- Every number in the body must be one of the facts listed above, written with the same value. Add none.
- Keep the section on its own topic: 2 to 4 short paragraphs, "\\n\\n" between them.`;

const RETRY: Readonly<Record<ReportLocale, string>> = Object.freeze({
  en: "One sentence told the reader what to do. Rewrite this section so it only reports what the figures show, or drop the sentence.",
  id: "Satu kalimat menyuruh pembaca melakukan sesuatu. Tulis ulang bagian ini agar hanya melaporkan apa yang ditunjukkan angka, atau hilangkan kalimatnya.",
});

export type StrippedAdvice = { readonly body: string; readonly removed: string[] };

/**
 * The body with every advising sentence taken out; a paragraph that empties goes with them. A body
 * that does not advise comes back exactly as it was.
 */
export function withoutAdviceSentences(body: string, sources: readonly string[]): StrippedAdvice {
  const advising = new Set(adviceSentencesIn(body, sources));
  if (advising.size === 0) {
    return { body, removed: [] };
  }
  const removed: string[] = [];
  const paragraphs = body.split(/\n{2,}/).map((paragraph) => {
    const kept = splitSentences(paragraph).filter((sentence) => {
      if (!advising.has(sentence.trim())) {
        return true;
      }
      removed.push(sentence.trim());
      return false;
    });
    return kept.join(" ").replace(/\s+/g, " ").trim();
  });
  return { body: paragraphs.filter(Boolean).join("\n\n"), removed };
}

export type ScopeHoldOptions = {
  readonly tenant: FinanceTaskRunContext["tenant"];
  readonly model: string;
  readonly locale: ReportLocale;
  /** The task's own `promptFacts`: the only figures a rewrite may use. */
  readonly factsBlock: string;
  readonly allowed: readonly number[];
  /** The person's own words (source text, question): a sentence copied from them is theirs, not advice. */
  readonly sources: readonly string[];
  readonly emit: JobEmitter;
  readonly phase: string;
  /** The job's cancel, handed to the rewrite call. */
  readonly signal?: AbortSignal;
  /** The run's shared allowance of extra calls. A section with none left is not rewritten. */
  readonly budget?: CallBudget;
};

export type ScopeHoldResult<S extends DirectionSection> = {
  readonly sections: S[];
  /** Sentences that still advised after the one rewrite (or with none), then taken out. */
  readonly adviceRemoved: number;
  /** Sentences the number guard took out of a rewrite. Not an advice failure. */
  readonly amountRemoved: number;
};

function readRewrite(raw: string): string | null {
  try {
    const parsed = JSON.parse(extractJsonObject(raw)) as Record<string, unknown>;
    const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
    return body || null;
  } catch {
    return null;
  }
}

/** One model call: the section's body asked for again, describing the figures and nothing else. */
async function rewriteSection(section: DirectionSection, options: ScopeHoldOptions): Promise<string> {
  const run = await collectJobAssistantRun({
    tenant: options.tenant,
    model: options.model,
    systemPrompt: withOutputLanguage(ADVICE_SYSTEM, "finance", options.locale),
    runPrefix: "finance-scope",
    agentId: "finance",
    jobMode: "finance",
    versionId: "finance-scope",
    prompt: [options.factsBlock, RETRY[options.locale], `Section:\n${section.heading}\n\n${section.body}`]
      .filter(Boolean)
      .join("\n\n"),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return readRewrite(run.text) ?? section.body;
}

/**
 * One rewrite of each section that advises, then the advising sentences go.
 *
 * No advice asks nothing of the model. The heading the task already had is kept; the rewrite is only
 * the body. Each rewrite draws on `options.budget`, and a section with none left has its advising
 * sentences taken out as they stand.
 */
export async function holdReadingScope<S extends DirectionSection>(
  sections: readonly S[],
  options: ScopeHoldOptions,
): Promise<ScopeHoldResult<S>> {
  const advises = (section: DirectionSection) => adviceSentencesIn(section.body, options.sources).length > 0;
  if (!sections.some(advises)) {
    return { sections: [...sections], adviceRemoved: 0, amountRemoved: 0 };
  }
  options.emit({ type: "job.step", phase: options.phase, label: "Reading gave advice" });
  let adviceRemoved = 0;
  let amountRemoved = 0;
  const next: S[] = [];
  for (const section of sections) {
    if (!advises(section)) {
      next.push(section);
      continue;
    }
    throwIfJobAborted(options.signal);
    const rewritten = takeExtraCall(options.budget) ? await rewriteSection(section, options) : section.body;
    const guarded = guardNumbers(rewritten, options.allowed);
    const stripped = stripMarkedSentences(guarded.text);
    amountRemoved += stripped.removed.length;
    const advice = withoutAdviceSentences(stripped.body, options.sources);
    adviceRemoved += advice.removed.length;
    next.push({ ...section, body: advice.body.trim() ? advice.body : ADVICE_EMPTY[options.locale] });
  }
  if (adviceRemoved > 0) {
    options.emit({
      type: "job.step",
      phase: options.phase,
      label: `${adviceRemoved} sentence(s) removed because they gave advice`,
    });
  }
  return { sections: next, adviceRemoved, amountRemoved };
}

/**
 * The reader is told, once, that a sentence went because it advised. This is not the untraced-figure
 * flag: that one says an amount could not be found.
 */
export function withAdviceFlag(report: FinanceReport, removed: number, locale: ReportLocale): FinanceReport {
  const text = ADVICE_SENTENCE_FLAG[locale] ?? ADVICE_SENTENCE_FLAG.en;
  if (removed <= 0 || report.flags.some((flag) => flag.text === text)) {
    return report;
  }
  return { ...report, flags: [...report.flags, { level: "watch", text }] };
}
