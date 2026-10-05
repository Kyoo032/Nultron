"use client";

import { type RefObject, useEffect, useRef, useState } from "react";

/**
 * True while a scroll container has content below its visible bottom edge. The rail uses it to
 * draw a fade above its pinned Account group: a Settings row that never moves is only honest if
 * the rows scrolling behind it say they are there.
 *
 * The box is re-measured on scroll, when it is resized, and when anything inside it is added or
 * removed (a sub-list opening, the session list loading), since neither of the first two fires
 * for a change in content height. Measurement is batched to one animation frame and the state
 * only moves when the answer flips.
 */
export function useMoreBelow<T extends HTMLElement>(): { ref: RefObject<T | null>; more: boolean } {
  const ref = useRef<T | null>(null);
  const [more, setMore] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      setMore(node.scrollTop + node.clientHeight < node.scrollHeight - 1);
    };
    const schedule = () => {
      if (frame === 0) {
        frame = requestAnimationFrame(measure);
      }
    };
    measure();
    node.addEventListener("scroll", schedule, { passive: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(node);
    const mutation = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule);
    mutation?.observe(node, { childList: true, subtree: true });
    if (!resize) {
      window.addEventListener("resize", schedule);
    }
    return () => {
      if (frame !== 0) {
        cancelAnimationFrame(frame);
      }
      node.removeEventListener("scroll", schedule);
      resize?.disconnect();
      mutation?.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, []);

  return { ref, more };
}
