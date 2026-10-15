import { useCallback, useEffect, useState } from "react";

export const AGENT_RAIL_STATE_KEY = "agentforge-agent-rail";
export const RAIL_PHONE_MAX_WIDTH = 480;
export const RAIL_PHONE_QUERY = `(max-width: ${RAIL_PHONE_MAX_WIDTH}px)`;

const COLLAPSED = "collapsed";
const EXPANDED = "expanded";

export type RailStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): RailStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readStoredRailCollapsed(storage: RailStorage | null = browserStorage()): boolean | null {
  if (!storage) {
    return null;
  }
  try {
    const value = storage.getItem(AGENT_RAIL_STATE_KEY);
    if (value === COLLAPSED) {
      return true;
    }
    return value === EXPANDED ? false : null;
  } catch {
    return null;
  }
}

export function writeStoredRailCollapsed(collapsed: boolean, storage: RailStorage | null = browserStorage()): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(AGENT_RAIL_STATE_KEY, collapsed ? COLLAPSED : EXPANDED);
  } catch {
    return;
  }
}

export function useRailCollapse(fallback: boolean): { collapsed: boolean; toggle: () => void } {
  const [stored, setStored] = useState<boolean | null>(() => readStoredRailCollapsed());
  const collapsed = stored ?? fallback;
  const toggle = useCallback(() => {
    const next = !collapsed;
    setStored(next);
    writeStoredRailCollapsed(next);
  }, [collapsed]);
  return { collapsed, toggle };
}

export function matchesQuery(query: string): boolean {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

export function useMatchMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => matchesQuery(query));
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function useRailDrawer(
  active: boolean,
  routeKey: string,
): { open: boolean; toggle: () => void; close: () => void } {
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = active && openAt === routeKey;
  const toggle = useCallback(() => setOpenAt(open ? null : routeKey), [open, routeKey]);
  const close = useCallback(() => setOpenAt(null), []);
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenAt(null);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);
  return { open, toggle, close };
}
