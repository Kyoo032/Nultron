"use client";

import { useState } from "react";
import { FormattedText } from "@/components/formatted-text";
import { getArtifact } from "@/lib/artifacts-client";
import { t } from "@/lib/i18n";
import {
  DOSSIER_TOOL_KEY,
  dossierBodyForView,
  readDossierResult,
  type DossierCardModel,
} from "./tool-rows/dossier-result";

/** The card names this many section headings; the meta line says how many there are in all. */
const OUTLINE_SHOWN = 4;

type BodyState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly markdown: string }
  | { readonly status: "failed" };

type CardProps = {
  readonly model: DossierCardModel;
  /** Starts with the dossier view open. For a test; a person opens it with the Open control. */
  readonly defaultOpen?: boolean;
  /** The dossier text already in hand. For a test; a person's Open loads it from the saved artifact. */
  readonly initialMarkdown?: string;
};

function sourcesLabel(count: number): string {
  return count === 1 ? t("agents.dossier.sourcesOne") : t("agents.dossier.sources", { n: count });
}

function sectionsLabel(count: number): string {
  return count === 1 ? t("agents.dossier.sectionsOne") : t("agents.dossier.sections", { n: count });
}

function checksLabel(failed: number): string {
  return failed === 1 ? t("agents.dossier.checksFailedOne") : t("agents.dossier.checksFailed", { n: failed });
}

/**
 * The dossier the Research agent wrote, under its answer: title, how many sources and sections, whether
 * the checks passed, the first section headings, and Open, which shows the dossier in place. The dossier
 * is the saved artifact (the same row the Research screen opens through `GET /api/v1/artifacts/:id`), so
 * it is read once, on the first Open, and kept for the next. Everything else on the card comes from the
 * saved tool call, so a reopened thread draws the same card.
 */
export function DossierCard({ model, defaultOpen = false, initialMarkdown }: CardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [body, setBody] = useState<BodyState>(
    initialMarkdown === undefined ? { status: "idle" } : { status: "loaded", markdown: initialMarkdown },
  );
  const { artifactId, title } = model;

  async function load(id: string) {
    setBody({ status: "loading" });
    try {
      const record = await getArtifact(id);
      setBody({ status: "loaded", markdown: dossierBodyForView(record.body) });
    } catch {
      setBody({ status: "failed" });
    }
  }

  function onToggle() {
    const next = !open;
    setOpen(next);
    // A second Open reuses the text; a failed or never-started read is tried again.
    if (next && artifactId && (body.status === "idle" || body.status === "failed")) {
      void load(artifactId);
    }
  }

  const headings = model.sections.slice(0, OUTLINE_SHOWN);
  const showView = open && artifactId !== null;

  return (
    <section
      className="min-w-0 rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-3 shadow-elev-1"
      data-testid="chat-dossier-card"
      data-artifact-id={artifactId ?? undefined}
      data-open={showView ? "true" : "false"}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-48">
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-3)]">
            {t("agents.dossier.label")}
          </p>
          <h4
            className="mt-0.5 break-words text-sm font-semibold text-[var(--text)] [overflow-wrap:anywhere]"
            data-testid="chat-dossier-title"
          >
            {title}
          </h4>
          <p
            className="mt-0.5 min-w-0 text-xs text-[var(--text-2)] [overflow-wrap:anywhere]"
            data-testid="chat-dossier-meta"
          >
            {sourcesLabel(model.sourceCount)} · {sectionsLabel(model.sections.length)}
          </p>
          {model.checksPassed ? (
            <p className="mt-0.5 text-xs text-[var(--text-2)]" data-testid="chat-dossier-checks">
              {t("agents.dossier.checksPassed")}
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-[var(--danger)]" data-testid="chat-dossier-checks" data-failed="true">
              {checksLabel(model.failedChecks)}
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
              aria-label={t(open ? "agents.dossier.closeAria" : "agents.dossier.openAria", { title })}
              data-testid="chat-dossier-open"
            >
              {open ? t("agents.dossier.close") : t("agents.dossier.open")}
            </button>
          </div>
        ) : null}
      </div>

      {headings.length > 0 ? (
        <ol
          className="mt-2 space-y-0.5 text-xs text-[var(--text-2)]"
          aria-label={t("agents.dossier.outlineAria")}
          data-testid="chat-dossier-outline"
        >
          {headings.map((heading, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: headings and dossier cards have no id; the index keeps repeated entries distinct
            <li key={`${index}-${heading}`} className="flex min-w-0 gap-2">
              <span className="shrink-0 tabular-nums text-[var(--text-3)]">{index + 1}</span>
              <span className="min-w-0 truncate" title={heading}>
                {heading}
              </span>
            </li>
          ))}
        </ol>
      ) : null}

      {artifactId === null ? (
        <p className="mt-2 text-xs text-[var(--text-3)]" data-testid="chat-dossier-not-saved">
          {t("agents.dossier.notSaved")}
        </p>
      ) : null}

      {showView ? (
        <div
          className="mt-3 max-h-[32rem] min-w-0 overflow-auto border-t border-[var(--line)] pt-3"
          role="region"
          aria-label={t("agents.dossier.viewAria", { title })}
          data-testid="chat-dossier-view"
        >
          {body.status === "loaded" ? (
            <FormattedText text={body.markdown} className="text-sm" testId="chat-dossier-text" />
          ) : body.status === "failed" ? (
            <p className="text-xs text-[var(--danger)]" role="alert" data-testid="chat-dossier-error">
              {t("agents.dossier.loadFailed")}
            </p>
          ) : (
            <p className="text-xs text-[var(--text-3)]" data-testid="chat-dossier-loading">
              {t("agents.dossier.loading")}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}

type ToolCall = { readonly key: string; readonly status: string; readonly input?: unknown; readonly output?: unknown };

/** One card for each finished `research_dossier` call of this turn that wrote a dossier. */
export function DossierCards({ tools }: { readonly tools: readonly ToolCall[] }) {
  const dossiers = tools.flatMap((tool) => {
    if (tool.key !== DOSSIER_TOOL_KEY || tool.status !== "completed") {
      return [];
    }
    const model = readDossierResult(tool.input, tool.output);
    return model ? [model] : [];
  });
  if (dossiers.length === 0) {
    return null;
  }
  return (
    <div className="space-y-2" data-testid="chat-dossier-cards">
      {dossiers.map((model, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: headings and dossier cards have no id; the index keeps repeated entries distinct
        <DossierCard key={`${model.artifactId ?? "unsaved"}-${index}`} model={model} />
      ))}
    </div>
  );
}

/** The name the Chat turn and the other lanes import. */
export { DossierCard as ChatDossierCard };
