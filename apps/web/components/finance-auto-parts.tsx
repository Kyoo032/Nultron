"use client";

/**
 * The small parts of the prompt-first Finance screen: the drop zone, the "looks like" line, the notes
 * about what was read, and the closed More section. `finance-auto.tsx` owns the state and lays them out.
 */
import { useRef, type ChangeEvent, type DragEvent } from "react";
import { FinanceChooser } from "@/components/finance-steps/finance-guide";
import { ModelSelect } from "@/components/model-select";
import {
  financeAutoSwitchTasks,
  financeAutoWarningText,
  openTaskWithDraft,
  type FinanceAutoAnswer,
} from "@/lib/finance-auto-client";
import type { FinanceAutoSource } from "@/lib/finance-auto-io";
import { FINANCE_IMPORT_ACCEPT } from "@/lib/finance-import-client";
import { financeWarningText } from "@/lib/finance-import-warnings";
import { financeTaskHref, type FinanceTask } from "@/lib/finance-task";
import { t } from "@/lib/i18n";
import type { JobStudioModel } from "@/lib/use-job-model";
import { Link } from "@/lib/nav";

const DROP_ZONE =
  "w-full rounded-lg border border-dashed border-[var(--line)] px-4 py-5 text-center text-sm text-[var(--text-2)] transition-colors hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50";

/** One drop zone. The file is read on the host, with no model, the moment it lands. */
export function AutoDrop({
  fileName,
  reading,
  disabled,
  onFile,
  onRemove,
}: {
  fileName: string | null;
  reading: boolean;
  disabled: boolean;
  onFile: (file: File) => void;
  onRemove: () => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);

  function onPick(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    // Cleared so picking the same file twice still fires a change event.
    event.target.value = "";
    if (file) {
      onFile(file);
    }
  }

  function onDrop(event: DragEvent<HTMLButtonElement>): void {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (!disabled && file) {
      onFile(file);
    }
  }

  return (
    <div className="space-y-2">
      <p className="panel-label">{t("finance.auto.dropLabel")}</p>
      <input
        ref={input}
        type="file"
        accept={FINANCE_IMPORT_ACCEPT}
        className="hidden"
        onChange={onPick}
        disabled={disabled}
        aria-label={t("finance.auto.fileAria")}
        data-testid="finance-auto-input"
      />
      <button
        type="button"
        className={DROP_ZONE}
        onClick={() => input.current?.click()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
        disabled={disabled}
        data-testid="finance-auto-drop"
      >
        <span className="block break-words">
          {reading ? t("finance.auto.dropReading", { name: fileName ?? "" }) : (fileName ?? t("finance.auto.dropHint"))}
        </span>
        {fileName && !reading ? (
          <span className="mt-1 block text-xs text-[var(--text-3)]">{t("finance.auto.dropReplace")}</span>
        ) : null}
      </button>
      {fileName && !reading ? (
        <button type="button" className="btn" onClick={onRemove} disabled={disabled} data-testid="finance-auto-remove">
          {t("finance.auto.remove")}
        </button>
      ) : null}
    </div>
  );
}

const CONFIDENCE_CLASS: Readonly<Record<string, string>> = {
  high: "border-[var(--accent)] text-[var(--accent)]",
  low: "border-[var(--line)] text-[var(--text-3)]",
};

/**
 * "Looks like: <task>" with how sure the read is. With nothing to preview (a question and no figures
 * yet) it says what that task needs, so the next step is never a guess.
 */
export function AutoFit({ answer, checking }: { answer: FinanceAutoAnswer; checking: boolean }) {
  const confidence = answer.fits.confidence;
  return (
    <div className="space-y-1" data-testid="finance-auto-fit" data-task={answer.task} data-confidence={confidence}>
      <p className="flex flex-wrap items-center gap-2 text-sm text-[var(--text)]">
        <span className="text-[var(--text-3)]">{t("finance.auto.looksLike")}:</span>
        <span className="font-medium">{t(`finance.tasks.${answer.task}.label`)}</span>
        <span className={`rounded-full border px-2 py-0.5 text-[11px] ${CONFIDENCE_CLASS[confidence] ?? ""}`}>
          {t(`finance.auto.confidence.${confidence}`)}
        </span>
        {checking ? (
          <span className="text-xs text-[var(--text-3)]" role="status" data-testid="finance-auto-checking">
            {t("finance.auto.checking")}
          </span>
        ) : null}
      </p>
      {answer.input === null ? (
        <p className="text-xs text-[var(--text-2)]" data-testid="finance-auto-needs">
          <span className="font-medium">{t("finance.auto.needsTitle")}:</span> {t(`finance.auto.needs.${answer.task}`)}
        </p>
      ) : null}
    </div>
  );
}

/** Every distinct sentence about what the read left out or assumed, in the reader's language. */
export function noteLines(answer: FinanceAutoAnswer | null, file: FinanceAutoSource | null): string[] {
  const fromHost = (answer?.warnings ?? []).map(financeAutoWarningText);
  const fromFile = (file?.warnings ?? []).map(financeWarningText).filter((line): line is string => line !== null);
  const skipped =
    file && file.skipped.length > 0 ? [t("finance.auto.sheetsSkipped", { names: file.skipped.join(", ") })] : [];
  return [...new Set([...skipped, ...fromFile, ...fromHost].filter((line) => line.trim() !== ""))];
}

/** What was read: the sheets, how many rows, which rows no rule could place, and what was hidden. */
export function AutoNotes({
  answer,
  file,
  lines,
}: {
  answer: FinanceAutoAnswer | null;
  file: FinanceAutoSource | null;
  lines: readonly string[];
}) {
  const pii = Math.max(file?.pii.count ?? 0, answer?.pii.count ?? 0);
  const hasRows = answer !== null && answer.input !== null;
  if (!hasRows && lines.length === 0 && pii === 0) {
    return null;
  }
  return (
    <div className="space-y-2 text-xs text-[var(--text-3)]">
      {hasRows ? (
        <p data-testid="finance-auto-rows" data-rows={answer.rowsUsed}>
          {t("finance.auto.rows", { n: answer.rowsUsed })}
        </p>
      ) : null}
      {file && file.sheetNames.length > 1 ? (
        <p data-testid="finance-auto-sheet" data-sheets={file.sheetNames.length} data-skipped={file.skipped.length}>
          {t("finance.auto.sheets", { names: file.sheetNames.filter((name) => !file.skipped.includes(name)).join(", ") })}
        </p>
      ) : null}
      {answer && answer.unplaced.length > 0 ? (
        <details data-testid="finance-auto-unplaced">
          <summary className="cursor-pointer select-none font-medium text-[var(--text-2)]">
            {t("finance.auto.unplacedTitle", { n: answer.unplaced.length })}
          </summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {answer.unplaced.map((row) => (
              <li key={`${row.label}|${row.period}`} className="break-words">
                {row.period
                  ? t("finance.auto.unplacedRow", { label: row.label, period: row.period })
                  : t("finance.auto.unplacedNoPeriod", { label: row.label })}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {lines.length > 0 ? (
        <div role="status" data-testid="finance-auto-warnings">
          <p className="panel-label">{t("finance.auto.warningsTitle")}</p>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {pii > 0 ? <p data-testid="finance-auto-pii">{t("finance.auto.pii", { n: pii })}</p> : null}
    </div>
  );
}

/**
 * Everything the first screen does not ask for: pasting rows instead of a file, the model, the other
 * tasks, checking the rows on a task's own page, and the old chooser. Closed until the reader asks.
 */
export function AutoMore({
  workspaceId,
  answer,
  prompt,
  figures,
  pasted,
  onPasted,
  locked,
  models,
  model,
  onModel,
}: {
  workspaceId: string | null;
  answer: FinanceAutoAnswer | null;
  prompt: string;
  /** The figures the read was made from: the file's, and anything pasted beside it. */
  figures: string;
  pasted: string;
  onPasted: (value: string) => void;
  locked: boolean;
  models: JobStudioModel[];
  model: string;
  onModel: (value: string) => void;
}) {
  const open = (task: FinanceTask) => () => openTaskWithDraft(workspaceId, task, { prompt, figures });
  return (
    <details className="mt-6 rounded-lg border border-[var(--line)] px-3 py-2" data-testid="finance-more">
      <summary className="cursor-pointer select-none text-xs font-medium text-[var(--text-2)]">
        {t("finance.more.summary")}
      </summary>
      <div className="mt-3 space-y-5">
        <div>
          <label htmlFor="finance-auto-figures" className="panel-label">
            {t("finance.more.pasteLabel")}
          </label>
          <textarea
            id="finance-auto-figures"
            rows={4}
            value={pasted}
            onChange={(event) => onPasted(event.target.value)}
            className="input mt-2 text-[13px]"
            placeholder={t("finance.more.pastePlaceholder")}
            disabled={locked}
            data-testid="finance-auto-figures"
          />
          <p className="mt-1 text-xs text-[var(--text-3)]">{t("finance.more.pasteHint")}</p>
        </div>
        <div>
          <p className="panel-label">{t("finance.more.modelLabel")}</p>
          <div className="mt-2">
            <ModelSelect models={models} value={model} onChange={onModel} disabled={locked} testId="finance-auto-model" />
          </div>
        </div>
        {answer && figures.trim() !== "" ? (
          <div className="space-y-3">
            <div>
              <Link
                href={financeTaskHref(answer.task)}
                onClick={open(answer.task)}
                className="btn"
                data-testid="finance-auto-check-rows"
              >
                {t("finance.more.checkRows")}
              </Link>
              <p className="mt-1 text-xs text-[var(--text-3)]">
                {t("finance.more.checkRowsHint", { task: t(`finance.tasks.${answer.task}.label`) })}
              </p>
            </div>
            <div>
              <p className="panel-label">{t("finance.more.switchTitle")}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {financeAutoSwitchTasks(answer).map((task) => (
                  <Link
                    key={task}
                    href={financeTaskHref(task)}
                    onClick={open(task)}
                    className="btn"
                    data-testid={`finance-auto-switch-${task}`}
                  >
                    {t(`finance.tasks.${task}.label`)}
                  </Link>
                ))}
              </div>
              <p className="mt-1 text-xs text-[var(--text-3)]">{t("finance.more.switchHint")}</p>
            </div>
          </div>
        ) : null}
        <div>
          <p className="panel-label">{t("finance.more.tasksTitle")}</p>
          <div className="mt-2">
            <FinanceChooser />
          </div>
        </div>
      </div>
    </details>
  );
}
