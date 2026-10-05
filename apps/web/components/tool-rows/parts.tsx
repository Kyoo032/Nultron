"use client";

import { Link, useInRouterContext } from "react-router-dom";
import { useState } from "react";
import { t } from "@/lib/i18n";
import { revealFolderProposals } from "./focus-proposals";
import { knowledgeFileHref, type ToolStatus } from "./results";

/** What a tool row needs from a turn's tool call. `LiveTool` and the saved `ToolCallPart` both fit. */
export type RowTool = {
  readonly key: string;
  readonly status: ToolStatus;
  readonly input?: unknown;
  readonly output?: unknown;
};

/** The first line of a row: the label, then whatever else fits. It wraps instead of overflowing. */
export const ROW_HEAD = "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1";

const CHIP =
  "inline-flex min-h-[1.5rem] min-w-0 max-w-full items-center rounded-full border border-[var(--line)] bg-[var(--surface-2)] px-2 py-0.5 text-[11px] leading-4 text-[var(--accent)] no-underline hover:border-[var(--accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]";

/**
 * The sentence of a row. It is one line: a long path or query is cut with an ellipsis and the
 * whole text is the title, so nothing runs past the row.
 */
export function RowLabel({ text }: { text: string }) {
  return (
    <span className="min-w-0 max-w-full truncate" title={text}>
      {text}
    </span>
  );
}

/** A small fact after the label: a count, a line range, a version. */
export function RowDetail({ text, testId }: { text: string; testId?: string }) {
  return (
    <span className="min-w-0 max-w-full text-[var(--text-3)] [overflow-wrap:anywhere]" data-testid={testId}>
      {text}
    </span>
  );
}

/**
 * A desk file as a chip that opens it in the Knowledge Base. Inside the app's router it is a
 * router link (the desktop app routes by hash, so a plain href would miss); a render with no
 * router at all falls back to an anchor.
 */
export function FileChip({ path, text }: { path: string; text: string }) {
  const inRouter = useInRouterContext();
  const href = knowledgeFileHref(path);
  const props = {
    className: CHIP,
    title: path,
    "aria-label": t("chat.tools.openAria", { path }),
    "data-testid": "tool-row-file-chip",
  };
  const inner = <span className="min-w-0 truncate">{text}</span>;
  return inRouter ? (
    <Link to={href} {...props}>
      {inner}
    </Link>
  ) : (
    <a href={href} {...props}>
      {inner}
    </a>
  );
}

/** A refusal is information, not an alarm: the tool's own sentence, muted, under the label. */
export function RefusalNote({ message }: { message: string }) {
  if (!message) {
    return null;
  }
  return (
    <p
      className="mt-1 whitespace-pre-wrap text-[var(--text-3)] [overflow-wrap:anywhere]"
      data-testid="tool-row-refusal"
    >
      {message}
    </p>
  );
}

/** The run's tool allowance is gone. */
export function BudgetNote({ message }: { message: string }) {
  return (
    <div className="mt-1 text-[var(--text-3)]" data-testid="tool-row-budget">
      <span className="font-medium text-[var(--text-2)]">{t("chat.tools.budgetTitle")}</span>
      {message ? <p className="mt-0.5 whitespace-pre-wrap [overflow-wrap:anywhere]">{message}</p> : null}
    </div>
  );
}

/** A change to the owner's real folder that is held until the owner approves it. */
export function PendingApproval({ path }: { path: string }) {
  const [missing, setMissing] = useState(false);
  const review = () => {
    const reduced =
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setMissing(!revealFolderProposals(document, reduced));
  };
  return (
    <div className="mt-1 text-[var(--text-2)]" data-testid="tool-row-pending-approval">
      <div className={ROW_HEAD}>
        <span className="font-medium">{t("chat.tools.pendingTitle")}</span>
        {path ? (
          <span
            className="min-w-0 max-w-full truncate text-[var(--text-3)]"
            title={path}
            data-testid="tool-row-pending-path"
          >
            {path}
          </span>
        ) : null}
        <button
          type="button"
          onClick={review}
          className={`${CHIP} cursor-pointer`}
          data-testid="tool-row-pending-review"
        >
          {t("chat.tools.review")}
        </button>
      </div>
      {missing ? (
        <p className="mt-1 text-[var(--text-3)]" data-testid="tool-row-pending-missing" role="status">
          {t("chat.tools.reviewMissing")}
        </p>
      ) : null}
    </div>
  );
}
