/**
 * The desk answers the pointer, kept out of React so a node test can drive it. `lib/hero-motion.ts` is the
 * Chat hero's version of the same idea, scoped to one panel; this is the whole desk pane.
 *
 * One `pointermove` listener on `.desk-canvas` (the raised panel every page sits in), coalesced to at most
 * one write every `WRITE_INTERVAL_MS`, and nothing at all while the pointer is still:
 *  - on the backdrop layer (`.desk-backdrop`, `components/desk-backdrop.tsx`), `--pointer-x` and
 *    `--pointer-y` (whole px from the canvas' top left), which place the soft light that trails the pointer,
 *    and `--grid-x` and `--grid-y` (whole px, -`GRID_SHIFT_PX`..`GRID_SHIFT_PX`), the dot grid's parallax.
 *    The CSS turns them into `transform` and `opacity` only, so nothing lays out. `data-pointer="in"` is set
 *    while the pointer is over the desk.
 *  - on each visible `.float-shape`, `--rx` and `--ry`: how far, in px, the shape is pushed away from the
 *    pointer. Only shapes within `SHAPE_REACH_PX` of it are written, and only when the value changed.
 *  - a press on the empty desk draws one ring (`lib/desk-ripple.ts`). That one also works with a finger.
 *
 * Why it is this sparse. The Windows shell has no GPU, so every frame that changes anything is composited
 * in software, and the cost is the frames times the pixels each one touches. The first version wrote a
 * smooth value on every frame and let CSS transitions glide it, which kept two big layers (the light, the
 * dot grid) moving at 60 frames a second whenever the pointer moved: 9.7% of the machine on an empty Chat
 * against 3.5% without the backdrop. So the light is written at 30 Hz to a whole pixel, with no transition
 * (it is a soft gradient; nobody sees 30 Hz), and the grid's shift is an integer that slews toward its
 * target by one pixel every `GRID_STEP_MS` (about 10 a second: the grid is the biggest layer, and a dot
 * grid that ticks one pixel at a time reads as stepped, like the rest of the ambient motion). It changes only
 * while it is actually moving and lags the pointer a little, which reads as parallax. Nothing is written for
 * a still pointer, and a transition is used only for the one-off fade of the light.
 *
 * Reads happen before writes, and rarely: the canvas rect and the shapes' resting centres are measured once
 * per `MEASURE_TTL_MS` of movement (and again after a scroll), never per event. A shape's centre comes from
 * its layout box (`offsetLeft` and friends), which a transform does not move, so a pushed shape does not
 * chase itself.
 *
 * Gates, the same as the hero's: nothing binds under `prefers-reduced-motion: reduce`; the move listener
 * only binds on a fine, hover-capable pointer (a phone keeps the tap ring); and while the window is paused
 * (`html[data-ambient="paused"]`: hidden, blurred or idle) a move or a press does no work at all.
 *
 * Why the variables live on a small layer and not on the canvas: a custom property is inherited, so a write
 * on the canvas restyles every element on the page. Measured in a GPU-less Chromium, one write per frame
 * cost 8.6 ms a frame on an empty Chat (321 elements) and 128 ms a frame on /edit (1907), against 0.13 ms
 * on a leaf. The layer is four elements deep, and only it and the shapes are ever written
 * (`maps/shell-rail-and-workspaces.md` § 8).
 */

import { AMBIENT_ATTR } from "./ambient-motion";
import { type BackgroundNode, browserBackgroundProbe, createRippleSpawner, isBackgroundTarget } from "./desk-ripple";
import {
  FINE_POINTER_QUERY,
  heroMotionMode,
  type MediaQueryLike,
  pointerToUnit,
  REDUCED_MOTION_QUERY,
} from "./hero-motion";

type Rect = { left: number; top: number; width: number; height: number };

/** The few members of a `.float-shape` the pointer logic reads. */
export type DeskShape = {
  offsetLeft: number;
  offsetTop: number;
  offsetWidth: number;
  offsetHeight: number;
  offsetParent: { getBoundingClientRect(): Rect } | null;
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): void };
};

/** The panel the pointer moves over: where the listeners are bound and the shapes are found. */
export type DeskSurface = {
  getBoundingClientRect(): Rect;
  addEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: { capture?: boolean; passive?: boolean },
  ): void;
  removeEventListener(type: string, listener: (event: Event) => void, options?: { capture?: boolean }): void;
  querySelectorAll(selector: string): ArrayLike<DeskShape>;
};

/** The small backdrop the variables are written to: nothing else on the page inherits them. */
export type DeskLayer = {
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): void };
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

/** What `attachDeskMotion` needs from the browser. Tests pass a fake. */
export type DeskMotionEnv = {
  matchMedia(query: string): MediaQueryLike;
  requestAnimationFrame(callback: () => void): number;
  cancelAnimationFrame(handle: number): void;
  now(): number;
  /** `html[data-ambient="paused"]`. */
  paused(): boolean;
  /** Whether a press at (x, y) on `target` landed on the bare desk (`isBackgroundTarget`). */
  isBackground(target: EventTarget | null, x: number, y: number): boolean;
  /** Draw the ring at (x, y), in the desk's own coordinates. */
  ripple(x: number, y: number): void;
  /** Called by the teardown: take down anything the environment put on the page (a ring still playing). */
  dispose?(): void;
};

/** A measured rect and the shapes' centres are trusted this long while the pointer keeps moving. */
export const MEASURE_TTL_MS = 250;
/** The most often the backdrop is written: 30 Hz. Every write that changes something is a composited frame. */
export const WRITE_INTERVAL_MS = 32;
/** The most often the dot grid steps a pixel toward its target: about 10 a second. */
export const GRID_STEP_MS = 96;
/** The dot grid shifts at most this many px against the pointer (`.desk-grid::before` in globals.css reads it). */
export const GRID_SHIFT_PX = 6;
/** A shape this close to the pointer, in px, is pushed away; one further off is left alone. */
export const SHAPE_REACH_PX = 140;
/** The push on a shape at the pointer's own position, in px. It falls off with the square of the distance. */
export const SHAPE_PUSH_PX = 14;
/** A push smaller than this is not worth a style write. */
const PUSH_EPSILON = 0.05;

export const SHAPE_SELECTOR = ".float-shape";
export const POINTER_ATTR = "data-pointer";

/** How far, and which way, a shape at (dx, dy) from the pointer is pushed. Zero at and beyond the reach. */
export function repelOffset(
  dx: number,
  dy: number,
  reach = SHAPE_REACH_PX,
  push = SHAPE_PUSH_PX,
): { x: number; y: number } {
  const distance = Math.hypot(dx, dy);
  if (distance >= reach) {
    return { x: 0, y: 0 };
  }
  // A shape exactly under the pointer has no direction; send it up and to the right, always the same way.
  const [ux, uy] = distance === 0 ? [Math.SQRT1_2, -Math.SQRT1_2] : [dx / distance, dy / distance];
  const closeness = 1 - distance / reach;
  const amount = push * closeness * closeness;
  return { x: ux * amount, y: uy * amount };
}

/** One pixel of `current` toward `target`. */
const slew = (current: number, target: number) =>
  current === target ? current : current + Math.sign(target - current);

type Point = { x: number; y: number };
type Measured = { shape: DeskShape; cx: number; cy: number };

/** Wires the desk up and returns the teardown. */
export function attachDeskMotion(desk: DeskSurface, layer: DeskLayer, env: DeskMotionEnv): () => void {
  const reduced = env.matchMedia(REDUCED_MOTION_QUERY);
  const fine = env.matchMedia(FINE_POINTER_QUERY);

  let frame = 0;
  let pending: Point | null = null;
  let writtenAt = -Infinity;
  let gridAt = -Infinity;
  let rect: Rect | null = null;
  let measuredAt = -Infinity;
  let shapes: readonly Measured[] = [];
  /** What each shape was last told, so an unchanged push is not written again and a reset knows who to reset. */
  let pushed = new Map<DeskShape, Point>();
  /** Every shape this attachment has written to, so the teardown leaves none of them styled. */
  const touched = new Set<DeskShape>();
  /** The light's place and the grid's shift as last written, and where the grid is headed. */
  let light: Point | null = null;
  let grid: Point = { x: 0, y: 0 };
  let gridTarget: Point = { x: 0, y: 0 };
  let inside = false;
  let unbindMove: (() => void) | null = null;
  let unbindPress: (() => void) | null = null;

  const measure = (at: number) => {
    rect = desk.getBoundingClientRect();
    measuredAt = at;
    const found = Array.from(desk.querySelectorAll(SHAPE_SELECTOR));
    shapes = found.flatMap((shape) => {
      const parent = shape.offsetParent;
      // A shape that is not drawn (a hidden tier, a page kept alive behind another) has no width.
      if (!parent || shape.offsetWidth === 0) {
        return [];
      }
      const box = parent.getBoundingClientRect();
      return [
        {
          shape,
          cx: box.left + shape.offsetLeft + shape.offsetWidth / 2,
          cy: box.top + shape.offsetTop + shape.offsetHeight / 2,
        },
      ];
    });
    // A shape that stopped being drawn while pushed goes back to rest, so it is not displaced when it returns.
    const alive = new Set(shapes.map((entry) => entry.shape));
    const next = new Map(pushed);
    for (const shape of pushed.keys()) {
      if (!alive.has(shape)) {
        shape.style.removeProperty("--rx");
        shape.style.removeProperty("--ry");
        touched.delete(shape);
        next.delete(shape);
      }
    }
    pushed = next;
  };

  const writeLight = (x: number, y: number, box: Rect) => {
    const next = { x: Math.round(x - box.left), y: Math.round(y - box.top) };
    if (!light || light.x !== next.x) {
      layer.style.setProperty("--pointer-x", `${next.x}px`);
    }
    if (!light || light.y !== next.y) {
      layer.style.setProperty("--pointer-y", `${next.y}px`);
    }
    light = next;
    if (!inside) {
      inside = true;
      layer.setAttribute(POINTER_ATTR, "in");
    }
  };

  /** Moves the grid one pixel per axis toward its target and writes only what changed. */
  const stepGrid = () => {
    const next = { x: slew(grid.x, gridTarget.x), y: slew(grid.y, gridTarget.y) };
    if (next.x !== grid.x) {
      layer.style.setProperty("--grid-x", String(next.x));
    }
    if (next.y !== grid.y) {
      layer.style.setProperty("--grid-y", String(next.y));
    }
    grid = next;
  };

  const writePush = (x: number, y: number) => {
    const next = new Map(pushed);
    for (const { shape, cx, cy } of shapes) {
      const push = repelOffset(cx - x, cy - y);
      const before = pushed.get(shape) ?? { x: 0, y: 0 };
      if (Math.abs(push.x - before.x) < PUSH_EPSILON && Math.abs(push.y - before.y) < PUSH_EPSILON) {
        continue;
      }
      shape.style.setProperty("--rx", push.x.toFixed(2));
      shape.style.setProperty("--ry", push.y.toFixed(2));
      touched.add(shape);
      if (push.x === 0 && push.y === 0) {
        next.delete(shape);
      } else {
        next.set(shape, push);
      }
    }
    pushed = next;
  };

  const gridSettled = () => grid.x === gridTarget.x && grid.y === gridTarget.y;

  const flush = () => {
    frame = 0;
    if (env.paused()) {
      pending = null;
      return;
    }
    if (!pending && gridSettled()) {
      return;
    }
    const at = env.now();
    // A write that is not due yet waits for a later frame, keeping the newest point. A frame that only asks
    // again is nearly free; a write that changes a layer is not.
    if (pending && at - writtenAt >= WRITE_INTERVAL_MS) {
      const point = pending;
      pending = null;
      writtenAt = at;
      if (!rect || at - measuredAt > MEASURE_TTL_MS) {
        measure(at);
      }
      const box = rect as Rect;
      const unit = pointerToUnit(point.x, point.y, box);
      gridTarget = { x: Math.round(unit.x * GRID_SHIFT_PX), y: Math.round(unit.y * GRID_SHIFT_PX) };
      writeLight(point.x, point.y, box);
      writePush(point.x, point.y);
    }
    if (!gridSettled() && at - gridAt >= GRID_STEP_MS) {
      gridAt = at;
      stepGrid();
    }
    if (pending || !gridSettled()) {
      frame = env.requestAnimationFrame(flush);
    }
  };

  const schedule = () => {
    if (!frame) {
      frame = env.requestAnimationFrame(flush);
    }
  };

  const onMove = (event: Event) => {
    const { clientX, clientY, pointerType } = event as PointerEvent;
    if (pointerType === "touch" || env.paused()) {
      return;
    }
    pending = { x: clientX, y: clientY };
    schedule();
  };

  /** The pointer left: the light fades out, the grid slews home and every shape settles back. */
  const rest = () => {
    pending = null;
    rect = null;
    light = null;
    gridTarget = { x: 0, y: 0 };
    if (inside) {
      inside = false;
      layer.removeAttribute(POINTER_ATTR);
    }
    for (const shape of pushed.keys()) {
      shape.style.setProperty("--rx", "0");
      shape.style.setProperty("--ry", "0");
    }
    pushed = new Map();
    if (!gridSettled()) {
      schedule();
    }
  };

  /** A scroll moves the shapes under a still pointer: measure again at the next move. */
  const onScroll = () => {
    measuredAt = -Infinity;
  };

  const onPress = (event: Event) => {
    const { clientX, clientY, target, isPrimary, button } = event as PointerEvent;
    if (isPrimary === false || (typeof button === "number" && button !== 0) || env.paused()) {
      return;
    }
    if (!env.isBackground(target, clientX, clientY)) {
      return;
    }
    const box = desk.getBoundingClientRect();
    env.ripple(clientX - box.left, clientY - box.top);
  };

  const bindMove = () => {
    if (unbindMove) {
      return;
    }
    desk.addEventListener("pointermove", onMove, { passive: true });
    desk.addEventListener("pointerleave", rest, { passive: true });
    desk.addEventListener("scroll", onScroll, { capture: true, passive: true });
    unbindMove = () => {
      desk.removeEventListener("pointermove", onMove);
      desk.removeEventListener("pointerleave", rest);
      desk.removeEventListener("scroll", onScroll, { capture: true });
      if (frame) {
        env.cancelAnimationFrame(frame);
        frame = 0;
      }
      pending = null;
      rect = null;
      light = null;
      grid = { x: 0, y: 0 };
      gridTarget = { x: 0, y: 0 };
      inside = false;
      for (const shape of touched) {
        shape.style.removeProperty("--rx");
        shape.style.removeProperty("--ry");
      }
      touched.clear();
      pushed = new Map();
      for (const name of ["--pointer-x", "--pointer-y", "--grid-x", "--grid-y"]) {
        layer.style.removeProperty(name);
      }
      layer.removeAttribute(POINTER_ATTR);
      unbindMove = null;
    };
  };

  const bindPress = () => {
    if (unbindPress) {
      return;
    }
    desk.addEventListener("pointerdown", onPress, { passive: true });
    unbindPress = () => {
      desk.removeEventListener("pointerdown", onPress);
      unbindPress = null;
    };
  };

  const applyMode = () => {
    const mode = heroMotionMode({ reduced: reduced.matches, finePointer: fine.matches });
    if (mode === "full") {
      bindMove();
    } else {
      unbindMove?.();
    }
    if (mode === "off") {
      unbindPress?.();
    } else {
      bindPress();
    }
  };

  applyMode();
  reduced.addEventListener("change", applyMode);
  fine.addEventListener("change", applyMode);

  return () => {
    reduced.removeEventListener("change", applyMode);
    fine.removeEventListener("change", applyMode);
    unbindMove?.();
    unbindPress?.();
    env.dispose?.();
  };
}

/** The real browser. The rings are drawn inside the backdrop `layer`, behind the desk's content. */
export function browserDeskEnv(desk: HTMLElement, layer: HTMLElement): DeskMotionEnv {
  const rings = createRippleSpawner(layer);
  return {
    matchMedia: (query) => window.matchMedia(query),
    requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle),
    now: () => performance.now(),
    paused: () => document.documentElement.getAttribute(AMBIENT_ATTR) === "paused",
    isBackground: (target, x, y) =>
      target instanceof Element &&
      isBackgroundTarget(target as unknown as BackgroundNode, desk as unknown as BackgroundNode, browserBackgroundProbe, {
        x,
        y,
      }),
    ripple: (x, y) => void rings.spawn(x, y),
    dispose: () => rings.clear(),
  };
}

/** Binds a real `.desk-canvas` and its backdrop layer, and returns the teardown. */
export function attachDeskMotionTo(desk: HTMLElement, layer: HTMLElement): () => void {
  // The DOM's `querySelectorAll` returns `NodeListOf<Element>`; the shapes it finds are HTMLElements.
  return attachDeskMotion(desk as unknown as DeskSurface, layer, browserDeskEnv(desk, layer));
}
