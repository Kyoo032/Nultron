import type { CSSProperties, PointerEvent, ReactNode } from "react";
import { pokeShape, REDUCED_MOTION_QUERY } from "@/lib/hero-motion";

type Shape = {
  kind: "dot" | "ring" | "square" | "plus" | "squiggle" | "triangle";
  /** Position inside the parent, as CSS lengths. */
  at: { top?: string; right?: string; bottom?: string; left?: string };
  size: number;
  color: string;
  spin?: boolean;
  /** How far, in px, the shape drifts at full pointer deflection. Negative drifts against it. */
  depth?: number;
  /** 1 always shows; 2 and 3 appear as the hero's column gets wider (`.chat-hero`, `.onboarding-hero` in globals.css). */
  tier?: 1 | 2 | 3;
};

const LAYOUTS: Record<"header" | "hero" | "chat", Shape[]> = {
  header: [
    /* Nultron stands in the middle of this column (`ModeHeader`), so the shapes keep to its two edges. */
    { kind: "dot", at: { top: "16%", right: "3%" }, size: 14, color: "var(--mode, var(--accent))" },
    { kind: "ring", at: { top: "50%", right: "0%" }, size: 22, color: "var(--accent-3)", spin: true },
    { kind: "plus", at: { top: "6%", left: "8%" }, size: 16, color: "var(--accent-4)", spin: true },
    { kind: "square", at: { bottom: "8%", right: "8%" }, size: 14, color: "var(--accent-2)" },
    { kind: "squiggle", at: { top: "40%", left: "0%" }, size: 30, color: "var(--mode, var(--accent))" },
    { kind: "triangle", at: { bottom: "6%", left: "12%" }, size: 14, color: "var(--mode, var(--accent))" },
  ],
  /*
   * The onboarding hero (`StepHero`). Every shape sits in a band either side of the 96px character (its
   * top edge is the hero's 2rem padding) and above the headline, so none can lie on the character, the
   * headline or the intro text, which fill the column at a narrow width. Tier 1 always shows; 2 from 26rem
   * of hero width and 3 from 44rem, as in the Chat hero (`.onboarding-hero` in globals.css).
   */
  hero: [
    { kind: "dot", at: { top: "3.25rem", left: "10%" }, size: 16, color: "var(--accent-4)" },
    { kind: "ring", at: { top: "2.5rem", right: "10%" }, size: 26, color: "var(--mode, var(--accent))", spin: true },
    { kind: "triangle", at: { top: "6.5rem", left: "6%" }, size: 20, color: "var(--mode, var(--accent))", tier: 2 },
    { kind: "plus", at: { top: "5rem", right: "6%" }, size: 20, color: "var(--accent-3)", spin: true, tier: 2 },
    { kind: "squiggle", at: { top: "2.25rem", right: "28%" }, size: 38, color: "var(--accent-3)", tier: 3 },
  ],
  /*
   * The empty Chat hero. Every shape lives in Nultron's own column, in the bands above and below the
   * character and the side gutter; tier 1 always shows, 2 and 3 only where the column has room.
   */
  chat: [
    /* Confined to Nultron's column (`.chat-hero .float-shapes` in globals.css): the bands above and below the
       character and the side gutter, never behind the speech bubble. */
    { kind: "dot", at: { top: "4%", left: "14%" }, size: 14, color: "var(--accent-4)", depth: 12 },
    { kind: "ring", at: { top: "2%", right: "4%" }, size: 22, color: "var(--mode, var(--accent))", spin: true, depth: -16 },
    { kind: "triangle", at: { bottom: "5%", left: "8%" }, size: 16, color: "var(--mode, var(--accent))", depth: -10, tier: 2 },
    { kind: "plus", at: { bottom: "3%", right: "8%" }, size: 16, color: "var(--accent-3)", spin: true, depth: 14, tier: 2 },
    { kind: "square", at: { top: "44%", left: "0%" }, size: 12, color: "var(--accent-2)", depth: 18, tier: 2 },
    { kind: "squiggle", at: { top: "3%", left: "40%" }, size: 26, color: "var(--accent-3)", depth: -8, tier: 3 },
    { kind: "dot", at: { bottom: "4%", left: "44%" }, size: 10, color: "var(--mode, var(--accent))", depth: 8, tier: 3 },
  ],
};

function glyph(kind: Shape["kind"], color: string): ReactNode {
  switch (kind) {
    case "dot":
      return <circle cx="12" cy="12" r="10" fill={color} />;
    case "ring":
      return <circle cx="12" cy="12" r="8.5" fill="none" stroke={color} strokeWidth="3.5" strokeDasharray="10 5" />;
    case "square":
      return <rect x="3" y="3" width="18" height="18" rx="5" fill={color} />;
    case "plus":
      return <path d="M12 3v18M3 12h18" stroke={color} strokeWidth="4.5" strokeLinecap="round" />;
    case "triangle":
      return <path d="M12 3.5 21 19.5H3z" fill={color} strokeLinejoin="round" />;
    default:
      return (
        <path
          d="M1 14c2.5-6 5-6 7.5 0s5 6 7.5 0 5-6 7 0"
          fill="none"
          stroke={color}
          strokeWidth="3.2"
          strokeLinecap="round"
        />
      );
  }
}

function pokeFromPointer(event: PointerEvent<HTMLDivElement>) {
  const target = event.target;
  const shape = target instanceof Element ? target.closest(".float-shape") : null;
  if (shape) {
    pokeShape(shape, window.matchMedia(REDUCED_MOTION_QUERY).matches);
  }
}

/**
 * Decorative only: shapes behind a hero or a mode header. They settle into place once when they
 * arrive and then bob (a spinner turns) in steps on the desk's 400ms grid; `.float-shape` in globals.css
 * says why that is the one decoration allowed to loop, and `lib/motion-tokens.test.ts` enforces it.
 * `interactive` lets them take the pointer: they drift with the hero's variables (`--px`, `--py`, set by
 * `attachHeroMotion`, only while the pointer moves; a shape with a `depth`), are pushed away from a pointer
 * that comes close (`--rx`, `--ry`, set on the shape by `attachDeskMotion`, every layout) and pop when
 * tapped. The container still ignores the pointer, only the shapes take it.
 */
export function FloatingShapes({
  layout,
  className = "",
  style,
  interactive = false,
}: {
  layout: keyof typeof LAYOUTS;
  className?: string;
  style?: CSSProperties;
  interactive?: boolean;
}) {
  return (
    <div
      className={`float-shapes ${interactive ? "float-shapes-live" : ""} ${className}`}
      style={style}
      aria-hidden="true"
      onPointerDown={interactive ? pokeFromPointer : undefined}
    >
      {LAYOUTS[layout].map((shape, index) => (
        // Two boxes around the <svg>, and the loop is on the inner one alone. An animation on an <svg> root
        // runs on the main thread, and so does any animation on an element that also carries a second one,
        // even a finished one (measured: a style recalculation every frame, 60 a second, for as long as the
        // loop runs); on a box of its own it runs on the compositor. So the outer box settles in, takes the
        // pointer and pops, and the inner one only bobs or turns (`.float-shape` in globals.css).
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed layout
          key={index}
          className={shape.spin ? "float-shape float-shape-spin" : "float-shape"}
          data-tier={shape.tier ?? 1}
          style={{ ...shape.at, "--i": index, "--s": shape.size, "--depth": shape.depth ?? 0 } as CSSProperties}
        >
          <span className="float-shape-body">
            <svg width="100%" height="100%" viewBox="0 0 24 24">
              {glyph(shape.kind, shape.color)}
            </svg>
          </span>
        </span>
      ))}
    </div>
  );
}
