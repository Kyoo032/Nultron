/**
 * What the Minutes tab says about the evidence behind each decision and action item.
 *
 * Only code sets `evidence` (`packages/core/src/meeting/evidence.ts`): "verified" when the item's quote is
 * in the transcript, its owner is named near it and its due date is said there; "unverified" when not. The
 * page reads the verdicts and never decides one. Minutes saved before evidence existed carry none, and say
 * nothing.
 */
import type { MeetingMinutes } from "@agentforge/core/meeting";

export type EvidenceSummary = {
  /** `unverified` as soon as any item is; `verified` when every judged item is. */
  readonly status: "verified" | "unverified";
  readonly verified: number;
  readonly unverified: number;
};

export function evidenceSummary(minutes: Pick<MeetingMinutes, "decisions" | "actionItems">): EvidenceSummary | null {
  const items = [...minutes.decisions, ...minutes.actionItems];
  const verified = items.filter((item) => item.evidence === "verified").length;
  const unverified = items.filter((item) => item.evidence === "unverified").length;
  if (verified + unverified === 0) {
    return null;
  }
  return { status: unverified > 0 ? "unverified" : "verified", verified, unverified };
}
