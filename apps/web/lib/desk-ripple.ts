/**
 * The empty-desk click: what counts as "empty", and the ring it draws. Kept out of React, and the part
 * that needs a browser kept behind two small seams, so a node test can drive the rules
 * (`lib/desk-ripple.test.ts`).
 *
 * A press is an empty-desk press when nothing between the target and the desk could be the point of it:
 * the target and every ancestor up to the desk are plain layout (no control, no link, no editable text,
 * no tab stop, no pointer cursor, no scrollbar under the pointer), none of them paints a surface (a card,
 * a panel and a chip all do, so a press on their padding is a press on the thing, not on the desk), and the
 * target holds no text of its own. A page opts a region out with `data-no-ripple`.
 */

import { cssToken, parseMs } from "./hero-motion";

/** Tags that are the point of a press, or whose pixels are somebody's content. Compared in lower case. */
const CONTENT_TAGS = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "option",
  "summary",
  "label",
  "video",
  "audio",
  "canvas",
  "img",
  "iframe",
  "svg",
  "table",
  "pre",
  "code",
]);

const CONTENT_ROLES = new Set([
  "button",
  "link",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "textbox",
  "combobox",
  "listbox",
  "separator",
  "dialog",
  "img",
]);

type ChildLike = { nodeType: number; nodeValue: string | null };

/** The few members of a DOM node the rules read. A test passes plain objects. */
export type BackgroundNode = {
  nodeType: number;
  parentNode: BackgroundNode | null;
  tagName?: string;
  childNodes?: ArrayLike<ChildLike>;
  getAttribute?(name: string): string | null;
};

/** What a browser knows about one node that markup does not say. */
export type BackgroundProbe = (
  node: BackgroundNode,
  point: { x: number; y: number },
) => { cursor: string; paints: boolean; scrollbar: boolean };

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function hasOwnText(node: BackgroundNode): boolean {
  const children = node.childNodes;
  if (!children) {
    return false;
  }
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child && child.nodeType === TEXT_NODE && (child.nodeValue ?? "").trim() !== "") {
      return true;
    }
  }
  return false;
}

function isContent(node: BackgroundNode): boolean {
  if (node.tagName && CONTENT_TAGS.has(node.tagName.toLowerCase())) {
    return true;
  }
  const read = (name: string) => node.getAttribute?.(name) ?? null;
  const role = read("role");
  if (role && CONTENT_ROLES.has(role.toLowerCase())) {
    return true;
  }
  const editable = read("contenteditable");
  if (editable !== null && editable !== "false") {
    return true;
  }
  const tabindex = read("tabindex");
  if (tabindex !== null && tabindex !== "-1") {
    return true;
  }
  return read("data-no-ripple") !== null;
}

/**
 * True when a press at `point` on `target` landed on the bare desk. `desk` is the element the walk stops
 * at (it is not read: its own surface is the backdrop the ring is drawn on). A target that is not inside
 * the desk is never background.
 */
export function isBackgroundTarget(
  target: BackgroundNode | null,
  desk: BackgroundNode,
  probe: BackgroundProbe,
  point: { x: number; y: number },
): boolean {
  if (!target) {
    return false;
  }
  let node: BackgroundNode | null = target;
  while (node && node !== desk) {
    if (node.nodeType === ELEMENT_NODE) {
      if (isContent(node) || (node === target && hasOwnText(node))) {
        return false;
      }
      const facts = probe(node, point);
      if (facts.cursor === "pointer" || facts.paints || facts.scrollbar) {
        return false;
      }
    }
    node = node.parentNode;
  }
  return node === desk;
}

const TRANSPARENT = new Set(["transparent", "rgba(0, 0, 0, 0)"]);

/** The browser's answer for one element: its cursor, whether it paints anything of its own, a scrollbar under the point. */
export const browserBackgroundProbe: BackgroundProbe = (node, point) => {
  const element = node as unknown as HTMLElement;
  const style = getComputedStyle(element);
  const border = (["Top", "Right", "Bottom", "Left"] as const).some(
    (side) => style.getPropertyValue(`border-${side.toLowerCase()}-style`) !== "none" && Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0,
  );
  const paints =
    !TRANSPARENT.has(style.backgroundColor) ||
    style.backgroundImage !== "none" ||
    style.boxShadow !== "none" ||
    border;
  const box = element.getBoundingClientRect();
  const scrollbar =
    (element.offsetWidth - element.clientWidth > 1 && point.x > box.left + element.clientWidth) ||
    (element.offsetHeight - element.clientHeight > 1 && point.y > box.top + element.clientHeight);
  return { cursor: style.cursor, paints, scrollbar };
};

/** How opaque a ring is when it starts; it fades from here to nothing (`lib/desk-backdrop-contrast.test.ts` reads it). */
export const RIPPLE_PEAK_OPACITY = 0.6;

/** Rings on screen at once; a flurry of clicks cancels the oldest instead of stacking. */
const MAX_RIPPLES = 3;

/**
 * Draws one ring in `layer` (the backdrop, which fills the desk and sits behind its content) at (x, y), in
 * the desk's own coordinates, and removes it when it has played. Only `scale` and `opacity` move, on the
 * compositor; the duration and the curve are the scale's (`--motion-5`, `--ease-out`). `clear` takes down every
 * ring still playing.
 */
export function createRippleSpawner(layer: HTMLElement): { spawn(x: number, y: number): boolean; clear(): void } {
  let rings: HTMLElement[] = [];

  const retire = (ring: HTMLElement) => {
    ring.remove();
    rings = rings.filter((other) => other !== ring);
  };

  return {
    spawn(x, y) {
      if (typeof layer.animate !== "function") {
        return false;
      }
      const ring = document.createElement("span");
      ring.className = "desk-ripple";
      ring.setAttribute("aria-hidden", "true");
      ring.style.left = `${x.toFixed(1)}px`;
      ring.style.top = `${y.toFixed(1)}px`;
      layer.append(ring);
      rings = [...rings, ring];
      while (rings.length > MAX_RIPPLES) {
        retire(rings[0] as HTMLElement);
      }
      const play = ring.animate(
        [
          { opacity: RIPPLE_PEAK_OPACITY, scale: 0.12 },
          { opacity: 0, scale: 1 },
        ],
        {
          duration: parseMs(cssToken(layer, "--motion-5", "560ms"), 560),
          easing: cssToken(layer, "--ease-out", "linear"),
        },
      );
      play.onfinish = () => retire(ring);
      play.oncancel = () => retire(ring);
      return true;
    },
    clear() {
      for (const ring of rings) {
        ring.remove();
      }
      rings = [];
    },
  };
}
