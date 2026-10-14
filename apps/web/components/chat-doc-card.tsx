"use client";

import { useState } from "react";
import { AddToWorkspace } from "@/components/add-to-workspace";
import { saveChatFile } from "@/lib/chat-file-save";
import { t } from "@/lib/i18n";
import { isDocTool, readDocResult, type DocCardModel, type DocFormat } from "./tool-rows/doc-result";

type DownloadState = "idle" | "busy" | "failed";

type CardProps = {
  readonly model: DocCardModel;
};

const FORMAT_LABEL_KEY: Readonly<Record<DocFormat, string>> = {
  docx: "chat.doc.format.docx",
  xlsx: "chat.doc.format.xlsx",
  pdf: "chat.doc.format.pdf",
};

function partsLabel({ kind, count }: NonNullable<DocCardModel["parts"]>): string {
  if (kind === "sheet") {
    return count === 1 ? t("chat.doc.sheetsOne") : t("chat.doc.sheets", { n: count });
  }
  return count === 1 ? t("chat.doc.sectionsOne") : t("chat.doc.sections", { n: count });
}

/** The line under the title: how many sections or sheets, and the revision note. Empty when neither is known. */
function metaLine(model: DocCardModel): string {
  const lines = [model.parts ? partsLabel(model.parts) : null, model.revised ? t("chat.doc.revisedNote") : null];
  return lines.filter((line): line is string => line !== null).join(" · ");
}

/**
 * A file the Chat answer made: a Word, Excel or PDF file, drawn with a small icon for its format, its
 * title, how many sections or sheets it has when the call says, and Download. Download saves through the
 * artifact file route (`chat-file-save.ts`), so the desktop shell opens its native save dialog there.
 * Everything it shows comes from the saved tool call, so a reopened thread draws the same card.
 */
export function DocCard({ model }: CardProps) {
  const [state, setState] = useState<DownloadState>("idle");
  // Why the save failed, when the shell said (the disk refused it): null reads as the generic sentence.
  const [reason, setReason] = useState<string | null>(null);
  const { artifactId, filename, format, title } = model;
  const meta = metaLine(model);

  async function onDownload() {
    if (state === "busy") {
      return;
    }
    setState("busy");
    setReason(null);
    const saved = await saveChatFile(artifactId, filename);
    if (saved.ok) {
      setState("idle");
    } else {
      setReason(saved.reason);
      setState("failed");
    }
  }

  return (
    <section
      className="min-w-0 rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-3 shadow-elev-1"
      data-testid="chat-doc-card"
      data-artifact-id={artifactId}
      data-format={format}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-48 items-start gap-3">
          <FormatIcon format={format} />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-3)]">
              {t(FORMAT_LABEL_KEY[format])}
            </p>
            <h4
              className="mt-0.5 break-words text-sm font-semibold text-[var(--text)] [overflow-wrap:anywhere]"
              data-testid="chat-doc-title"
            >
              {title}
            </h4>
            {meta ? (
              <p
                className="mt-0.5 min-w-0 text-xs text-[var(--text-2)] [overflow-wrap:anywhere]"
                data-testid="chat-doc-meta"
              >
                {meta}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-primary"
            disabled={state === "busy"}
            onClick={() => void onDownload()}
            aria-label={t("chat.doc.downloadAria", { title, filename })}
            data-testid="chat-doc-download"
          >
            {state === "busy" ? t("chat.doc.downloading") : t("chat.doc.download")}
          </button>
          <AddToWorkspace artifactId={artifactId} />
        </div>
      </div>

      {state === "failed" ? (
        <p className="mt-2 text-xs text-[var(--danger)]" role="alert" data-testid="chat-doc-error">
          {reason ?? t("chat.doc.downloadFailed")}
        </p>
      ) : null}
    </section>
  );
}

/** A page with a folded corner, and the format's extension under it. Decorative: the title names the file. */
function FormatIcon({ format }: { readonly format: DocFormat }) {
  return (
    <span
      className="flex h-10 w-9 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border border-[var(--line)] bg-[var(--surface-2)] text-[var(--text-2)]"
      aria-hidden="true"
      data-testid="chat-doc-icon"
      data-format={format}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
      </svg>
      <span className="text-[9px] font-semibold uppercase leading-none tracking-wide">{format}</span>
    </span>
  );
}

type ToolCall = { readonly key: string; readonly status: string; readonly input?: unknown; readonly output?: unknown };

/** One card for each finished document call of this turn that made a file. */
export function DocCards({ tools }: { readonly tools: readonly ToolCall[] }) {
  const docs = tools.flatMap((tool) => {
    if (!isDocTool(tool.key) || tool.status !== "completed") {
      return [];
    }
    const model = readDocResult(tool.key, tool.input, tool.output);
    return model ? [model] : [];
  });
  if (docs.length === 0) {
    return null;
  }
  return (
    <div className="space-y-2" data-testid="chat-doc-cards">
      {docs.map((model) => (
        <DocCard key={model.artifactId} model={model} />
      ))}
    </div>
  );
}
