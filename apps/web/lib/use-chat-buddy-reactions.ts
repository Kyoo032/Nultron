"use client";

import { useBuddyRunEnd } from "@/lib/use-buddy-claim";

/** A reply that lands is a small cheer, shorter than a job's: a long chat would otherwise be one long party. */
export const CHAT_CHEER_MS = 1800;

export type ChatRunFacts = {
  /** A run is in flight. */
  running: boolean;
  /** The send was refused or the run failed. */
  failed: boolean;
  /** The pane shows an error line. */
  error: boolean;
};

/**
 * What the desk buddy does at the two ends of a chat run: a cheer when the run stops without a failure,
 * a flinch when a failure appears. The pose while it runs is the live turn's claim (`ChatTurn`).
 */
export function useChatBuddyReactions({ running, failed, error }: ChatRunFacts): void {
  useBuddyRunEnd(running, failed || error, true, CHAT_CHEER_MS);
}
