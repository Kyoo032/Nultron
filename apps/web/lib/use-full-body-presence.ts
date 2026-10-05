"use client";

import { type RefObject, useEffect, useId } from "react";
import { FULL_BODY_VISIBLE_RATIO } from "@/lib/desk-buddy-state";
import { announceFullBody } from "@/lib/desk-buddy-store";

/**
 * Tells the desk buddy that a full-body character is on screen (the Chat hero, an empty desk, onboarding),
 * so there is only ever one. "On screen" is what the browser says, through an `IntersectionObserver`:
 * a pane kept mounted and hidden is `display: none` and does not intersect, and a character scrolled out
 * of its pane stops counting, so the buddy stands down only while the other one can really be seen.
 *
 * Nothing runs where there is no observer (a server render, a test DOM): the character counts as absent.
 */
export function useFullBodyPresence(ref: RefObject<Element | null>, enabled: boolean): void {
  const id = useId();
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element || typeof IntersectionObserver !== "function") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const latest = entries[entries.length - 1];
        if (latest) {
          announceFullBody(id, latest.isIntersecting && latest.intersectionRatio >= FULL_BODY_VISIBLE_RATIO);
        }
      },
      { threshold: [0, FULL_BODY_VISIBLE_RATIO, 1] },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      announceFullBody(id, false);
    };
  }, [enabled, id, ref]);
}
