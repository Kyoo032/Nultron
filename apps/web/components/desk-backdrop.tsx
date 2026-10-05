"use client";

import { useEffect, useRef } from "react";
import { attachDeskMotionTo } from "@/lib/desk-motion";

/**
 * The layers behind every desk page: a soft light that follows a fine pointer and the dot grid with its
 * stepped drift and parallax. Mount it as the first child of `.desk-canvas`; the canvas is its parent, and
 * `attachDeskMotion` listens there (a move or a press anywhere on the desk) and writes the pointer variables
 * to this element and to nothing wider. They are real elements and not pseudo-elements of the canvas
 * because a custom property written on the canvas is inherited by the whole page, and restyling the page on
 * every frame cost 8 to 128 ms (`lib/desk-motion.ts`).
 *
 * Decoration only: `aria-hidden`, no pointer events, no text. The rules are `.desk-backdrop` in
 * `app/globals.css`.
 */
export function DeskBackdrop() {
  const layer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = layer.current;
    const canvas = element?.parentElement;
    if (!element || !canvas) {
      return;
    }
    return attachDeskMotionTo(canvas, element);
  }, []);

  return (
    <div ref={layer} className="desk-backdrop" aria-hidden="true" data-testid="desk-backdrop">
      <div className="desk-spot" />
      <div className="desk-grid" />
    </div>
  );
}
