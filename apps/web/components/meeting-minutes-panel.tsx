"use client";

import type { MeetingMinutes } from "@agentforge/core/meeting";
import { MeetingChecksNote } from "@/components/meeting-checks-note";
import { MeetingMinutesView } from "@/components/meeting-minutes-view";
import { t } from "@/lib/i18n";
import { meetingChecksNote } from "@/lib/meeting-checks";

/** The part of a minutes record this panel reads. `checks` is absent on minutes saved before the checks existed. */
export type MeetingMinutesPanelRecord = {
  readonly minutes: MeetingMinutes;
  readonly unverifiedNames: readonly string[];
  readonly checks?: unknown;
};

/**
 * The Minutes tab: what the checks still found (when anything), the line about names the transcript
 * never said (when any were removed), then the minutes themselves.
 */
export function MeetingMinutesPanel({ record }: { readonly record: MeetingMinutesPanelRecord }) {
  return (
    <div className="enter-rise">
      <MeetingChecksNote note={meetingChecksNote(record.checks)} />
      {record.unverifiedNames.length > 0 ? (
        <p className="mb-3 text-xs text-[var(--text-3)]" data-testid="meeting-unverified">
          {t("meeting.unverified", { count: String(record.unverifiedNames.length) })}
        </p>
      ) : null}
      <MeetingMinutesView minutes={record.minutes} testId="meeting-minutes" />
    </div>
  );
}
