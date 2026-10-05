"use client";

import { type CSSProperties, useEffect, useId, useRef, useState } from "react";
import { useBuddyLean } from "@/components/desk-buddy";
import { NultronMascot } from "@/components/nultron/nultron-mascot";
import { BUDDY_NEXT, FULL_BODY_VISIBLE_RATIO, restingState, WAVE_MS } from "@/lib/desk-buddy-state";
import { announceStage, tapBuddy, useBuddySnapshot } from "@/lib/desk-buddy-store";
import { t } from "@/lib/i18n";
import { isMascotMode, MASCOT_MODE_HOME, type MascotState } from "@/lib/mascot-states";
import { useAmbientReason } from "@/lib/use-ambient-reason";

export type BuddyStageKind = "header" | "composer";

/**
 * A place on the page where the desk buddy stands instead of the rail: the art column of a mode header,
 * or the ledge above Chat's composer. It is the same character as the rail's (one store, one voice), so
 * while a stage is on screen the rail draws nothing and the inline status heads stand down
 * (`announceStage`, `takesStatus`). A stage that is `display: none` (a header too narrow for its art
 * column) or scrolled away does not intersect, and the rail takes the character back.
 *
 * At rest it holds the page's own pose (Documents writes, Research searches: `MASCOT_MODE_HOME`), waves
 * once when the page opens, and sleeps when the desk has been left alone. Everything else (a run, a job,
 * a cheer, a flinch, a tap) comes from the store.
 */
export function BuddyStage({ kind, mode, size }: { kind: BuddyStageKind; mode?: string; size: number }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const snapshot = useBuddySnapshot();
  const ambient = useAmbientReason();
  const [waving, setWaving] = useState(true);
  useBuddyLean(ref, true);

  useEffect(() => {
    const timer = window.setTimeout(() => setWaving(false), WAVE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver !== "function") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const latest = entries[entries.length - 1];
        if (latest) {
          announceStage(id, latest.isIntersecting && latest.intersectionRatio >= FULL_BODY_VISIBLE_RATIO);
        }
      },
      { threshold: [0, FULL_BODY_VISIBLE_RATIO, 1] },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      announceStage(id, false);
    };
  }, [id]);

  const mascotMode = isMascotMode(mode) ? mode : undefined;
  const home: MascotState = mascotMode ? MASCOT_MODE_HOME[mascotMode] : "idle";
  const resting = restingState(ambient);
  let state: MascotState = snapshot.state ?? (resting === "sleep" ? "sleep" : home);
  if (!snapshot.state && waving && resting !== "sleep") {
    state = "wave";
  }
  const busy = snapshot.state !== null && snapshot.busy;

  return (
    <div
      ref={ref}
      className="buddy-stage"
      data-testid={`buddy-stage-${kind}`}
      data-kind={kind}
      data-state={state}
      style={{ "--stage-size": `${size}px` } as CSSProperties}
    >
      <button
        type="button"
        className="buddy-stage-tap"
        aria-label={t("common.buddy.tap")}
        title={t("common.buddy.tap")}
        data-testid={`buddy-stage-${kind}-tap`}
        onClick={() => tapBuddy()}
      >
        <NultronMascot
          state={state}
          placement="buddy"
          mode={mascotMode ?? "chat"}
          busy={busy}
          size={size}
          variant="full"
          decorative
          next={BUDDY_NEXT}
        />
      </button>
    </div>
  );
}
