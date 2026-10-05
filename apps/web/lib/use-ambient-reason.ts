"use client";

import { useSyncExternalStore } from "react";
import { AMBIENT_ATTR, AMBIENT_REASON_ATTR } from "@/lib/ambient-motion";
import type { BuddyAmbientReason } from "@/lib/desk-buddy-state";

/**
 * Why the desk is paused, read from the two attributes `lib/ambient-motion.ts` writes on `<html>`:
 * `idle` (no input for 12 s), `blurred`, `hidden`, or `null` while somebody is using the window. Read
 * only: the switch itself is the ambient module's, and this never writes either attribute.
 */
export function readAmbientReason(root: Pick<Element, "getAttribute"> | null): BuddyAmbientReason {
  if (root?.getAttribute(AMBIENT_ATTR) !== "paused") {
    return null;
  }
  const reason = root?.getAttribute(AMBIENT_REASON_ATTR);
  return reason === "idle" || reason === "blurred" || reason === "hidden" ? reason : null;
}

function subscribe(onChange: () => void): () => void {
  if (typeof MutationObserver !== "function" || typeof document === "undefined") {
    return () => {};
  }
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [AMBIENT_ATTR, AMBIENT_REASON_ATTR] });
  return () => observer.disconnect();
}

export function useAmbientReason(): BuddyAmbientReason {
  return useSyncExternalStore(
    subscribe,
    () => (typeof document === "undefined" ? null : readAmbientReason(document.documentElement)),
    () => null,
  );
}
