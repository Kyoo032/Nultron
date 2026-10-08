"use client";

import { t } from "@/lib/i18n";
import type { Meeting } from "@/lib/meeting-types";

export type MeetingListRowProps = {
  meeting: Pick<Meeting, "id" | "title" | "status">;
  selected: boolean;
  /** The first press armed delete on this row; the confirm panel is showing. */
  confirming: boolean;
  deleting: boolean;
  /**
   * A recording is running. It belongs to the meeting selected when Record was pressed, so the
   * owner cannot switch rows until they stop it.
   */
  locked?: boolean;
  /** This row is the meeting being recorded: deleting it would pull the meeting out from under it. */
  deleteLocked?: boolean;
  onSelect: () => void;
  onAskDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
};

/**
 * One meeting in the list, with a two-step delete.
 *
 * Deleting removes the meeting folder and its recording, so the × only arms the row; the meeting
 * goes when the owner presses Delete in the panel that opens. Same shape as Settings' sign-out
 * confirm (`settings-reset-card.tsx`): a danger panel, a danger button, and a plain Cancel.
 */
export function MeetingListRow({
  meeting,
  selected,
  confirming,
  deleting,
  locked = false,
  deleteLocked = false,
  onSelect,
  onAskDelete,
  onConfirmDelete,
  onCancelDelete,
}: MeetingListRowProps) {
  return (
    <div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onSelect}
          disabled={locked}
          title={locked ? t("meeting.record.switchLocked") : undefined}
          className={`min-w-0 flex-1 px-3 py-2 text-left text-sm disabled:cursor-not-allowed ${
            selected
              ? "rounded-lg bg-[var(--surface-2)] text-[var(--text)]"
              : "card-live text-[var(--text-2)] disabled:opacity-45"
          }`}
          data-testid={`meeting-item-${meeting.id}`}
        >
          <span className="block truncate">{meeting.title}</span>
          <span className="block text-xs text-[var(--text-3)]">{meeting.status}</span>
        </button>
        <button
          type="button"
          onClick={onAskDelete}
          disabled={confirming || deleteLocked}
          className="rounded-lg px-2 py-2 text-xs text-[var(--text-3)] disabled:opacity-45"
          aria-label={t("meeting.delete")}
          aria-expanded={confirming}
          data-testid={`meeting-delete-${meeting.id}`}
        >
          ×
        </button>
      </div>
      {confirming ? (
        <div
          className="mt-1 space-y-2 rounded-md border border-[var(--danger)]/30 bg-[var(--danger)]/5 p-3"
          data-testid="meeting-delete-panel"
        >
          <p className="text-sm text-[var(--text)]">{t("meeting.deleteConfirm", { title: meeting.title })}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="rounded-pill bg-[var(--danger)] px-3 py-1.5 text-sm text-[var(--surface)] disabled:opacity-50"
              disabled={deleting}
              onClick={onConfirmDelete}
              data-testid="meeting-delete-confirm"
            >
              {t("meeting.deleteConfirmSubmit")}
            </button>
            <button
              type="button"
              className="rounded-md px-3 py-2 text-sm text-[var(--text-2)] underline disabled:opacity-50"
              disabled={deleting}
              onClick={onCancelDelete}
              data-testid="meeting-delete-cancel"
            >
              {t("meeting.cancel")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
