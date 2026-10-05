import type { ShellModesStore } from "./shell-modes";
import { RAIL_RECENT_THREADS } from "./thread-groups";

/**
 * How tall the rail's recent-sessions block was the last time it was drawn, kept so the next cold
 * load can hold the same room while the sessions are fetched.
 *
 * The Account group is pinned under the job modes (`.rail-pinned`), so whatever grows above it moves
 * it. The session rows come from `GET /api/v1/threads`, a round trip after the first frame, and on a
 * desk with sessions `settings-link` slid down by every row that arrived. The block now draws a quiet
 * placeholder row for each one it drew last time and the real rows take their places. Nothing to go
 * on (a brand-new browser, or storage that was cleared) draws no placeholders, which is right for a
 * fresh desk and costs a returning one a single shift, once.
 *
 * A hint, never truth: only the host's list is ever acted on. Pure on purpose, like
 * `lib/shell-modes.ts`; the component owns the state.
 */
export type RailRecentShape = {
  /** Session rows the block showed, at most `RAIL_RECENT_THREADS`. */
  readonly rows: number;
  /** Whether the See all sessions row followed them. */
  readonly more: boolean;
};

/** localStorage key. One per browser: it holds a row count and a flag, nothing a person wrote. */
export const RAIL_RECENT_SHAPE_KEY = "agentforge-rail-recent";

export const EMPTY_RECENT_SHAPE: RailRecentShape = Object.freeze({ rows: 0, more: false });

/** The shape of a list of `count` sessions as the collapsed rail draws it. */
export function shapeOfThreads(count: number): RailRecentShape {
  if (!Number.isFinite(count) || count <= 0) {
    return EMPTY_RECENT_SHAPE;
  }
  const whole = Math.floor(count);
  return { rows: Math.min(whole, RAIL_RECENT_THREADS), more: whole > RAIL_RECENT_THREADS };
}

export function serializeRecentShape(shape: RailRecentShape): string {
  return JSON.stringify({ rows: shape.rows, more: shape.more });
}

/** A stored value → the shape it names, or null when this rail did not write it. */
export function parseRecentShape(raw: string | null | undefined): RailRecentShape | null {
  if (typeof raw !== "string" || raw === "") {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const { rows, more } = value as { rows?: unknown; more?: unknown };
  if (typeof rows !== "number" || !Number.isInteger(rows) || rows < 0 || rows > RAIL_RECENT_THREADS) {
    return null;
  }
  if (typeof more !== "boolean") {
    return null;
  }
  return { rows, more };
}

/** What the last load drew. A blocked or absent store, or an unreadable value, reads as nothing. */
export function readRecentShape(store: ShellModesStore | undefined): RailRecentShape {
  if (!store) {
    return EMPTY_RECENT_SHAPE;
  }
  try {
    return parseRecentShape(store.getItem(RAIL_RECENT_SHAPE_KEY)) ?? EMPTY_RECENT_SHAPE;
  } catch {
    return EMPTY_RECENT_SHAPE;
  }
}

/**
 * Remember what was just drawn. Skipped when the stored value is already this one (the list reloads
 * on every thread change), and best effort: a full or blocked store costs the next first frame its
 * placeholders and nothing else.
 */
export function writeRecentShape(store: ShellModesStore | undefined, shape: RailRecentShape): void {
  if (!store) {
    return;
  }
  const next = serializeRecentShape(shape);
  try {
    if (store.getItem(RAIL_RECENT_SHAPE_KEY) === next) {
      return;
    }
    store.setItem(RAIL_RECENT_SHAPE_KEY, next);
  } catch {
    // private mode or a full store
  }
}
