"use client";

import { t } from "@/lib/i18n";

/**
 * What sits under a decision or an action item: whether the transcript backs it, whether the owner
 * changed it, and the words it rests on.
 *
 * `evidence` is a verdict only code sets (`packages/core/src/meeting/evidence.ts`); this draws it. The quote
 * is the transcript's own words, shown in a native disclosure so it is closed until it is asked for and needs
 * no script. An item with no quote (saved before quotes existed, or the writer gave none) has no disclosure;
 * one with no verdict has no marker.
 */
export function MeetingItemMarks({
  quote,
  evidence,
  edited,
}: {
  readonly quote: string;
  readonly evidence?: "verified" | "unverified" | undefined;
  readonly edited?: boolean | undefined;
}) {
  const words = quote.trim();
  if (evidence !== "unverified" && !edited && words === "") {
    return null;
  }
  return (
    <div className="mt-1.5 space-y-1.5">
      {evidence === "unverified" || edited ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {evidence === "unverified" ? (
            <span className="chip" data-testid="meeting-evidence-unverified">
              <span className="chip-dot" style={{ background: "var(--danger)" }} aria-hidden="true" />
              {t("meeting.evidence.unverified")}
            </span>
          ) : null}
          {edited ? (
            <span className="chip" data-testid="meeting-item-edited">
              {t("meeting.edit.edited")}
            </span>
          ) : null}
        </div>
      ) : null}
      {evidence === "unverified" ? (
        <p className="text-xs text-[var(--text-3)]">{t("meeting.evidence.unverifiedHint")}</p>
      ) : null}
      {words !== "" ? (
        <details className="text-xs text-[var(--text-3)]" data-testid="meeting-quote-disclosure">
          <summary className="cursor-pointer select-none" data-testid="meeting-quote-toggle">
            {t("meeting.evidence.quote")}
          </summary>
          <blockquote
            className="mt-1 border-l-2 border-[var(--line)] pl-3 italic text-[var(--text-2)] [overflow-wrap:anywhere]"
            data-testid="meeting-quote"
          >
            {words}
          </blockquote>
        </details>
      ) : null}
    </div>
  );
}

/** A pencil on one item. A button of its own, so it is reachable and named for a screen reader. */
export function MeetingEditButton({ onClick, disabled }: { readonly onClick: () => void; readonly disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--text-3)] hover:bg-[var(--accent-soft)] hover:text-[var(--text)] disabled:opacity-45"
      aria-label={t("meeting.edit.edit")}
      title={t("meeting.edit.edit")}
      data-testid="meeting-item-edit"
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
        aria-hidden="true"
      >
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
    </button>
  );
}
