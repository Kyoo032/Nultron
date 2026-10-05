"use client";

import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { MascotSlot } from "@/components/mascot-slot";
import type { ModeIconName } from "@/components/mode-icons";
import { ModeIllustration } from "@/components/mode-illustration";
import { useBuddyStaged } from "@/lib/desk-buddy-store";
import { isMascotMode } from "@/lib/mascot-states";

/** The scene and the character: a 72 px mascot, a gap and the 110 px flat scene (`ModeIllustration`). */
export const EMPTY_DESK_FULL_PX = 190;
/** The character alone. */
export const EMPTY_DESK_MASCOT_PX = 72;
/** Air above the character, like the desk's other section gaps (`mt-8`). Inside the wrapper, so a hidden one has no height at all. */
export const EMPTY_DESK_PAD_PX = 32;

export type EmptyDeskTier = "full" | "mascot" | "none";

/**
 * What the room under the prompt dock allows, given how much of the desk's visible height is still free
 * after the page's own content (negative when the page already scrolls).
 *
 * The character is there to fill a blank, never to make the page longer than the window. So: a page that
 * already scrolls gains nothing from a few more pixels and draws the whole scene at its end; one that
 * fits draws the whole scene only when all of it fits, the character alone when only that fits, and
 * nothing when not even that does. A short window then keeps its desk exactly as it was, and the desk
 * buddy in the rail is the one character on screen.
 */
export function emptyDeskTier(freePx: number, padPx: number = EMPTY_DESK_PAD_PX): EmptyDeskTier {
  if (freePx < 0 || freePx >= padPx + EMPTY_DESK_FULL_PX) {
    return "full";
  }
  return freePx >= padPx + EMPTY_DESK_MASCOT_PX ? "mascot" : "none";
}

/**
 * Distance from the top of the scrolled content to the top of `element`, from layout offsets. Not from
 * bounding rects: those include the entrance animation's transform, which moves for a moment and then
 * stops without resizing anything, so a measure taken meanwhile would never be corrected.
 */
function topWithin(element: HTMLElement, pane: HTMLElement): number | null {
  let top = 0;
  for (let node: HTMLElement | null = element; node; node = node.offsetParent as HTMLElement | null) {
    if (node === pane) {
      return top;
    }
    top += node.offsetTop;
  }
  return null;
}

/** The element that scrolls the desk page: the nearest ancestor that scrolls vertically. */
function scrollerOf(element: Element): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") {
      return node;
    }
  }
  return null;
}

/**
 * Measures the room under the wrapper and keeps the tier current. The wrapper is the last thing in the
 * page, so its own height never moves its top, and the answer cannot chase itself. Layout effect: the
 * first answer lands before the first paint, so a short window never flashes the scene.
 */
function useEmptyDeskTier(ref: RefObject<HTMLDivElement | null>, padPx: number): EmptyDeskTier {
  // Until measured (and where nothing can be measured, a server render) the whole scene is the answer.
  const [tier, setTier] = useState<EmptyDeskTier>("full");

  useLayoutEffect(() => {
    const element = ref.current;
    const pane = element ? scrollerOf(element) : null;
    if (!element || !pane) {
      return;
    }
    const main = element.closest("main");
    const measure = () => {
      if (pane.clientHeight === 0) {
        // A pane kept mounted and hidden has no size to judge by; the next show measures again.
        return;
      }
      const top = topWithin(element, pane);
      if (top === null) {
        return;
      }
      const padBottom = main ? Number.parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0;
      setTier(emptyDeskTier(pane.clientHeight - (top + padBottom), padPx));
    };
    measure();
    if (typeof ResizeObserver !== "function") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    if (main) {
      observer.observe(main);
    }
    return () => observer.disconnect();
  }, [ref, padPx]);

  return tier;
}

/**
 * The character on a studio's empty landing: Documents, Research, Data, Images, Videos, Music and
 * Presentations. Mount it where the desk would otherwise be blank, below the prompt dock, and only while
 * nothing real is on the desk (no result, no saved items, no running job, no progress list): the moment
 * there is work it unmounts and the desk buddy in the rail takes over as the one status character.
 *
 * It never pushes the prompt dock or the template list: both sit above it in the page and it adds height
 * only at the end, and only as much as the window has room for (`emptyDeskTier`). `flush` drops its own
 * top gap where the section it sits in already has one.
 */
export function StudioEmptyDesk({ mode, flush = false }: { mode: ModeIconName; flush?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const pad = flush ? 0 : EMPTY_DESK_PAD_PX;
  const tier = useEmptyDeskTier(ref, pad);
  // The page header hosts Nultron when it has room (`BuddyStage` in `ModeHeader`); then the empty desk stays empty.
  const staged = useBuddyStaged();
  return (
    <div ref={ref} data-testid={`${mode}-studio-empty`} data-mode={mode} data-tier={tier} data-staged={staged ? "true" : undefined}>
      {staged ? null : tier === "full" ? (
        <div className={flush ? undefined : "pt-8"}>
          <ModeIllustration mode={mode} />
        </div>
      ) : null}
      {!staged && tier === "mascot" && isMascotMode(mode) ? (
        <div className={flush ? "flex justify-center" : "flex justify-center pt-8"}>
          <MascotSlot mode={mode} placement="empty" />
        </div>
      ) : null}
    </div>
  );
}
