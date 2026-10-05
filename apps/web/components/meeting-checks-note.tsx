"use client";

import { t } from "@/lib/i18n";
import type { MeetingChecksNoteModel } from "@/lib/meeting-checks";

/**
 * What the host's checks still found in the minutes after the repair round. The minutes are saved
 * either way; this says so, and names what to look at in plain words. Same look as the Documents
 * studio's note (`document-checks-note.tsx`). Nothing renders when every check passed.
 */
export function MeetingChecksNote({ note }: { readonly note: MeetingChecksNoteModel | null }) {
  if (!note) {
    return null;
  }
  return (
    <div
      className="mb-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm"
      role="status"
      data-testid="meeting-checks-note"
    >
      <p className="font-medium text-[var(--text)]">{t("meeting.checks.title")}</p>
      <ul
        className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs text-[var(--text-2)] [overflow-wrap:anywhere]"
        data-testid="meeting-checks-list"
      >
        {note.failed.map((kind) => (
          <li key={kind} data-check={kind}>
            {t(`meeting.checks.${kind}`)}
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-xs text-[var(--text-2)]">
        {t("meeting.checks.hint", { action: t("meeting.runFromTranscript") })}
      </p>
    </div>
  );
}
