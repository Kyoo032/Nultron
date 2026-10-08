"use client";

import type { AppLocale } from "@agentforge/core/locale";
import { WorkingStatus } from "@/components/working-status";
import { t } from "@/lib/i18n";

/**
 * Translating the minutes is opt-in (doc-flow plan 7a.2): a button, one paid call, only when pressed.
 * The target is the other language than the one the minutes are written in. A second press replaces the
 * first translation. The "always translate" choice that turns it on for every Run is under More.
 */
export function MeetingTranslateBar({
  target,
  hasTranslation,
  busy,
  disabled,
  onTranslate,
}: {
  readonly target: AppLocale;
  readonly hasTranslation: boolean;
  /** This translation is the job that is running. */
  readonly busy: boolean;
  /** A job is running, or the hosted desk has no key. */
  readonly disabled: boolean;
  readonly onTranslate: () => void;
}) {
  const language = target === "id" ? t("meeting.languageIndonesian") : t("meeting.languageEnglish");
  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="meeting-translate-bar">
      <button
        type="button"
        onClick={onTranslate}
        disabled={disabled}
        className="btn btn-ghost h-8 rounded-pill px-4 text-sm"
        data-testid="meeting-translate"
      >
        {busy ? (
          <WorkingStatus label={t("meeting.translating")} />
        ) : (
          t(hasTranslation ? "meeting.translateAgain" : "meeting.translate", { language })
        )}
      </button>
      <span className="text-xs text-[var(--text-3)]" data-testid="meeting-translate-note">
        {t("meeting.translateNote")}
      </span>
    </div>
  );
}
