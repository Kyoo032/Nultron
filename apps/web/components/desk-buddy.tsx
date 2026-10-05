"use client";

import { type RefObject, useEffect, useRef } from "react";
import { NultronMascot } from "@/components/nultron/nultron-mascot";
import { AMBIENT_ATTR } from "@/lib/ambient-motion";
import { BUDDY_NEXT, buddyView, CHIP_SIZE, restingState } from "@/lib/desk-buddy-state";
import {
  mountBuddyDock,
  setBuddyMinimised,
  setBuddyRoom,
  tapBuddy,
  useBuddySnapshot,
} from "@/lib/desk-buddy-store";
import { t } from "@/lib/i18n";
import type { MascotState } from "@/lib/mascot-states";
import { useAmbientReason } from "@/lib/use-ambient-reason";
import "@/components/desk-buddy.css";

/**
 * The desk buddy: Nultron, standing in the rail, reacting to the whole app.
 *
 * It lives in the rail because the rail is the one place nothing else is. Every desk page is full width
 * and scrolls, and Chat's composer fills the bottom, so a character floating over the desk would sooner
 * or later lie on a control or a line of text. The rail's list ends where its last row ends, and what is
 * left under it is empty by construction:
 *
 *  - `DeskBuddyDock` is the empty part of the list (a flex child that takes only the room left over, and
 *    none when the list scrolls). It measures that room, and when there is enough for a whole body
 *    (64 px and up) the body stands in it;
 *  - `DeskBuddyChip` is the footer's answer when there is not: a small head in the row that already holds
 *    the theme and collapse controls, so a short window or a long list never squeezes anything.
 *
 * Neither draws while another full-body character is on screen (the Chat hero, an empty desk,
 * onboarding), and neither exists in a collapsed rail. What it does comes from the store
 * (`lib/desk-buddy-store.ts`): claims and flashes published by the chat run, jobs, the installer,
 * updates, the gate and the tour.
 */

/** What the buddy shows: the loudest voice in the store, or its resting pose. */
function useBuddyFace(): { state: MascotState; busy: boolean } {
  const snapshot = useBuddySnapshot();
  const ambient = useAmbientReason();
  const state = snapshot.state ?? restingState(ambient);
  return { state, busy: snapshot.state !== null && snapshot.busy };
}

/** The picture leans a few pixels toward the pointer, like the hero's. Fine pointers only, never while paused. */
export function useBuddyLean(ref: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element || typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    if (
      !window.matchMedia("(hover: hover) and (pointer: fine)").matches ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const reach = 320;
    let frame = 0;
    let pointer: { x: number; y: number } | null = null;
    let centre: { x: number; y: number; at: number } | null = null;
    let written = { x: 0, y: 0 };
    const unit = (value: number) => Math.max(-1, Math.min(1, value / reach));

    const write = () => {
      frame = 0;
      if (!pointer) {
        return;
      }
      const now = performance.now();
      if (!centre || now - centre.at > 250) {
        const rect = element.getBoundingClientRect();
        centre = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, at: now };
      }
      const x = Math.round(unit(pointer.x - centre.x) * 20) / 20;
      const y = Math.round(unit(pointer.y - centre.y) * 20) / 20;
      if (x === written.x && y === written.y) {
        return;
      }
      written = { x, y };
      element.style.setProperty("--px", String(x));
      element.style.setProperty("--py", String(y));
    };
    const onMove = (event: PointerEvent) => {
      if (document.documentElement.getAttribute(AMBIENT_ATTR) === "paused") {
        return;
      }
      pointer = { x: event.clientX, y: event.clientY };
      if (!frame) {
        frame = window.requestAnimationFrame(write);
      }
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      element.style.removeProperty("--px");
      element.style.removeProperty("--py");
    };
  }, [enabled, ref]);
}

function MinimiseGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M2 5h6" strokeLinecap="round" />
    </svg>
  );
}

export function BuddyBody({ size }: { size: number }) {
  const face = useBuddyFace();
  const ref = useRef<HTMLDivElement>(null);
  useBuddyLean(ref, true);
  return (
    <div
      ref={ref}
      className="desk-buddy"
      data-testid="desk-buddy"
      data-view="body"
      data-state={face.state}
      style={{ width: size, height: size }}
      role="group"
      aria-label={t("common.buddy.region")}
    >
      <button
        type="button"
        className="desk-buddy-tap"
        aria-label={t("common.buddy.tap")}
        title={t("common.buddy.tap")}
        data-testid="desk-buddy-tap"
        onClick={() => tapBuddy()}
      >
        <NultronMascot
          state={face.state}
          placement="buddy"
          mode="chat"
          busy={face.busy}
          size={size}
          variant="full"
          decorative
          next={BUDDY_NEXT}
        />
      </button>
      <button
        type="button"
        className="desk-buddy-min"
        aria-label={t("common.buddy.minimise")}
        title={t("common.buddy.minimise")}
        data-testid="desk-buddy-minimise"
        onClick={() => setBuddyMinimised(true)}
      >
        <MinimiseGlyph />
      </button>
    </div>
  );
}

/**
 * The empty end of the rail's list. Mount it as the last child of the list, after the pinned Account
 * group. `collapsed` rails have no buddy: the list is icons only and has no room worth the name.
 */
export function DeskBuddyDock({ collapsed }: { collapsed: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const snapshot = useBuddySnapshot();

  useEffect(() => (collapsed ? undefined : mountBuddyDock()), [collapsed]);

  useEffect(() => {
    const element = ref.current;
    if (collapsed || !element) {
      return;
    }
    const measure = () => setBuddyRoom(element.clientHeight, element.clientWidth);
    measure();
    if (typeof ResizeObserver !== "function") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [collapsed]);

  if (collapsed) {
    return null;
  }
  const { view, size } = buddyView(snapshot);
  return (
    <div ref={ref} className="desk-buddy-dock" data-testid="desk-buddy-dock" data-view={view}>
      {view === "body" ? <BuddyBody size={size} /> : null}
    </div>
  );
}

/** The footer's small head, in the row of the theme and collapse controls. Draws only when there is no room for a body. */
export function DeskBuddyChip() {
  const snapshot = useBuddySnapshot();
  const { view } = buddyView(snapshot);
  return view === "chip" ? <BuddyChip restore={snapshot.minimised} /> : null;
}

export function BuddyChip({ restore }: { restore: boolean }) {
  const face = useBuddyFace();
  const label = restore ? t("common.buddy.restore") : t("common.buddy.tap");
  return (
    <button
      type="button"
      className="desk-buddy-chip btn btn-ghost btn-icon h-8 w-8 shrink-0 rounded-md wash hover:bg-[var(--rail-hover)]"
      aria-label={label}
      title={label}
      data-testid="desk-buddy-chip"
      data-view="chip"
      data-state={face.state}
      onClick={() => (restore ? setBuddyMinimised(false) : tapBuddy())}
    >
      <NultronMascot
        state={face.state}
        placement="buddy"
        mode="chat"
        busy={face.busy}
        size={CHIP_SIZE}
        variant="head"
        decorative
        next={BUDDY_NEXT}
      />
    </button>
  );
}
