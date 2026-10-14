"use client";

import { useState } from "react";
import { AddToWorkspace } from "@/components/add-to-workspace";
import { PresentationPreview } from "@/components/presentation-preview";
import { downloadArtifactFile } from "@/lib/artifacts-client";
import { saveFailureMessage } from "@/lib/desktop-save";
import { t } from "@/lib/i18n";
import { DECK_TOOL_KEY, readDeckResult, type DeckCardModel } from "./tool-rows/deck-result";

/** The card names this many slides; the count line says how many there are in all. */
const OUTLINE_SHOWN = 4;

type DownloadState = "idle" | "busy" | "failed";

type CardProps = {
  readonly model: DeckCardModel;
  /** Starts with the slide preview open. For a test; a person opens it with the Open control. */
  readonly defaultOpen?: boolean;
};

function slidesLabel(count: number): string {
  return count === 1 ? t("chat.tools.detail.slidesOne") : t("chat.tools.detail.slides", { n: count });
}

/**
 * The deck a Chat turn made, under the answer: its title, how many slides, the first slide headings,
 * Download, and Open, which shows the slides in place with the Presentation mode's own preview (read
 * only: no stage tools, no editing). Everything it shows comes from the saved tool call, so a reopened
 * thread draws the same card. Download goes through the artifact file route like every other file
 * the app saves for a person, so the desktop shell opens its native save dialog there.
 */
export function DeckCard({ model, defaultOpen = false }: CardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [state, setState] = useState<DownloadState>("idle");
  // Why the save failed, when the shell said (the disk refused it): null reads as the generic sentence.
  const [reason, setReason] = useState<string | null>(null);
  const { outline, title, filename } = model;

  async function onDownload() {
    if (state === "busy") {
      return;
    }
    setState("busy");
    setReason(null);
    try {
      await downloadArtifactFile(model.artifactId, filename);
      setState("idle");
    } catch (error) {
      setReason(saveFailureMessage(error));
      setState("failed");
    }
  }

  // A slide's number in the deck is its identity: the title slide is 1, so the first heading is 2.
  const headings = (outline?.slides ?? [])
    .slice(0, OUTLINE_SHOWN)
    .map((slide, offset) => ({ position: offset + 2, heading: slide.heading }));

  return (
    <section
      className="min-w-0 rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-3 shadow-elev-1"
      data-testid="chat-deck-card"
      data-artifact-id={model.artifactId}
      data-open={open && outline ? "true" : "false"}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-48">
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-3)]">
            {t("chat.deck.label")}
          </p>
          <h4
            className="mt-0.5 break-words text-sm font-semibold text-[var(--text)] [overflow-wrap:anywhere]"
            data-testid="chat-deck-title"
          >
            {title}
          </h4>
          <p
            className="mt-0.5 min-w-0 text-xs text-[var(--text-2)] [overflow-wrap:anywhere]"
            data-testid="chat-deck-meta"
          >
            {slidesLabel(model.slideCount)} · {filename}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {outline ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setOpen((current) => !current)}
              aria-expanded={open}
              aria-label={t(open ? "chat.deck.closeAria" : "chat.deck.openAria", { title })}
              data-testid="chat-deck-open"
            >
              {open ? t("chat.deck.close") : t("chat.deck.open")}
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-primary"
            disabled={state === "busy"}
            onClick={() => void onDownload()}
            aria-label={t("chat.deck.downloadAria", { title, filename })}
            data-testid="chat-deck-download"
          >
            {state === "busy" ? t("chat.deck.downloading") : t("chat.deck.download")}
          </button>
          <AddToWorkspace artifactId={model.artifactId} />
        </div>
      </div>

      {state === "failed" ? (
        <p className="mt-2 text-xs text-[var(--danger)]" role="alert" data-testid="chat-deck-error">
          {reason ?? t("chat.deck.downloadFailed")}
        </p>
      ) : null}

      {outline ? (
        <ol
          className="mt-2 space-y-0.5 text-xs text-[var(--text-2)]"
          aria-label={t("chat.deck.outlineAria")}
          data-testid="chat-deck-outline"
        >
          {headings.map(({ position, heading }) => (
            <li key={position} className="flex min-w-0 gap-2">
              <span className="shrink-0 tabular-nums text-[var(--text-3)]">{position}</span>
              <span className="min-w-0 truncate" title={heading}>
                {heading}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-xs text-[var(--text-3)]" data-testid="chat-deck-no-preview">
          {t("chat.deck.noPreview")}
        </p>
      )}

      {open && outline ? (
        <div
          className="mt-3"
          role="region"
          aria-label={t("chat.deck.previewAria", { title })}
          data-testid="chat-deck-preview"
        >
          <PresentationPreview outline={outline} variant="simple" />
        </div>
      ) : null}
    </section>
  );
}

type ToolCall = { readonly key: string; readonly status: string; readonly input?: unknown; readonly output?: unknown };

/** One card for each finished `build_deck` call of this turn that made a deck. */
export function DeckCards({ tools }: { readonly tools: readonly ToolCall[] }) {
  const decks = tools.flatMap((tool) => {
    if (tool.key !== DECK_TOOL_KEY || tool.status !== "completed") {
      return [];
    }
    const model = readDeckResult(tool.input, tool.output);
    return model ? [model] : [];
  });
  if (decks.length === 0) {
    return null;
  }
  return (
    <div className="space-y-2" data-testid="chat-deck-cards">
      {decks.map((model) => (
        <DeckCard key={model.artifactId} model={model} />
      ))}
    </div>
  );
}
