"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { BUDDY_PRIORITY, WAVE_MS } from "@/lib/desk-buddy-state";
import { flashBuddy, getBuddySnapshot, setBuddyClaim, useBuddySnapshot } from "@/lib/desk-buddy-store";
import { GATE_EVENT, readGateEvent } from "@/lib/gateway-gate";
import { getGuideSnapshot, subscribeGuide } from "@/lib/guide-store";
import { isGuideOpen } from "@/lib/guide-machine";
import { isMascotState } from "@/lib/mascot-states";
import { usePathname } from "@/lib/nav";
import { useBuddyClaim } from "@/lib/use-buddy-claim";

/** A wave is a hello, not a tic: no more than one in this long. */
const WAVE_COOLDOWN_MS = 20_000;
/** Louder than anything the app says: a forced state is the point of the hook. */
const DRIVE_HOOK_PRIORITY = 100;

/**
 * The shell-level reactions of the desk buddy, the ones no single page owns. It draws nothing; mount it
 * once, beside the rail.
 *
 *  - arrival: a wave when the buddy steps into view (the app opened, or the Chat hero that stood in for
 *    it went away) and when the person reaches a mode they have not been to yet this session;
 *  - the gateway gate: surprised, once, when the host reports that model calls are blocked;
 *  - the first-run tour: presenting while the guide is open.
 *
 * Chat, jobs, the installer and updates publish from where they happen (`lib/use-buddy-claim.ts`).
 *
 * `?buddy=<state>` (with `&buddyBusy=1` for a working pose) is a drive hook, like the slot's `?mascot=`: it
 * holds the buddy in that state, over everything else, for as long as the page is open.
 */
export function DeskBuddyReactions() {
  const pathname = usePathname();
  const snapshot = useBuddySnapshot();
  const guide = useSyncExternalStore(subscribeGuide, getGuideSnapshot, getGuideSnapshot);
  useBuddyClaim(isGuideOpen(guide.state) ? { state: "presenting", priority: BUDDY_PRIORITY.guide } : null);

  const seenModes = useRef(new Set<string>());
  const wasVisible = useRef(false);
  const lastWave = useRef(Number.NEGATIVE_INFINITY);
  // On screen, not merely allowed to be: a wave for nobody (the hero is standing in) is wasted.
  const visible = snapshot.present && !snapshot.suppressed;
  const mode = pathname.split("/")[1] ?? "";

  useEffect(() => {
    const newMode = mode !== "" && !seenModes.current.has(mode);
    if (mode) {
      seenModes.current.add(mode);
    }
    const arrived = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (!visible || !(arrived || newMode)) {
      return;
    }
    const now = Date.now();
    if (getBuddySnapshot().state === null && now - lastWave.current >= WAVE_COOLDOWN_MS) {
      lastWave.current = now;
      flashBuddy("wave", WAVE_MS);
    }
  }, [visible, mode]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const forced = params.get("buddy");
    if (!isMascotState(forced)) {
      return;
    }
    setBuddyClaim("drive-hook", { state: forced, busy: params.get("buddyBusy") === "1", priority: DRIVE_HOOK_PRIORITY });
    return () => setBuddyClaim("drive-hook", null);
  }, []);

  useEffect(() => {
    const onGate = (event: Event) => {
      const reported = readGateEvent(event);
      if (reported && !reported.allowed) {
        flashBuddy("surprised");
      }
    };
    window.addEventListener(GATE_EVENT, onGate);
    return () => window.removeEventListener(GATE_EVENT, onGate);
  }, []);

  return null;
}
