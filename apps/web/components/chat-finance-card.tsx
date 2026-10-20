"use client";

import { useState } from "react";
import type { ReportLocale } from "@agentforge/core/finance";
import { FormattedText } from "@/components/formatted-text";
import { FinanceResultPanel } from "@/components/finance-steps/finance-result-panel";
import { financeStepsFor } from "@/components/finance-steps/registry";
import { getArtifact } from "@/lib/artifacts-client";
import { downloadFinanceExport } from "@/lib/finance-export";
import { financeOpenView, type FinanceArtifactRecord, type FinanceOpenView } from "@/lib/finance-open-view";
import { getLocale, t } from "@/lib/i18n";
import {
  FINANCE_TASK_TOOL_KEY,
  readFinanceResult,
  type FinanceCardModel,
  type FinanceHeadlineFigure,
} from "./tool-rows/finance-result";

const DOWNLOAD_FORMATS = ["xlsx", "docx"] as const;

type DownloadFormat = (typeof DOWNLOAD_FORMATS)[number];

const FORMAT_KEYS: Readonly<Record<DownloadFormat, string>> = {
  xlsx: "agents.finance.downloadXlsx",
  docx: "agents.finance.downloadDocx",
};

type ViewState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly view: FinanceOpenView }
  | { readonly status: "failed" };

type CardProps = {
  readonly model: FinanceCardModel;
  readonly defaultOpen?: boolean;
  readonly initialArtifact?: FinanceArtifactRecord;
};

function plural(n: number, one: string, many: string): string {
  return n === 1 ? t(one) : t(many, { n });
}

function checkProblems(model: FinanceCardModel): string | null {
  const parts = [
    model.flagged > 0 ? plural(model.flagged, "agents.finance.flaggedOne", "agents.finance.flagged") : null,
    model.removed > 0 ? plural(model.removed, "agents.finance.removedOne", "agents.finance.removed") : null,
    model.notes.length > 0 ? plural(model.notes.length, "agents.finance.notesOne", "agents.finance.notes") : null,
  ].filter((part): part is string => part !== null);
  if (parts.length > 0) {
    return parts.join(" · ");
  }
  return model.checksPassed ? null : t("agents.finance.checksUnknown");
}

function figureText(figure: FinanceHeadlineFigure): string {
  return figure.unit ? `${figure.value} ${figure.unit}` : figure.value;
}

function HeadlineFigure({ figure }: { readonly figure: FinanceHeadlineFigure }) {
  return (
    <div className="min-w-0 rounded-lg border border-[var(--line)] px-2 py-1.5" data-testid="chat-finance-figure">
      <dt className="truncate text-[11px] text-[var(--text-3)]" title={figure.label}>
        {figure.label}
      </dt>
      <dd className="text-sm font-semibold tabular-nums text-[var(--text)] [overflow-wrap:anywhere]">
        {figureText(figure)}
      </dd>
    </div>
  );
}

function viewLocale(view: FinanceOpenView): ReportLocale {
  if (view.kind === "report" && view.result.report) {
    return view.result.report.locale;
  }
  return getLocale() === "id" ? "id" : "en";
}

function OpenView({ view, task }: { readonly view: FinanceOpenView; readonly task: FinanceCardModel["task"] }) {
  if (view.kind === "markdown") {
    return <FormattedText text={view.markdown} className="text-sm" testId="chat-finance-text" />;
  }
  const panelTask = view.kind === "brief" ? "brief" : task;
  const Panel = financeStepsFor(panelTask).Result ?? FinanceResultPanel;
  return (
    <Panel
      result={view.result}
      task={panelTask}
      locale={viewLocale(view)}
      models={[]}
      defaultModel=""
      regeneratingIndex={null}
      disabled
    />
  );
}

function CheckNotes({ notes }: { readonly notes: FinanceCardModel["notes"] }) {
  if (notes.length === 0) {
    return null;
  }
  return (
    <section className="mb-3" data-testid="chat-finance-notes">
      <h5 className="text-xs font-medium text-[var(--text-2)]">{t("agents.finance.notesTitle")}</h5>
      <ul className="mt-1 space-y-0.5 text-xs text-[var(--text-2)]">
        {notes.map((note, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: notes have no id; the index keeps repeated codes distinct
          <li key={`${index}-${note.code}`} className="[overflow-wrap:anywhere]" data-testid="chat-finance-note">
            {note.message}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function FinanceCard({ model, defaultOpen = false, initialArtifact }: CardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [body, setBody] = useState<ViewState>(
    initialArtifact === undefined ? { status: "idle" } : { status: "loaded", view: financeOpenView(initialArtifact) },
  );
  const [downloading, setDownloading] = useState<DownloadFormat | null>(null);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const { artifactId, title } = model;

  async function load(id: string) {
    setBody({ status: "loading" });
    try {
      const record = await getArtifact(id);
      setBody({ status: "loaded", view: financeOpenView(record) });
    } catch {
      setBody({ status: "failed" });
    }
  }

  function onToggle() {
    const next = !open;
    setOpen(next);
    if (next && artifactId && (body.status === "idle" || body.status === "failed")) {
      void load(artifactId);
    }
  }

  async function onDownload(id: string, format: DownloadFormat) {
    setDownloading(format);
    setDownloadFailed(false);
    try {
      await downloadFinanceExport({ artifactId: id, format, task: model.task }, t("agents.finance.downloadFailed"));
    } catch {
      setDownloadFailed(true);
    } finally {
      setDownloading(null);
    }
  }

  const problems = checkProblems(model);
  const showView = open && artifactId !== null;

  return (
    <section
      className="min-w-0 rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-3 shadow-elev-1"
      data-testid="chat-finance-card"
      data-artifact-id={artifactId ?? undefined}
      data-open={showView ? "true" : "false"}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-48">
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-3)]">
            {t("agents.finance.taskLine", { task: t(`finance.tasks.${model.task}.label`) })}
          </p>
          <h4
            className="mt-0.5 break-words text-sm font-semibold text-[var(--text)] [overflow-wrap:anywhere]"
            data-testid="chat-finance-title"
          >
            {title}
          </h4>
          {problems === null ? (
            <p className="mt-0.5 text-xs text-[var(--text-2)]" data-testid="chat-finance-checks">
              {t("agents.finance.checksPassed")}
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-[var(--danger)]" data-testid="chat-finance-checks" data-failed="true">
              {problems}
            </p>
          )}
        </div>
        {artifactId ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onToggle}
              aria-expanded={open}
              aria-label={t(open ? "agents.finance.closeAria" : "agents.finance.openAria", { title })}
              data-testid="chat-finance-open"
            >
              {open ? t("agents.finance.close") : t("agents.finance.open")}
            </button>
            {DOWNLOAD_FORMATS.map((format) => (
              <button
                key={format}
                type="button"
                className="btn btn-secondary"
                onClick={() => void onDownload(artifactId, format)}
                disabled={downloading !== null}
                aria-label={t("agents.finance.downloadAria", { title, format: t(FORMAT_KEYS[format]) })}
                data-testid={`chat-finance-download-${format}`}
              >
                {downloading === format ? t("agents.finance.downloading") : t(FORMAT_KEYS[format])}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {model.headline.length > 0 ? (
        <dl
          className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4"
          aria-label={t("agents.finance.headlineAria")}
          data-testid="chat-finance-headline"
        >
          {model.headline.map((figure, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: headline figures have no id; the index keeps repeated labels distinct
            <HeadlineFigure key={`${index}-${figure.label}`} figure={figure} />
          ))}
        </dl>
      ) : null}

      {downloadFailed ? (
        <p className="mt-2 text-xs text-[var(--danger)]" role="alert" data-testid="chat-finance-download-error">
          {t("agents.finance.downloadFailed")}
        </p>
      ) : null}

      {artifactId === null ? (
        <p className="mt-2 text-xs text-[var(--text-3)]" data-testid="chat-finance-not-saved">
          {t("agents.finance.notSaved")}
        </p>
      ) : null}

      {showView ? (
        <div
          className="mt-3 max-h-[32rem] min-w-0 overflow-auto border-t border-[var(--line)] pt-3"
          role="region"
          aria-label={t("agents.finance.viewAria", { title })}
          data-testid="chat-finance-view"
        >
          <CheckNotes notes={model.notes} />
          {body.status === "loaded" ? (
            <OpenView view={body.view} task={model.task} />
          ) : body.status === "failed" ? (
            <p className="text-xs text-[var(--danger)]" role="alert" data-testid="chat-finance-error">
              {t("agents.finance.loadFailed")}
            </p>
          ) : (
            <p className="text-xs text-[var(--text-3)]" data-testid="chat-finance-loading">
              {t("agents.finance.loading")}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}

type ToolCall = { readonly key: string; readonly status: string; readonly input?: unknown; readonly output?: unknown };

export function FinanceCards({ tools }: { readonly tools: readonly ToolCall[] }) {
  const results = tools.flatMap((tool) => {
    if (tool.key !== FINANCE_TASK_TOOL_KEY || tool.status !== "completed") {
      return [];
    }
    const model = readFinanceResult(tool.input, tool.output);
    return model ? [model] : [];
  });
  if (results.length === 0) {
    return null;
  }
  return (
    <div className="space-y-2" data-testid="chat-finance-cards">
      {results.map((model, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: finance cards have no id of their own; the index keeps repeated results distinct
        <FinanceCard key={`${model.artifactId ?? "unsaved"}-${index}`} model={model} />
      ))}
    </div>
  );
}
