/**
 * What the Meeting studio says about the checks its minutes still failed.
 *
 * The host runs five checks on the first-language minutes and spends one repair round on a failure
 * (`packages/host/src/meeting/minutes-checks.ts`). Minutes that still fail are kept as a draft to edit,
 * and the verdicts travel with them as `checks` on the minutes record: ids and pass/fail only, never
 * minutes text. This turns that into the few words the page shows.
 *
 * The renderer reads the ids the host writes and nothing else: a check it has no words for is left
 * out rather than shown as a raw id, and a record with no verdicts (saved before the checks existed, or
 * a translation, which is not checked) says nothing.
 */

/** What the page can name, in the order a reader should look at them. */
export const MEETING_CHECK_KINDS = ["owners", "dates", "summary", "shape", "evidence"] as const;

export type MeetingCheckKind = (typeof MEETING_CHECK_KINDS)[number];

/** The host's check ids (`MINUTES_CHECK_IDS`), by what each one means to the person. */
const KIND_OF_CHECK: Readonly<Record<string, MeetingCheckKind>> = {
  "action-owners": "owners",
  "quoted-dates": "dates",
  "summary-present": "summary",
  "minutes-shape": "shape",
  "minutes-evidence": "evidence",
};

/** The checks as the host sends them on a minutes record. Every field is read defensively. */
export type MeetingChecksWire = {
  readonly passed?: boolean;
  readonly rounds?: number;
  readonly verdicts?: ReadonlyArray<{ readonly check: string; readonly ok: boolean }>;
};

export type MeetingChecksNoteModel = { readonly failed: readonly MeetingCheckKind[] };

function failedKind(verdict: unknown): MeetingCheckKind | null {
  if (!verdict || typeof verdict !== "object") {
    return null;
  }
  const { check, ok } = verdict as { check?: unknown; ok?: unknown };
  if (ok !== false || typeof check !== "string") {
    return null;
  }
  return KIND_OF_CHECK[check] ?? null;
}

/**
 * The note for one set of minutes, or null when there is nothing to say. It follows the verdicts and
 * not the `passed` flag, so a failed check is never hidden by a flag that disagrees with it.
 */
export function meetingChecksNote(checks: unknown): MeetingChecksNoteModel | null {
  if (!checks || typeof checks !== "object") {
    return null;
  }
  const verdicts = (checks as { verdicts?: unknown }).verdicts;
  if (!Array.isArray(verdicts)) {
    return null;
  }
  const failed = new Set(verdicts.map(failedKind).filter((kind): kind is MeetingCheckKind => kind !== null));
  const ordered = MEETING_CHECK_KINDS.filter((kind) => failed.has(kind));
  return ordered.length > 0 ? { failed: ordered } : null;
}
