"use client";

/**
 * Finance, prompt first (docs/internal/doc-flow-plan.md section 3 and the owner's answers in 7a).
 *
 * `/finance` with no task opens on one prompt box and one drop zone, with nothing to fill in first.
 * A dropped file is read on the host with no model, matched to the Finance task it fits, and drawn as
 * a free preview (KPIs, tables, charts, all computed in code) with what it read and what it could not
 * place. Typing a question with no file reads it too, and says what the task would need.
 *
 * The paid step is `Write it up`, and it runs only when it is pressed: the same `/finance/stream` the
 * task pages use, sent the confirmed input the preview was computed from. Nothing here calls it on a
 * drop, at any confidence. Everything else (the model, pasting rows, reading the same figures as
 * another task, the chooser) sits in the closed More section.
 */
import { useState, type FormEvent } from "react";
import { Confetti } from "@/components/confetti";
import { FinanceAutoPreview } from "@/components/finance-auto-preview";
import { AutoDrop, AutoFit, AutoMore, AutoNotes, noteLines } from "@/components/finance-auto-parts";
import { FinanceExportMenu } from "@/components/finance-export-menu";
import { FinanceResultNotices } from "@/components/finance-steps/finance-result-notices";
import { FinanceResultPanel } from "@/components/finance-steps/finance-result-panel";
import { financeStepsFor } from "@/components/finance-steps/registry";
import { JobProgressList } from "@/components/job-progress";
import type { JobRegenSubmit } from "@/components/job-regen-panel";
import { ModeIllustration } from "@/components/mode-illustration";
import { NeedsKeyNote } from "@/components/needs-key-note";
import { WorkingStatus } from "@/components/working-status";
import { canWriteUp, financeAutoStreamBody, joinFigures } from "@/lib/finance-auto-client";
import { readFinanceFileForAuto, type FinanceAutoSource } from "@/lib/finance-auto-io";
import { regenerateFinanceSection, type FinanceResult } from "@/lib/finance-client";
import { financePhaseLabel } from "@/lib/finance-phase-label";
import type { FinanceTask } from "@/lib/finance-task";
import { isGatewayBlockedText } from "@/lib/gateway-blocked";
import { getLocale, t } from "@/lib/i18n";
import { regenModelPick } from "@/lib/model-choice";
import { useFinanceAutoRead } from "@/lib/use-finance-auto-read";
import type { JobStudioModel } from "@/lib/use-job-model";
import { useJobStream } from "@/lib/use-job-stream";

export type FinanceAutoProps = {
  workspaceId: string | null;
  /** Hosted only: no usable gateway key. The free read still works; only Write it up is quiet. */
  needsKey: boolean;
  models: JobStudioModel[];
  model: string;
  /** True only when the person moved the picker, so a seeded default stays rescuable by the host. */
  modelPinned: boolean;
  onModel: (value: string) => void;
};

/** What a write-up was made from, kept so a rewrite sends the same input even after the screen moves on. */
type Written = { readonly task: FinanceTask; readonly input: Readonly<Record<string, unknown>> };

export function FinanceAuto({ workspaceId, needsKey, models, model, modelPinned, onModel }: FinanceAutoProps) {
  const language = getLocale() === "id" ? "id" : "en";
  const [prompt, setPrompt] = useState("");
  const [pasted, setPasted] = useState("");
  const [file, setFile] = useState<FinanceAutoSource | null>(null);
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [result, setResult] = useState<FinanceResult | null>(null);
  const [written, setWritten] = useState<Written | null>(null);
  const [landed, setLanded] = useState(0);
  const [regenIndex, setRegenIndex] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const job = useJobStream<FinanceResult>();

  const figures = joinFigures(file?.figuresText ?? "", pasted);
  const read = useFinanceAutoRead({
    figures,
    proseText: file?.proseText,
    sheetNames: file?.sheetNames,
    prompt,
    locale: language,
  });
  const answer = read.answer;
  const locked = job.busy || regenIndex !== null;
  const writable = answer !== null && canWriteUp(answer) && !read.checking && !locked && !reading && !needsKey;
  // A read or file problem belongs at the top, by the inputs. A write-up problem belongs under the
  // button that was pressed, which on a long preview is a screen away from the top.
  const shown = (message: string | null) => (message && !isGatewayBlockedText(message) ? message : null);
  const readError = shown(fileError ?? read.error);
  const writeError = shown(actionError ?? job.error?.message ?? null);
  const lines = noteLines(answer, file);

  /** A write-up belongs to the figures it was made from. New figures start clean. */
  function invalidate(): void {
    setResult(null);
    setWritten(null);
    setActionError(null);
    job.reset();
  }

  async function onFile(next: File): Promise<void> {
    setFileError(null);
    setPendingName(next.name);
    setReading(true);
    invalidate();
    try {
      setFile(await readFinanceFileForAuto(next));
    } catch (failure) {
      setFile(null);
      setFileError(failure instanceof Error ? failure.message : t("finance.auto.errors.file"));
    } finally {
      setReading(false);
    }
  }

  function onRemove(): void {
    setFile(null);
    setFileError(null);
    invalidate();
  }

  function onPasted(value: string): void {
    setPasted(value);
    if (result) {
      invalidate();
    }
  }

  async function onWrite(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!answer || !writable || !answer.input) {
      return;
    }
    setActionError(null);
    const snapshot: Written = { task: answer.task, input: answer.input };
    const next = await job.run(
      "/api/v1/finance/stream",
      financeAutoStreamBody(answer, { prompt, language, model, modelPinned }),
    );
    if (next) {
      setResult(next);
      setWritten(snapshot);
      setLanded((count) => count + 1);
    }
  }

  async function onRegenerate(index: number, payload: JobRegenSubmit): Promise<void> {
    if (!result || !written || locked || needsKey) {
      return;
    }
    setRegenIndex(index);
    setActionError(null);
    try {
      setResult(
        await regenerateFinanceSection({
          brief: result.brief,
          sectionIndex: index,
          prompt,
          instruction: payload.instruction,
          ...regenModelPick(payload.model, model, modelPinned),
          artifactId: result.artifactId ?? undefined,
          inputs: { ...written.input, task: written.task },
        }),
      );
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : t("finance.errors.regen"));
    } finally {
      setRegenIndex(null);
    }
  }

  const StepResult = written ? (financeStepsFor(written.task).Result ?? FinanceResultPanel) : FinanceResultPanel;
  const showProgress = job.busy || (job.progress.phases.length > 0 && !result);

  return (
    <form className="mt-4 space-y-5" onSubmit={(event) => void onWrite(event)} data-testid="finance-auto">
      {needsKey ? <NeedsKeyNote testId="finance-needs-key" className="text-sm text-[var(--text-2)]" /> : null}
      <section className="space-y-4 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4">
        <div>
          <label htmlFor="finance-auto-prompt" className="panel-label">
            {t("finance.auto.promptLabel")}
          </label>
          <textarea
            id="finance-auto-prompt"
            rows={3}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            className="input mt-2 text-[13px]"
            placeholder={t("finance.auto.promptPlaceholder")}
            disabled={locked}
            data-testid="finance-auto-prompt"
          />
          <p className="mt-1 text-xs text-[var(--text-3)]">{t("finance.auto.promptHint")}</p>
        </div>
        <AutoDrop
          fileName={reading ? pendingName : (file?.fileName ?? null)}
          reading={reading}
          disabled={locked}
          onFile={(next) => void onFile(next)}
          onRemove={onRemove}
        />
      </section>
      {readError ? (
        <p className="text-sm text-[var(--danger)]" role="alert" data-testid="finance-auto-error">
          {readError}
        </p>
      ) : null}
      {answer ? (
        <AutoFit answer={answer} checking={read.checking} />
      ) : read.checking ? (
        <p className="text-xs text-[var(--text-3)]" role="status" data-testid="finance-auto-checking">
          {t("finance.auto.checking")}
        </p>
      ) : null}
      {answer?.preview ? <FinanceAutoPreview report={answer.preview} /> : null}
      <AutoNotes answer={answer} file={file} lines={lines} />
      <div className="space-y-1" data-testid="finance-auto-write-row">
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary" disabled={!writable} data-testid="finance-auto-write">
            {job.busy ? <WorkingStatus label={t("finance.auto.writing")} /> : t("finance.auto.write")}
          </button>
          {job.busy ? (
            <button type="button" className="btn" onClick={job.cancel} data-testid="finance-auto-cancel">
              {t("finance.auto.cancel")}
            </button>
          ) : null}
        </div>
        <p className="text-xs text-[var(--text-3)]" data-testid="finance-auto-write-note">
          {t("finance.auto.writeNote")}
        </p>
        {!answer?.input && !read.checking && !reading ? (
          <p className="text-xs text-[var(--text-3)]" data-testid="finance-auto-write-hint">
            {t("finance.auto.writeNeedsFigures")}
          </p>
        ) : null}
        {writeError ? (
          <p className="pt-1 text-sm text-[var(--danger)]" role="alert" data-testid="finance-auto-write-error">
            {writeError}
          </p>
        ) : null}
      </div>
      {showProgress ? (
        <JobProgressList
          progress={job.progress}
          busy={job.busy}
          mode="finance"
          testId="finance-auto-progress"
          labelFor={financePhaseLabel}
        />
      ) : null}
      {result && written ? (
        <div className="enter-rise relative space-y-4" data-testid="finance-auto-result" data-task={written.task}>
          {landed > 0 ? <Confetti key={landed} /> : null}
          <FinanceResultNotices result={result} />
          <StepResult
            result={result}
            task={written.task}
            locale={language}
            models={models}
            defaultModel={model}
            regeneratingIndex={regenIndex}
            onRegenerate={(index, payload) => void onRegenerate(index, payload)}
            disabled={locked || needsKey}
          />
          <div className="flex flex-wrap items-center gap-2">
            <FinanceExportMenu
              result={result}
              task={written.task}
              report={result.report}
              artifactId={result.artifactId}
              workspaceId={workspaceId}
              disabled={locked}
              emphasis="primary"
            />
          </div>
        </div>
      ) : null}
      {!answer && !result && !job.busy && !reading && !read.checking ? (
        <div
          className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-10 text-center text-[var(--text-2)]"
          data-testid="finance-auto-empty"
        >
          <ModeIllustration mode="finance" />
          <p className="mt-4 font-medium text-[var(--text)]">{t("finance.emptyOutcome")}</p>
          <p className="mt-1.5 text-sm text-[var(--text-3)]">{t("finance.auto.empty")}</p>
        </div>
      ) : null}
      <AutoMore
        workspaceId={workspaceId}
        answer={answer}
        prompt={prompt}
        figures={figures}
        pasted={pasted}
        onPasted={onPasted}
        locked={locked}
        models={models}
        model={model}
        onModel={onModel}
      />
    </form>
  );
}
