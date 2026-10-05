"use client";

import { useEffect, useId, useRef } from "react";
import { BUDDY_PRIORITY, type BuddyClaim, runReaction } from "@/lib/desk-buddy-state";
import { flashBuddy, setBuddyClaim } from "@/lib/desk-buddy-store";
import type { MascotState } from "@/lib/mascot-states";

/**
 * Publish what a part of the app is doing to the desk buddy for as long as it is true. Pass `null` when
 * there is nothing to say; the claim is withdrawn when it goes `null` and when the component unmounts, so
 * a job pane that is torn down never leaves the buddy working. Each caller is its own source.
 */
export function useBuddyClaim(claim: BuddyClaim | null): void {
  const source = useId();
  const state = claim?.state;
  const busy = claim?.busy;
  const priority = claim?.priority;
  useEffect(() => {
    setBuddyClaim(source, state === undefined ? null : { state, busy, priority });
  }, [source, state, busy, priority]);
  useEffect(() => () => setBuddyClaim(source, null), [source]);
}

/**
 * A one-shot reaction when `state` changes to something new (a finished job, a failure). The first render
 * says nothing, so a pane that mounts already finished does not cheer for work it did not see.
 */
export function useBuddyFlashOnEdge(state: MascotState | null, ms?: number): void {
  const previous = useRef<MascotState | null>(state);
  useEffect(() => {
    if (state && state !== previous.current) {
      flashBuddy(state, ms);
    }
    previous.current = state;
  }, [state, ms]);
}

/**
 * The shape most triggers share (`lib/mascot-triggers.ts`): a working pose while something runs
 * (`working`), a one-shot when it ends (`done`, `error`, `ready`). Working poses become a claim, the
 * rest a flash.
 */
export function useBuddyStatus(face: MascotState | null, working: boolean, priority: number = BUDDY_PRIORITY.charging): void {
  useBuddyClaim(face && working ? { state: face, busy: true, priority } : null);
  useBuddyFlashOnEdge(face && !working ? face : null);
}

/**
 * The end of a run the desk was watching: a cheer when `running` stops without a failure (and `succeeded`
 * says it got somewhere, so a cancelled run is not cheered), a flinch when it stops with one. The pose while
 * it runs is the claim of whoever draws the run's status (`MascotSlot`, `ChatTurn`).
 */
export function useBuddyRunEnd(running: boolean, failed: boolean, succeeded = true, cheerMs?: number): void {
  const before = useRef({ running, failed, succeeded });
  useEffect(() => {
    const after = { running, failed, succeeded };
    const reaction = runReaction(before.current, after);
    if (reaction) {
      flashBuddy(reaction, reaction === "celebrating" ? cheerMs : undefined);
    }
    before.current = after;
  }, [running, failed, succeeded, cheerMs]);
}
