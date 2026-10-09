"use client";

import type { MeetingMinutes } from "@agentforge/core/meeting";
import { MeetingChecksNote } from "@/components/meeting-checks-note";
import { MeetingMinutesView, type MinutesEditing } from "@/components/meeting-minutes-view";
import { t } from "@/lib/i18n";
import { meetingChecksNote } from "@/lib/meeting-checks";
import { evidenceSummary } from "@/lib/meeting-evidence";

/** The part of a minutes record this panel reads. `checks` is absent on minutes saved before the checks existed. */
export type MeetingMinutesPanelRecord = {
  readonly minutes: MeetingMinutes;
  readonly unverifiedNames: readonly string[];
  readonly checks?: unknown;
};

/**
 * The Minutes tab: what the checks still found (when anything), what the transcript does and does not back,
 * the line about names the transcript never said (when any were removed), then the minutes themselves.
 *
 * The evidence line follows the verdicts on the items and nothing else, so minutes saved before evidence
 * existed draw none. `editing` makes each decision and action item editable in place.
 */
export function MeetingMinutesPanel({
  record,
  editing,
}: {
  readonly record: MeetingMinutesPanelRecord;
  readonly editing?: MinutesEditing;
}) {
  const evidence = evidenceSummary(record.minutes);
  return (
    <div className="enter-rise">
      <MeetingChecksNote note={meetingChecksNote(record.checks)} />
      {evidence ? (
        <p
          className="mb-3 text-xs text-[var(--text-2)]"
          role="status"
          data-testid="meeting-minutes-evidence"
          data-status={evidence.status}
          data-verified={evidence.verified}
          data-unverified={evidence.unverified}
        >
          {evidence.status === "verified"
            ? t("meeting.evidence.allVerified")
            : t("meeting.evidence.someUnverified", {
                verified: String(evidence.verified),
                unverified: String(evidence.unverified),
              })}
        </p>
      ) : null}
      {record.unverifiedNames.length > 0 ? (
        <p className="mb-3 text-xs text-[var(--text-3)]" data-testid="meeting-unverified">
          {t("meeting.unverified", { count: String(record.unverifiedNames.length) })}
        </p>
      ) : null}
      <MeetingMinutesView minutes={record.minutes} testId="meeting-minutes" {...(editing ? { editing } : {})} />
    </div>
  );
}
